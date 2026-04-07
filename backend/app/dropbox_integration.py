import os
import dropbox
from datetime import datetime
from typing import Optional, List

DROPBOX_ACCESS_TOKEN = os.getenv("DROPBOX_ACCESS_TOKEN")

def get_dropbox_client():
    """Get an authenticated Dropbox client."""
    if not DROPBOX_ACCESS_TOKEN:
        raise ValueError("Dropbox access token not configured")
    return dropbox.Dropbox(DROPBOX_ACCESS_TOKEN)

def upload_pdf_to_dropbox(pdf_content: bytes, filename: str, folder: str = "/lease_sheets") -> Optional[str]:
    """
    Upload a PDF to Dropbox and return the shared link.
    
    Args:
        pdf_content: PDF file content as bytes
        filename: Name for the file
        folder: Dropbox folder path (default: /lease_sheets)
    
    Returns:
        Shared URL for the uploaded file or None if upload fails
    """
    try:
        dbx = get_dropbox_client()
        
        # Ensure folder exists
        try:
            dbx.files_create_folder_v2(folder)
        except dropbox.exceptions.ApiError as e:
            if not isinstance(e.error, dropbox.files.CreateFolderError):
                raise
        
        # Upload file
        file_path = f"{folder}/{filename}"
        dbx.files_upload(
            pdf_content,
            file_path,
            mode=dropbox.files.WriteMode.overwrite
        )
        
        # Create shared link
        shared_link = dbx.sharing_create_shared_link_with_settings(file_path)
        return shared_link.url
        
    except Exception as e:
        print(f"Error uploading to Dropbox: {e}")
        return None

def upload_photo_to_dropbox(photo_content: bytes, filename: str, folder: str = "/lease_sheet_photos") -> Optional[str]:
    """
    Upload a photo to Dropbox and return the shared link.
    
    Args:
        photo_content: Photo file content as bytes
        filename: Name for the file
        folder: Dropbox folder path (default: /lease_sheet_photos)
    
    Returns:
        Shared URL for the uploaded file or None if upload fails
    """
    try:
        dbx = get_dropbox_client()
        
        # Ensure folder exists
        try:
            dbx.files_create_folder_v2(folder)
        except dropbox.exceptions.ApiError as e:
            if not isinstance(e.error, dropbox.files.CreateFolderError):
                raise
        
        # Upload file
        file_path = f"{folder}/{filename}"
        dbx.files_upload(
            photo_content,
            file_path,
            mode=dropbox.files.WriteMode.overwrite
        )
        
        # Create shared link
        shared_link = dbx.sharing_create_shared_link_with_settings(file_path)
        return shared_link.url
        
    except Exception as e:
        print(f"Error uploading photo to Dropbox: {e}")
        return None

def generate_filename(prefix: str, extension: str, ticket_number: str = None) -> str:
    """Generate a unique filename with timestamp and optional ticket number."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if ticket_number:
        return f"{prefix}_{ticket_number}_{timestamp}.{extension}"
    return f"{prefix}_{timestamp}.{extension}"
