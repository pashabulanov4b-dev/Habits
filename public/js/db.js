// Локальне сховище на телефоні (IndexedDB). Працює повністю офлайн.
const DB_NAME = 'habits-db';
const DB_VERSION = 2; // v2: + сховище tasks (планувальник)
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('habits')) db.createObjectStore('habits', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('marks')) db.createObjectStore('marks', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const db = {
  getAll(store) {
    return open().then((d) => reqP(d.transaction(store).objectStore(store).getAll()));
  },
  get(store, key) {
    return open().then((d) => reqP(d.transaction(store).objectStore(store).get(key)));
  },
  put(store, rec) {
    return tx(store, 'readwrite', (s) => { s.put(rec); });
  },
  putMany(store, recs) {
    if (!recs.length) return Promise.resolve();
    return tx(store, 'readwrite', (s) => { recs.forEach((r) => s.put(r)); });
  },
  async getMeta(key, fallback = null) {
    const r = await this.get('meta', key);
    return r ? r.value : fallback;
  },
  setMeta(key, value) {
    return this.put('meta', { key, value });
  }
};

// Просимо браузер не видаляти дані (iOS може чистити сховище сайтів, яких давно не відкривали).
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (e) { /* не критично */ }
}
