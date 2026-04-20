import { openDB } from 'idb';

const DB_NAME = 'pineview-offline-db';
const DB_VERSION = 5;

function ensureCacheId(site) {
  return {
    ...site,
    cacheId: site.cacheId || String(site.id || site.tempId || crypto.randomUUID()),
  };
}

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('sites')) {
      db.createObjectStore('sites', { keyPath: 'cacheId' });
    }
    if (!db.objectStoreNames.contains('queue')) {
      db.createObjectStore('queue', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta', { keyPath: 'key' });
    }
    if (!db.objectStoreNames.contains('uploadQueue')) {
      db.createObjectStore('uploadQueue', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('recents')) {
      db.createObjectStore('recents', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('lookups')) {
      db.createObjectStore('lookups', { keyPath: 'key' });
    }
    if (!db.objectStoreNames.contains('users')) {
      db.createObjectStore('users', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('leaseSheetDrafts')) {
      db.createObjectStore('leaseSheetDrafts', { keyPath: 'id' });
    }
  },
});

export async function replaceSites(sites) {
  const db = await dbPromise;
  const tx = db.transaction('sites', 'readwrite');
  await tx.store.clear();
  for (const site of sites) {
    await tx.store.put(ensureCacheId(site));
  }
  await tx.done;
}

export async function getSites() {
  const db = await dbPromise;
  return db.getAll('sites');
}

export async function upsertSite(site) {
  const db = await dbPromise;
  await db.put('sites', ensureCacheId(site));
}

export async function removeSite(site) {
  const db = await dbPromise;
  const cacheId = site?.cacheId || String(site?.id || '');
  if (!cacheId) {
    return;
  }
  await db.delete('sites', cacheId);
}

export async function queueAction(action) {
  const db = await dbPromise;
  const queuedAction = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...action,
  };
  await db.put('queue', queuedAction);
  return queuedAction;
}

export async function getQueuedActions() {
  const db = await dbPromise;
  return db.getAll('queue');
}

export async function removeQueuedAction(id) {
  const db = await dbPromise;
  await db.delete('queue', id);
}

export async function setLastSyncAt(value) {
  const db = await dbPromise;
  await db.put('meta', { key: 'lastSyncAt', value });
}

export async function getLastSyncAt() {
  const db = await dbPromise;
  const entry = await db.get('meta', 'lastSyncAt');
  return entry?.value || null;
}

// ── Recents cache (lightweight — strips heavy lease_sheet_data) ──

function lightweightRecent(record) {
  // Only keep what the RecentsPanel list needs for display.
  // Drop lease_sheet_data (contains base64 photos) to keep IndexedDB small.
  const { lease_sheet_data, ...rest } = record;
  // Keep only the applicators list from lease_sheet_data for display
  return {
    ...rest,
    lease_sheet_data: lease_sheet_data ? { applicators: lease_sheet_data.applicators } : null,
  };
}

export async function replaceRecents(records) {
  const db = await dbPromise;
  const tx = db.transaction('recents', 'readwrite');
  await tx.store.clear();
  for (const record of records) {
    await tx.store.put(lightweightRecent(record));
  }
  await tx.done;
}

export async function getRecents() {
  const db = await dbPromise;
  return db.getAll('recents');
}

export async function upsertRecent(record) {
  // Used by the delta-sync path: merge a single incoming record into the
  // cache without blowing away the rest. Strips lease_sheet_data's heavy
  // fields just like replaceRecents does.
  const db = await dbPromise;
  await db.put('recents', lightweightRecent(record));
}

export async function removeRecentById(id) {
  const db = await dbPromise;
  await db.delete('recents', id);
}

// ── Lookups cache (herbicides, applicators, weeds, location types) ──

export async function replaceLookups(lookupKey, records) {
  const db = await dbPromise;
  await db.put('lookups', { key: lookupKey, items: records, updatedAt: new Date().toISOString() });
}

export async function getLookups(lookupKey) {
  const db = await dbPromise;
  const entry = await db.get('lookups', lookupKey);
  return entry?.items || [];
}

export async function getAllLookups() {
  const db = await dbPromise;
  const all = await db.getAll('lookups');
  const result = {};
  for (const entry of all) {
    result[entry.key] = entry.items;
  }
  return result;
}

// ── Users cache ──

export async function replaceUsers(users) {
  const db = await dbPromise;
  const tx = db.transaction('users', 'readwrite');
  await tx.store.clear();
  for (const user of users) {
    await tx.store.put(user);
  }
  await tx.done;
}

export async function getUsers() {
  const db = await dbPromise;
  return db.getAll('users');
}

// ── Upload queue (background lease sheet / spray record uploads) ──

export async function queueUpload(entry) {
  const db = await dbPromise;
  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...entry,
  };
  await db.put('uploadQueue', item);
  return item;
}

export async function getUploadQueue() {
  const db = await dbPromise;
  return db.getAll('uploadQueue');
}

export async function removeUploadEntry(id) {
  const db = await dbPromise;
  await db.delete('uploadQueue', id);
}

export async function updateUploadEntry(id, updates) {
  const db = await dbPromise;
  const existing = await db.get('uploadQueue', id);
  if (!existing) return;
  const updated = { ...existing, ...updates };
  await db.put('uploadQueue', updated);
  return updated;
}

// ── Lease Sheet Drafts (device-local, not synced) ──
// Draft shape: { id, site_id, pipeline_id, form, photos, ticketNumber, label, createdAt, updatedAt }

export async function saveLeaseSheetDraft(draft) {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const existing = draft.id ? await db.get('leaseSheetDrafts', draft.id) : null;
  // Order matters: spread draft FIRST so we can guarantee `id` isn't wiped by
  // a `draft.id === undefined` on the incoming payload. IndexedDB requires a
  // valid key on the `id` keyPath.
  const payload = {
    createdAt: existing?.createdAt || now,
    ...draft,
    id: draft.id || existing?.id || crypto.randomUUID(),
    updatedAt: now,
  };
  await db.put('leaseSheetDrafts', payload);
  return payload;
}

export async function getLeaseSheetDrafts() {
  const db = await dbPromise;
  const drafts = await db.getAll('leaseSheetDrafts');
  return drafts.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getLeaseSheetDraft(id) {
  const db = await dbPromise;
  return db.get('leaseSheetDrafts', id);
}

export async function deleteLeaseSheetDraft(id) {
  const db = await dbPromise;
  await db.delete('leaseSheetDrafts', id);
}
