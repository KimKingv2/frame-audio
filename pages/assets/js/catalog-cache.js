const DB_NAME = "frame-audio-catalog";
const DB_VERSION = 1;
const DATA_STORES = ["tracks", "folders", "shows", "episodes"];
const ALL_STORES = [...DATA_STORES, "meta"];

let databasePromise = null;

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
  });
}

export async function openCatalogCache() {
  if (typeof indexedDB === "undefined") return null;
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of DATA_STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = null;
        };
        try {
          if (navigator.storage?.persist) {
            void navigator.storage.persist().then(persisted => {
              console.info("[FRAME Audio] Persistent browser storage", { granted: persisted === true });
            }).catch(() => {});
          }
        } catch {}
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB."));
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another open tab."));
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function readCatalogCache() {
  const db = await openCatalogCache();
  if (!db) return null;
  const transaction = db.transaction(ALL_STORES, "readonly");
  const done = transactionDone(transaction);
  const [tracks, folders, shows, episodes, metaRow] = await Promise.all([
    requestValue(transaction.objectStore("tracks").getAll()),
    requestValue(transaction.objectStore("folders").getAll()),
    requestValue(transaction.objectStore("shows").getAll()),
    requestValue(transaction.objectStore("episodes").getAll()),
    requestValue(transaction.objectStore("meta").get("catalog"))
  ]);
  await done;
  return {
    db,
    tracks: tracks || [],
    folders: folders || [],
    shows: shows || [],
    episodes: episodes || [],
    meta: metaRow?.value || null
  };
}

export async function clearCatalogData(db) {
  if (!db) return;
  const transaction = db.transaction(DATA_STORES, "readwrite");
  const done = transactionDone(transaction);
  for (const name of DATA_STORES) transaction.objectStore(name).clear();
  await done;
}

function compactCatalogItem(storeName, item) {
  if (!item || typeof item !== "object") return item;
  if (storeName !== "tracks" || !item.metadata?.common ||
      !Object.prototype.hasOwnProperty.call(item.metadata.common, "lyrics")) return item;
  const common = { ...item.metadata.common };
  delete common.lyrics;
  return { ...item, metadata: { ...item.metadata, common } };
}

export async function putCatalogBatch(db, storeName, items) {
  if (!db || !DATA_STORES.includes(storeName) || !Array.isArray(items) || !items.length) return;
  const transaction = db.transaction(storeName, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  for (const item of items) {
    if (item && typeof item.id === "string" && item.id) {
      store.put(compactCatalogItem(storeName, item));
    }
  }
  await done;
}

export async function pruneCatalogCache(db, manifest) {
  if (!db || !manifest) return;
  const transaction = db.transaction(DATA_STORES, "readwrite");
  const done = transactionDone(transaction);
  for (const name of DATA_STORES) {
    const store = transaction.objectStore(name);
    const keep = new Set((Array.isArray(manifest[name]) ? manifest[name] : []).map(String));
    const request = store.getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result || []) {
        if (!keep.has(String(key))) store.delete(key);
      }
    };
    request.onerror = () => {
      try { transaction.abort(); } catch {}
    };
  }
  await done;
}

export async function writeCatalogMeta(db, value) {
  if (!db) return;
  const transaction = db.transaction("meta", "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("meta").put({ key: "catalog", value });
  await done;
}
