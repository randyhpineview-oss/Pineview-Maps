import os
import re
import dropbox
from datetime import datetime
from typing import Optional, List

def get_dropbox_client():
    """Get an authenticated Dropbox client."""
    token = os.getenv("DROPBOX_ACCESS_TOKEN")
    if not token:
        print("[DROPBOX] DROPBOX_ACCESS_TOKEN not set in environment")
        raise ValueError("Dropbox access token not configured")
    print(f"[DROPBOX] Using token starting with: {token[:8]}...")
    return dropbox.Dropbox(token)

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

def build_photo_path(ticket: str, index: int) -> str:
    """
    Build Dropbox path:
    /Pineview Maps/Form Photos/{Ticket}_{timestamp}_{index}.jpg
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"/Pineview Maps/Form Photos/{_safe_name(ticket)}_{timestamp}_{index}.jpg"

def upload_pdf_to_dropbox(pdf_content: bytes, file_path: str) -> Optional[str]:
    """Upload a PDF to Dropbox at the given path and return the shared link."""
    try:
        print(f"[DROPBOX] Uploading PDF ({len(pdf_content)} bytes) to: {file_path}")
        dbx = get_dropbox_client()
        folder = '/'.join(file_path.split('/')[:-1])
        _ensure_folder(dbx, folder)
        
        dbx.files_upload(pdf_content, file_path, mode=dropbox.files.WriteMode.overwrite)
        print(f"[DROPBOX] PDF uploaded successfully, creating shared link...")
        shared_link = dbx.sharing_create_shared_link_with_settings(file_path)
        print(f"[DROPBOX] Shared link created: {shared_link.url}")
        return shared_link.url
    except Exception as e:
        print(f"[DROPBOX] Error uploading PDF: {type(e).__name__}: {e}")
        return None

def upload_photo_to_dropbox(photo_content: bytes, file_path: str) -> Optional[str]:
    """Upload a photo to Dropbox at the given path and return the shared link."""
    try:
        print(f"[DROPBOX] Uploading photo ({len(photo_content)} bytes) to: {file_path}")
        dbx = get_dropbox_client()
        folder = '/'.join(file_path.split('/')[:-1])
        _ensure_folder(dbx, folder)
        
        dbx.files_upload(photo_content, file_path, mode=dropbox.files.WriteMode.overwrite)
        shared_link = dbx.sharing_create_shared_link_with_settings(file_path)
        print(f"[DROPBOX] Photo shared link: {shared_link.url}")
        return shared_link.url
    except Exception as e:
        print(f"[DROPBOX] Error uploading photo: {type(e).__name__}: {e}")
        return None
