import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Mirrored JWT for non-Supabase callers (api.js, xhrUpload, pdf fetch). */
export const ACCESS_TOKEN_STORAGE_KEY = 'supabase-access-token';

const getRedirectUrl = () => {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/`;
};

// Only create Supabase client if environment variables are present
export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        redirectTo: getRedirectUrl(),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

function writeAccessTokenMirror(token) {
  try {
    if (token) localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch { /* private mode / storage blocked */ }
}

function readAccessTokenMirror() {
  try {
    return localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Prefer the live Supabase session over the localStorage mirror. The mirror
 * can lag when a backgrounded tab misses TOKEN_REFRESHED (common on mobile
 * PWAs). Always re-sync the mirror when we have a fresh token.
 */
export async function getAccessToken() {
  if (supabase) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        writeAccessTokenMirror(session.access_token);
        return session.access_token;
      }
    } catch { /* fall through to mirror */ }
  }
  return readAccessTokenMirror();
}

// Single-flight refresh so parallel 401 retries (ClientPortal loads three
// endpoints at once) don't race Supabase refresh-token rotation and
// accidentally SIGNED_OUT the user.
let refreshInFlight = null;

/**
 * Force a Supabase token refresh. Returns the new access token, or null if
 * refresh failed (refresh token expired/revoked — real auth failure).
 */
export async function refreshAccessToken() {
  if (!supabase) return null;
  if (!refreshInFlight) {
    refreshInFlight = supabase.auth.refreshSession()
      .then(({ data, error }) => {
        if (error || !data?.session?.access_token) return null;
        writeAccessTokenMirror(data.session.access_token);
        return data.session.access_token;
      })
      .catch(() => null)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/**
 * Ensure the access token is valid for at least `minTtlSec` seconds.
 * Used on tab wake so a client who left the portal open for hours gets a
 * silent refresh instead of a cascade of 401s / SIGNED_OUT.
 */
export async function ensureFreshSession({ minTtlSec = 120 } = {}) {
  if (!supabase) return getAccessToken();
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    const expiresAt = typeof session.expires_at === 'number' ? session.expires_at : 0;
    const now = Math.floor(Date.now() / 1000);
    if (!expiresAt || expiresAt - now < minTtlSec) {
      return refreshAccessToken();
    }
    writeAccessTokenMirror(session.access_token);
    return session.access_token;
  } catch {
    return refreshAccessToken();
  }
}

export async function signUpWithEmail(email, password) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        role: 'worker',
      },
    },
  });
  if (error) throw error;
  return data;
}

export async function signInWithEmail(email, password) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  if (!supabase) throw new Error('Supabase not configured');
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  return user;
}

export async function getSession() {
  if (!supabase) throw new Error('Supabase not configured');
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  return session;
}

export function onAuthStateChange(callback) {
  if (!supabase) return { data: { subscription: { unsubscribe: () => {} } } };
  return supabase.auth.onAuthStateChange(callback);
}
