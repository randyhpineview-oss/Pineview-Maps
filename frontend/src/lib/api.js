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
  const { demoUser = 'worker', body, formData, headers = {}, timeoutMs = 20_000, ...rest } = options;

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
  const isGet = !rest.method || rest.method === 'GET';

  async function doFetch(retry = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        ...rest,
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (isGet && !retry && error.name !== 'AbortError') {
        // Transient blip (deploy restart, offline, etc.) — retry once after 1 s
        await new Promise((r) => setTimeout(r, 1000));
        return doFetch(true);
      }
      console.error('[API] Fetch error:', error);
      throw new Error(`Network error: ${error.message}`);
    }
    clearTimeout(timer);
    return response;
  }

  let response = await doFetch();

  if (!response.ok) {
    let message = 'Request failed';
    let detail = null;
    try {
      const payload = await response.json();
      detail = payload.detail;
      if (typeof detail === 'string') {
        message = detail;
      } else if (detail && typeof detail === 'object' && detail.reason) {
        // Structured 409 payload (e.g. has_linked_spray_records,
        // shared_tm_ticket_needs_rehome). Keep a human message for
        // fallback alerts and attach the raw object below.
        message = detail.reason;
      }
    } catch {
      message = response.statusText || message;
    }
    const err = new Error(`${response.status}: ${message}`);
    err.status = response.status;
    // Surface the structured detail so callers (e.g. the approval modal)
    // can render pickers / conflict lists without re-parsing the message.
    err.detail = (detail && typeof detail === 'object') ? detail : null;
    throw err;
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
    return request(`/api/sites${query ? `?${query}` : ''}`, { demoUser }).then(data => {
      const sample = data.slice(0, 2).map(s => ({ 
        id: s.id, 
        last_inspected_by_user_id: s.last_inspected_by_user_id,
        last_inspected_by_user: s.last_inspected_by_user ? {
          name: s.last_inspected_by_user.name,
          email: s.last_inspected_by_user.email
        } : null,
        last_inspected_at: s.last_inspected_at
      }));
      console.log('[API] listSites response sample:', sample);
      console.log('[API] Full first site data:', data[0]);
      return data;
    });
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
  getSite(siteId) {
    return request(`/api/sites/${siteId}`);
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
  deleteSitePermanent(siteId) {
    return request(`/api/sites/${siteId}/permanent`, { method: 'DELETE' });
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

  // ── Pipelines ──
  listPipelines(filters) {
    const searchParams = new URLSearchParams();
    if (filters?.client) searchParams.set('client', filters.client);
    if (filters?.area) searchParams.set('area', filters.area);
    const query = searchParams.toString();
    return request(`/api/pipelines${query ? `?${query}` : ''}`);
  },
  listPendingPipelines() {
    return request('/api/pending-pipelines');
  },
  getPipeline(pipelineId) {
    return request(`/api/pipelines/${pipelineId}`);
  },
  createPipeline(payload) {
    return request('/api/pipelines', { method: 'POST', body: payload });
  },
  updatePipeline(pipelineId, payload) {
    return request(`/api/pipelines/${pipelineId}`, { method: 'PATCH', body: payload });
  },
  deletePipeline(pipelineId) {
    return request(`/api/pipelines/${pipelineId}`, { method: 'DELETE' });
  },
  listDeletedPipelines() {
    return request('/api/deleted-pipelines');
  },
  restorePipeline(pipelineId) {
    return request(`/api/pipelines/${pipelineId}/restore`, { method: 'POST' });
  },
  deletePipelinePermanent(pipelineId) {
    return request(`/api/pipelines/${pipelineId}/permanent`, { method: 'DELETE' });
  },
  approvePipeline(pipelineId, payload) {
    return request(`/api/pipelines/${pipelineId}/approval`, { method: 'POST', body: payload });
  },
  importPipelineKml(file) {
    const formData = new FormData();
    formData.append('file', file);
    return request('/api/pipelines/import', { method: 'POST', formData });
  },
  createSprayRecord(pipelineId, payload) {
    return request(`/api/pipelines/${pipelineId}/spray`, { method: 'POST', body: payload });
  },
  listSprayRecords(pipelineId, sprayDate) {
    const params = sprayDate ? `?spray_date=${sprayDate}` : '';
    return request(`/api/pipelines/${pipelineId}/spray${params}`);
  },
  deleteSprayRecord(recordId) {
    return request(`/api/spray-records/${recordId}`, { method: 'DELETE' });
  },
  createSiteSprayRecord(siteId, payload) {
    return request(`/api/sites/${siteId}/spray`, { method: 'POST', body: payload });
  },
  listSiteSprayRecords(siteId) {
    return request(`/api/sites/${siteId}/spray`);
  },
  deleteSiteSprayRecord(recordId) {
    return request(`/api/site-spray-records/${recordId}`, { method: 'DELETE' });
  },
  updateSiteSprayRecord(recordId, payload) {
    return request(`/api/site-spray-records/${recordId}`, { method: 'PATCH', body: payload });
  },
  restoreSiteSprayRecord(recordId) {
    return request(`/api/site-spray-records/${recordId}/restore`, { method: 'POST' });
  },
  deleteSiteSprayRecordPermanent(recordId) {
    return request(`/api/site-spray-records/${recordId}/permanent`, { method: 'DELETE' });
  },
  restoreSprayRecord(recordId) {
    return request(`/api/spray-records/${recordId}/restore`, { method: 'POST' });
  },
  deleteSprayRecordPermanent(recordId) {
    return request(`/api/spray-records/${recordId}/permanent`, { method: 'DELETE' });
  },
  // Full spray record including lease_sheet_data (used by the edit flow).
  // List endpoints return a slimmer summary without lease_sheet_data to keep egress tiny.
  getSiteSprayRecord(recordId) {
    return request(`/api/site-spray-records/${recordId}`);
  },
  listRecentSubmissions(search) {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    return request(`/api/recent-submissions${params}`);
  },

  // ── Delta-sync endpoints (bandwidth-efficient polling) ──
  //
  // Each returns { items, [ids_removed], server_time }. Pass the previous
  // `server_time` back as `?since=` to fetch only what changed since then.
  // On first load / error, callers should fall back to the full list endpoint.
  sitesDelta(since) {
    return request(`/api/sites/delta?since=${encodeURIComponent(since)}`);
  },
  pipelinesDelta(since) {
    return request(`/api/pipelines/delta?since=${encodeURIComponent(since)}`);
  },
  recentSubmissionsDelta(since) {
    return request(`/api/recent-submissions/delta?since=${encodeURIComponent(since)}`);
  },
  // T&M tickets delta. Returns a plain array — callers should pair it with
  // the `tm_tickets_last_updated` watermark from /api/sync-status to decide
  // when to poll. Empty array means "nothing changed since `since`".
  tmTicketsDelta(since) {
    return request(`/api/time-materials/delta?since=${encodeURIComponent(since)}`);
  },

  /**
   * Fetch a Dropbox-hosted PDF through the backend proxy and return its raw bytes.
   *
   * Uses /api/pdf-proxy (server-side fetch) to sidestep browser-CORS issues with
   * Dropbox shared links. Returns a Uint8Array that can be passed directly to
   * pdfjs (via PdfPreviewViewer's pdfBytes prop).
   *
   * @param {string} pdfUrl        Dropbox shared-link URL (or any direct URL).
   * @param {AbortSignal} [signal] Optional AbortSignal to cancel the fetch.
   * @returns {Promise<Uint8Array>}
   */
  async fetchPdfBytes(pdfUrl, signal) {
    if (!pdfUrl) throw new Error('No pdf_url on this record.');
    const headers = {};
    if (USE_SUPABASE_AUTH) {
      const token = localStorage.getItem('supabase-access-token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } else {
      headers['X-Demo-User'] = 'worker';
    }
    const url = `${API_BASE_URL}/api/pdf-proxy?url=${encodeURIComponent(pdfUrl)}`;
    const resp = await fetch(url, { headers, signal });
    if (!resp.ok) {
      let message = `PDF proxy failed (${resp.status})`;
      try {
        const body = await resp.json();
        if (body?.detail) message += `: ${body.detail}`;
      } catch { /* non-json body */ }
      throw new Error(message);
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  },

  /**
   * Fetch a Dropbox-hosted image through the backend proxy and return base64 data.
   *
   * Uses /api/proxy-photo (server-side fetch) to sidestep browser-CORS issues with
   * Dropbox shared links. Returns { data: base64_string, type: mime_type }.
   *
   * @param {string} imageUrl      Dropbox shared-link URL (or any direct image URL).
   * @returns {Promise<{ data: string, type: string }>}
   */
  async proxyPhoto(imageUrl) {
    if (!imageUrl) throw new Error('No image URL provided.');
    return request('/api/proxy-photo', { method: 'POST', body: { url: imageUrl } });
  },
  bulkResetPipelines(payload) {
    return request('/api/admin/pipelines/bulk-reset', { method: 'POST', body: payload });
  },

  // ── Sync status (bandwidth-efficient polling) ──
  getSyncStatus() {
    return request('/api/sync-status');
  },

  // ── Ticket number ──
  getNextTicket() {
    return request('/api/next-ticket');
  },

  // ── Lookup tables (herbicides, applicators, noxious weeds, location types) ──
  listHerbicides() {
    return request('/api/lookups/herbicides');
  },
  createHerbicide(payload) {
    return request('/api/lookups/herbicides', { method: 'POST', body: payload });
  },
  updateHerbicide(id, payload) {
    return request(`/api/lookups/herbicides/${id}`, { method: 'PATCH', body: payload });
  },
  deleteHerbicide(id) {
    return request(`/api/lookups/herbicides/${id}`, { method: 'DELETE' });
  },
  listApplicators() {
    return request('/api/lookups/applicators');
  },
  createApplicator(payload) {
    return request('/api/lookups/applicators', { method: 'POST', body: payload });
  },
  updateApplicator(id, payload) {
    return request(`/api/lookups/applicators/${id}`, { method: 'PATCH', body: payload });
  },
  deleteApplicator(id) {
    return request(`/api/lookups/applicators/${id}`, { method: 'DELETE' });
  },
  listNoxiousWeeds() {
    return request('/api/lookups/noxious-weeds');
  },
  createNoxiousWeed(payload) {
    return request('/api/lookups/noxious-weeds', { method: 'POST', body: payload });
  },
  updateNoxiousWeed(id, payload) {
    return request(`/api/lookups/noxious-weeds/${id}`, { method: 'PATCH', body: payload });
  },
  deleteNoxiousWeed(id) {
    return request(`/api/lookups/noxious-weeds/${id}`, { method: 'DELETE' });
  },
  listLocationTypes() {
    return request('/api/lookups/location-types');
  },
  createLocationType(payload) {
    return request('/api/lookups/location-types', { method: 'POST', body: payload });
  },
  updateLocationType(id, payload) {
    return request(`/api/lookups/location-types/${id}`, { method: 'PATCH', body: payload });
  },
  deleteLocationType(id) {
    return request(`/api/lookups/location-types/${id}`, { method: 'DELETE' });
  },

  // ── Time & Materials tickets ──
  listOpenTMTickets(filters) {
    const params = new URLSearchParams();
    if (filters?.client) params.set('client', filters.client);
    if (filters?.area) params.set('area', filters.area);
    if (filters?.spray_date) params.set('spray_date', filters.spray_date);
    const query = params.toString();
    return request(`/api/time-materials/open${query ? `?${query}` : ''}`);
  },
  listTMTickets(filters) {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.spray_date) params.set('spray_date', filters.spray_date);
    const query = params.toString();
    return request(`/api/time-materials${query ? `?${query}` : ''}`);
  },
  getTMTicket(ticketId) {
    return request(`/api/time-materials/${ticketId}`);
  },
  createTMTicket(payload) {
    return request('/api/time-materials', { method: 'POST', body: payload });
  },
  updateTMTicket(ticketId, payload) {
    return request(`/api/time-materials/${ticketId}`, { method: 'PATCH', body: payload });
  },
  deleteTMTicket(ticketId) {
    return request(`/api/time-materials/${ticketId}`, { method: 'DELETE' });
  },
  restoreTMTicket(ticketId) {
    return request(`/api/time-materials/${ticketId}/restore`, { method: 'POST' });
  },
  deleteTMTicketPermanent(ticketId) {
    return request(`/api/time-materials/${ticketId}/permanent`, { method: 'DELETE' });
  },

  // ── Password reset (6-digit code flow) ──
  requestResetCode(email) {
    return request('/api/auth/forgot-password', { method: 'POST', body: { email } });
  },
  verifyResetCode(email, code) {
    return request('/api/auth/verify-reset-code', { method: 'POST', body: { email, code } });
  },
  resetPasswordWithToken(resetToken, newPassword) {
    return request('/api/auth/reset-password', { method: 'POST', body: { reset_token: resetToken, new_password: newPassword } });
  },

  // ── Worker self-signup (QR-gated) ──
  // Public endpoint: no auth header needed, but our request() still attaches
  // whatever token is in localStorage. That's fine — the backend ignores
  // Authorization for this route.
  signupWithInvite(payload) {
    return request('/api/auth/signup', { method: 'POST', body: payload });
  },
  // Admin-only: returns { url, configured } for the Worker Signup QR card.
  getSignupInviteUrl() {
    return request('/api/admin/signup-invite-url');
  },
};