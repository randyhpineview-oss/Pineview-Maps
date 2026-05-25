import os
import re
import dropbox
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional, List, Tuple

from app.log_util import get_logger

logger = get_logger(__name__)


def get_dropbox_client():
    """
    Get an authenticated Dropbox client.
    Supports two modes:
    1. Refresh token flow (recommended): DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET
    2. Short-lived access token (legacy): DROPBOX_ACCESS_TOKEN
    """
    refresh_token = os.getenv("DROPBOX_REFRESH_TOKEN")
    app_key = os.getenv("DROPBOX_APP_KEY")
    app_secret = os.getenv("DROPBOX_APP_SECRET")

    if refresh_token and app_key and app_secret:
        logger.debug("Using Dropbox refresh token flow")
        return dropbox.Dropbox(
            oauth2_refresh_token=refresh_token,
            app_key=app_key,
            app_secret=app_secret,
        )

    # Fallback to short-lived access token
    token = os.getenv("DROPBOX_ACCESS_TOKEN")
    if token:
        logger.debug("Using Dropbox short-lived access token")
        return dropbox.Dropbox(token)

    logger.error("No Dropbox credentials configured")
    raise ValueError("Dropbox credentials not configured. Set DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET, or DROPBOX_ACCESS_TOKEN.")

def _safe_name(name: str) -> str:
    """Sanitize a string for use in a Dropbox path."""
    return re.sub(r'[<>:"/\\|?*]', '_', (name or 'Unknown').strip()) or 'Unknown'

def _ensure_folder(dbx, folder: str):
    """Create folder if it doesn't exist."""
    try:
        dbx.files_create_folder_v2(folder)
    except dropbox.exceptions.ApiError:
        pass  # folder already exists or parent path issue — either way continue

def build_pdf_path(date_str: str, client: str, area: str, ticket: str, lsd_or_pipeline: str) -> str:
    """
    Build Dropbox path:
    /{YYYY} Spray Records/{YYYY-MM-DD}/Herbicide Lease Sheet/{Client}/{Area}/{Ticket}_{LSD}.pdf
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
    except (ValueError, TypeError):
        dt = datetime.utcnow()
    year = dt.strftime('%Y')
    date_folder = dt.strftime('%Y-%m-%d')
    return (
        f"/{year} Spray Records/{date_folder}/Herbicide Lease Sheet"
        f"/{_safe_name(client)}/{_safe_name(area)}"
        f"/{_safe_name(ticket)}_{_safe_name(lsd_or_pipeline)}.pdf"
    )

def build_tm_path(date_str: str, client: str, area: str, ticket: str) -> str:
    """
    Build Dropbox path for a Time & Materials ticket:
    /{YYYY} Spray Records/{YYYY-MM-DD}/Time And Materials/{Client}/{Area}/{Ticket}.pdf
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
    except (ValueError, TypeError):
        dt = datetime.utcnow()
    year = dt.strftime('%Y')
    date_folder = dt.strftime('%Y-%m-%d')
    return (
        f"/{year} Spray Records/{date_folder}/Time And Materials"
        f"/{_safe_name(client)}/{_safe_name(area)}"
        f"/{_safe_name(ticket)}.pdf"
    )


def build_hydroseed_daily_path(date_str: str, client: str, area: str, record: str, site_name: str = "") -> str:
    """
    /{YYYY} Hydroseed Records/{YYYY-MM-DD}/Hydroseed Daily/{Client}/{Area}/{Record}_{SiteName}.pdf

    Hydroseed lives in its own top-level year folder (separate from the
    `{YYYY} Spray Records/` tree used for herbicide lease sheets + T&M
    tickets) so the office can find a year's worth of hydroseed paperwork
    without scrolling past spray work.
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
    except (ValueError, TypeError):
        dt = datetime.utcnow()
    year = dt.strftime('%Y')
    date_folder = dt.strftime('%Y-%m-%d')
    name_suffix = f"_{_safe_name(site_name)}" if site_name else ""
    return (
        f"/{year} Hydroseed Records/{date_folder}/Hydroseed Daily"
        f"/{_safe_name(client)}/{_safe_name(area)}"
        f"/{_safe_name(record)}{name_suffix}.pdf"
    )


def build_hydroseed_ticket_path(date_str: str, client: str, area: str, ticket: str) -> str:
    """
    /{YYYY} Hydroseed Records/{YYYY-MM-DD}/Hydroseed Ticket/{Client}/{Area}/{Ticket}.pdf

    Same `{YYYY} Hydroseed Records/` root as the daily path above so a
    completed HT lands next to the dailies that rolled into it.
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
    except (ValueError, TypeError):
        dt = datetime.utcnow()
    year = dt.strftime('%Y')
    date_folder = dt.strftime('%Y-%m-%d')
    return (
        f"/{year} Hydroseed Records/{date_folder}/Hydroseed Ticket"
        f"/{_safe_name(client)}/{_safe_name(area)}"
        f"/{_safe_name(ticket)}.pdf"
    )


def build_photo_path(ticket: str, index: int) -> str:
    """
    Build Dropbox path:
    /Pineview Maps/Form Photos/{Ticket}_{timestamp}_{index}.jpg
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"/Pineview Maps/Form Photos/{_safe_name(ticket)}_{timestamp}_{index}.jpg"

def _get_or_create_shared_link(dbx, file_path: str) -> Optional[str]:
    """Try to create a shared link, or retrieve existing one. Returns URL or None."""
    # Attempt 1: create a new shared link
    try:
        shared_link = dbx.sharing_create_shared_link_with_settings(file_path)
        logger.debug("Shared link created")
        return shared_link.url
    except dropbox.exceptions.ApiError as link_err:
        logger.debug("sharing_create_shared_link_with_settings error: %s", type(link_err).__name__)
        # If shared link already exists (re-upload), retrieve the existing one
        if hasattr(link_err, 'error') and hasattr(link_err.error, 'is_shared_link_already_exists'):
            try:
                if link_err.error.is_shared_link_already_exists():
                    meta_wrapper = link_err.error.get_shared_link_already_exists()
                    # Extract the FileLinkMetadata from the wrapper. The SDK
                    # exposes this differently across versions:
                    #   - .get_metadata() method (tagged union accessor)
                    #   - .metadata property (direct attribute)
                    #   - .metadata() callable (some SDK builds)
                    meta = None
                    if hasattr(meta_wrapper, 'get_metadata'):
                        meta = meta_wrapper.get_metadata()
                    elif hasattr(meta_wrapper, 'metadata'):
                        m = meta_wrapper.metadata
                        meta = m() if callable(m) else m
                    if meta and hasattr(meta, 'url'):
                        logger.debug("Using existing shared link")
                        return meta.url
            except Exception as inner_err:
                logger.warning("Error extracting existing link: %s", type(inner_err).__name__)
    except Exception as e:
        logger.warning("Unexpected error creating shared link: %s", type(e).__name__)

    # Attempt 2: list existing shared links for the path
    try:
        links = dbx.sharing_list_shared_links(path=file_path, direct_only=True)
        if links.links:
            logger.debug("Found existing shared link")
            return links.links[0].url
    except Exception as e:
        logger.warning("sharing_list_shared_links error: %s", type(e).__name__)

    # Attempt 3: get a temporary link (no sharing.write scope needed)
    try:
        temp_link = dbx.files_get_temporary_link(file_path)
        logger.debug("Using temporary link (4hr expiry)")
        return temp_link.link
    except Exception as e:
        logger.warning("files_get_temporary_link error: %s", type(e).__name__)

    logger.error("All link methods failed for file upload")
    return None


def _upload_one_file(
    content: bytes,
    file_path: str,
    *,
    skip_ensure_folder: bool = False,
    label: str = "file",
) -> Optional[str]:
    """Internal: upload a single file (PDF or photo) and return the shared link.

    `skip_ensure_folder=True` skips the per-file `files_create_folder_v2`
    round-trip — caller must have already created the parent folder
    (`upload_files_parallel` does this once for the whole batch).
    """
    try:
        logger.debug("Uploading %s %s (%d bytes)", label, file_path, len(content))
        dbx = get_dropbox_client()
        if not skip_ensure_folder:
            folder = '/'.join(file_path.split('/')[:-1])
            _ensure_folder(dbx, folder)

        dbx.files_upload(content, file_path, mode=dropbox.files.WriteMode.overwrite)
        logger.debug("%s uploaded successfully, creating shared link", label.capitalize())
        return _get_or_create_shared_link(dbx, file_path)
    except Exception as e:
        logger.exception("Error uploading %s: %s", label, type(e).__name__)
        return None


def upload_pdf_to_dropbox(pdf_content: bytes, file_path: str) -> Optional[str]:
    """Upload a PDF to Dropbox at the given path and return the shared link."""
    return _upload_one_file(pdf_content, file_path, label="PDF")


def build_draft_photo_path(user_id: str, draft_id: str, index: int) -> str:
    """Path for a draft photo backup:
    /Pineview Maps/Drafts/{user_id}/{draft_id}/{index}.jpg
    """
    return f"/Pineview Maps/Drafts/{_safe_name(user_id)}/{_safe_name(draft_id)}/{int(index)}.jpg"


def delete_dropbox_path(file_path: str) -> bool:
    """Best-effort delete of a Dropbox file or folder. Returns True on success."""
    try:
        dbx = get_dropbox_client()
        dbx.files_delete_v2(file_path)
        return True
    except Exception as e:
        logger.warning("delete_dropbox_path failed for %s: %s", file_path, type(e).__name__)
        return False


def upload_photo_to_dropbox(photo_content: bytes, file_path: str) -> Optional[str]:
    """Upload a photo to Dropbox at the given path and return the shared link."""
    return _upload_one_file(photo_content, file_path, label="photo")


def upload_files_parallel(
    jobs: List[Tuple[bytes, str]],
    *,
    max_workers: int = 5,
) -> List[Optional[str]]:
    """Upload (content, file_path) tuples to Dropbox concurrently.

    Used to fan out a single record's PDF + photos so a 10-photo lease
    sheet doesn't sit in an 11-deep serial Dropbox queue (~15 s on the
    backend even when the worker's network is fast). Each thread spins
    up its own `dropbox.Dropbox` client via `get_dropbox_client()` so
    we don't share an HTTP session across threads.

    Performance notes:
      • `max_workers=5` is a deliberate ceiling — Dropbox's per-app
        rate-limit kicks in around 12 concurrent calls, and the
        diminishing-returns curve flattens after ~5 anyway because
        `_get_or_create_shared_link` does its own internal round-trips.
      • Unique parent folders are pre-created ONCE (sequentially, on
        a single client) before the fan-out, so we don't waste N-1
        redundant `files_create_folder_v2` calls when many photos share
        a folder. Per-worker uploads then pass `skip_ensure_folder=True`.

    Returns a list of shared-link URLs in the same order as `jobs`;
    individual entries are `None` if that file's upload failed.
    """
    if not jobs:
        return []

    # Pre-create unique parent folders on a single client. _ensure_folder
    # swallows "already exists", so this is idempotent and cheap.
    folders_ok = False
    unique_folders = sorted({'/'.join(p.split('/')[:-1]) for _, p in jobs if '/' in p})
    if unique_folders:
        try:
            dbx = get_dropbox_client()
            for folder in unique_folders:
                _ensure_folder(dbx, folder)
            folders_ok = True
        except Exception as e:
            # Fall back to per-file ensure inside each worker — slower but
            # still correct. Don't bail on the whole batch.
            logger.warning(
                "Folder pre-create failed (falling back to per-file ensure): %s",
                type(e).__name__,
            )

    workers = max(1, min(max_workers, len(jobs)))
    results: List[Optional[str]] = [None] * len(jobs)

    def _do(task: Tuple[int, bytes, str]) -> None:
        idx, content, path = task
        results[idx] = _upload_one_file(
            content, path, skip_ensure_folder=folders_ok, label="file",
        )

    with ThreadPoolExecutor(max_workers=workers) as ex:
        # `list(...)` forces the iterator so exceptions in workers
        # surface here instead of being silently swallowed; individual
        # upload errors are already caught inside `_upload_one_file`.
        list(ex.map(_do, [(i, c, p) for i, (c, p) in enumerate(jobs)]))

    return results
