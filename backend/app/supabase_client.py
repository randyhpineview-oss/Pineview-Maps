"""
Supabase REST API client for production use.
This avoids direct PostgreSQL connections which have IPv6 issues on Render.
"""
import httpx
from typing import Any, Optional
from app.config import get_settings

settings = get_settings()


class SupabaseClient:
    def __init__(self):
        self.url = settings.supabase_url
        self.anon_key = settings.supabase_anon_key
        self.service_role_key = settings.supabase_service_role_key
        self.client = httpx.Client(
            base_url=f"{self.url}/rest/v1",
            headers={
                "apikey": self.anon_key,
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    def query(self, table: str, method: str = "GET", **kwargs) -> dict:
        """Execute a query against Supabase REST API"""
        try:
            if method == "GET":
                response = self.client.get(f"/{table}", params=kwargs)
            elif method == "POST":
                response = self.client.post(f"/{table}", json=kwargs)
            elif method == "PATCH":
                response = self.client.patch(f"/{table}", json=kwargs)
            elif method == "DELETE":
                response = self.client.delete(f"/{table}", params=kwargs)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            response.raise_for_status()
            return response.json() if response.content else {}
        except httpx.HTTPError as e:
            raise Exception(f"Supabase API error: {str(e)}")

    def close(self):
        self.client.close()


# Create a singleton instance
_supabase_client: Optional[SupabaseClient] = None


def get_supabase_client() -> SupabaseClient:
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = SupabaseClient()
    return _supabase_client
