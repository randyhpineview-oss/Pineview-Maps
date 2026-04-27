// XHR-based POST/PATCH helper that reports live upload-byte progress via
// the `onProgress(fraction)` callback (fraction is 0..1). Used by the
// upload queue so the worker sees per-file progress (e.g. 20%, 40%, 60%,
// 80%, 100%) for a single record's payload.
//
// Why a separate file from api.js: `fetch()` still doesn't expose
// upload-progress events as of 2024, so this stays on XMLHttpRequest.
// Keeping it isolated makes the api.js fetch path easy to read and
// avoids ballooning that module with a one-off code path.
//
// Notes:
//   - No internal retry: the upload queue already retries failed items
//     on the next poll cycle, so a single failure here just throws and
//     the item stays in IDB for retry.
//   - `onProgress(1)` fires once the request body has been fully sent;
//     after that the server is doing PDF generation + Dropbox upload
//     which we have no visibility into. Callers that want to avoid a
//     "stuck at 100%" feel during server work should cap the displayed
//     fraction to ~0.95 until the promise actually resolves.

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const USE_SUPABASE_AUTH = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

export function requestWithUploadProgress(path, opts) {
  const o = opts || {};
  const method = o.method || 'POST';
  const body = o.body;
  const onProgress = o.onProgress;
  const demoUser = o.demoUser || 'worker';

  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    const url = API_BASE_URL + path;
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', 'application/json');

    if (USE_SUPABASE_AUTH) {
      const token = localStorage.getItem('supabase-access-token');
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    } else {
      xhr.setRequestHeader('X-Demo-User', demoUser);
    }

    if (onProgress && xhr.upload) {
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable && e.total > 0) {
          try { onProgress(e.loaded / e.total); } catch (_) { /* swallow */ }
        }
      });
    }

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (xhr.status === 204) { resolve(null); return; }
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : null);
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + e.message));
        }
        return;
      }
      let message = xhr.status + ': ' + (xhr.statusText || 'Request failed');
      let detail = null;
      try {
        const parsed = JSON.parse(xhr.responseText);
        detail = parsed.detail;
        if (typeof detail === 'string') {
          message = xhr.status + ': ' + detail;
        } else if (detail && typeof detail === 'object' && detail.reason) {
          message = xhr.status + ': ' + detail.reason;
        }
      } catch (_) { /* non-JSON body — keep statusText message */ }
      const err = new Error(message);
      err.status = xhr.status;
      err.detail = (detail && typeof detail === 'object') ? detail : null;
      reject(err);
    };

    xhr.onerror = function () { reject(new Error('Network error')); };
    xhr.onabort = function () { reject(new Error('Upload aborted')); };
    // No explicit timeout — uploads of multi-MB payloads on cellular
    // can legitimately take well over 60 s, and the queue retries
    // failures on the next poll cycle anyway.

    xhr.send(body !== undefined ? JSON.stringify(body) : null);
  });
}
