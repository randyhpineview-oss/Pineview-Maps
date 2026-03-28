import { openDB } from 'idb';

const DB_NAME = 'pineview-offline-db';
const DB_VERSION = 1;

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
