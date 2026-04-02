const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/$/, '') || '';
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Check if we're using Supabase auth (production) or demo auth (development)
const USE_SUPABASE_AUTH = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

// Debug logging
if (typeof window !== 'undefined') {
  console.log('[API] Environment check:', {
    apiBaseUrl: API_BASE_URL || 'NOT SET',
    supabaseUrl: SUPABASE_URL ? 'SET' : 'NOT SET',
    supabaseAnonKey: SUPABASE_ANON_KEY ? 'SET' : 'NOT SET',
    useSupabaseAuth: USE_SUPABASE_AUTH,
    allEnvVars: Object.keys(import.meta.env).filter(k => k.startsWith('VITE_')).sort()
  });
}

async function request(path, options = {}) {
  const { demoUser = 'worker', body, formData, headers = {}, ...rest } = options;

  const requestHeaders = { ...headers };

  // If using Supabase, add Bearer token from localStorage
  if (USE_SUPABASE_AUTH) {
    const token = localStorage.getItem('supabase-access-token');
    if (token) {
      requestHeaders['Authorization'] = `Bearer ${token}`;
    } else {
      console.warn('[API] No Supabase token found in localStorage');
    }
  } else {
    // Development: use X-Demo-User header
    requestHeaders['X-Demo-User'] = demoUser;
  }

  let requestBody = undefined;
  if (formData) {
    requestBody = formData;
  } else if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const url = `${API_BASE_URL}${path}`;

  let response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: requestHeaders,
      body: requestBody,
    });
  } catch (error) {
    console.error('[API] Fetch error:', error);
    throw new Error(`Network error: ${error.message}`);
  }

  if (!response.ok) {
    let message = 'Request failed';
    try {
      const payload = await response.json();
      message = payload.detail || message;
    } catch {
      message = response.statusText || message;
    }
    throw new Error(`${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Unexpected response from the API. Check that the frontend can reach the backend.');
  }

  return response.json();
}

export const api = {
  getSession(demoUser) {
    return request('/api/session', { demoUser });
  },
  listSites(filters, demoUser) {
    const searchParams = new URLSearchParams();
    Object.entries(filters || {}).forEach(([key, value]) => {
      if (value) {
        searchParams.set(key, value);
      }
    });
    const query = searchParams.toString();
    return request(`/api/sites${query ? `?${query}` : ''}`, { demoUser });
  },
  listPendingSites(demoUser) {
    return request('/api/pending-sites', { demoUser });
  },
  createSite(payload, demoUser) {
    return request('/api/sites', { method: 'POST', body: payload, demoUser });
  },
  updateSite(siteId, payload, demoUser) {
    return request(`/api/sites/${siteId}`, { method: 'PATCH', body: payload, demoUser });
  },
  deleteSite(siteId, demoUser) {
    return request(`/api/sites/${siteId}`, { method: 'DELETE', demoUser });
  },
  updateSiteStatus(siteId, payload, demoUser) {
    return request(`/api/sites/${siteId}/status`, { method: 'PATCH', body: payload, demoUser });
  },
  requestTypeChange(siteId, payload, demoUser) {
    return request(`/api/sites/${siteId}/request-type-change`, { method: 'POST', body: payload, demoUser });
  },
  approveSite(siteId, payload, demoUser) {
    return request(`/api/sites/${siteId}/approval`, { method: 'POST', body: payload, demoUser });
  },
  bulkResetStatus(payload, demoUser) {
    return request('/api/admin/reset-status', { method: 'POST', body: payload, demoUser });
  },
  importKml(file, demoUser) {
    const formData = new FormData();
    formData.append('file', file);
    return request('/api/import/kml', { method: 'POST', formData, demoUser });
  },
  listDeletedSites(demoUser) {
    return request('/api/deleted-sites', { demoUser });
  },
  restoreSite(siteId, demoUser) {
    return request(`/api/sites/${siteId}/restore`, { method: 'POST', demoUser });
  },
  deleteSitePermanent(siteId, demoUser) {
    return request(`/api/sites/${siteId}/permanent`, { method: 'DELETE', demoUser });
  },
  quickEditSite(siteId, payload) {
    return request(`/api/sites/${siteId}/quick-edit`, { method: 'PATCH', body: payload });
  },

  // ── User management (admin only) ──
  listUsers() {
    return request('/api/admin/users');
  },
  createUser(payload) {
    return request('/api/admin/users', { method: 'POST', body: payload });
  },
  updateUser(userId, payload) {
    return request(`/api/admin/users/${userId}`, { method: 'PATCH', body: payload });
  },
  deleteUser(userId) {
    return request(`/api/admin/users/${userId}`, { method: 'DELETE' });
  },
};