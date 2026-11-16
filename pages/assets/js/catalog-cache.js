const DB_NAME = "frame-audio-catalog";
const DB_VERSION = 3;
const DATA_STORES = ["tracks", "folders", "shows", "episodes"];
const ALL_STORES = [...DATA_STORES, "meta"];

let databasePromise = null;
let trackCompactionScheduled = false;

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
      request.onupgradeneeded = event => {
        const db = request.result;
        for (const name of DATA_STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        // Legacy track records are compacted in the background after cache
        // restoration. Do not rewrite every song inside the blocking
        // version-change transaction, which can delay the first library view.
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
      request.onblocked = () => {
        console.warn("[FRAME Audio] IndexedDB version upgrade is waiting for another tab to close.");
      };
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function readCatalogCache(storeNames = DATA_STORES) {
  const startedAt = performance.now();
  const db = await openCatalogCache();
  if (!db) return null;
  const openedAt = performance.now();
  const selected = DATA_STORES.filter(name => Array.isArray(storeNames) && storeNames.includes(name));
  const transaction = db.transaction([...selected, "meta"], "readonly");
  const done = transactionDone(transaction);
  const reads = selected.map(name => requestValue(transaction.objectStore(name).getAll()));
  const metaRead = requestValue(transaction.objectStore("meta").get("catalog"));
  const [rows, metaRow] = await Promise.all([Promise.all(reads), metaRead]);
  await done;
  const result = { db, meta: metaRow?.value || null };
  for (const name of DATA_STORES) result[name] = [];
  selected.forEach((name, index) => {
    result[name] = (rows[index] || []).map(item => compactCatalogItem(name, item));
  });
  if (selected.includes("tracks")) scheduleLegacyTrackCompaction(db);
  console.info("[FRAME Audio] IndexedDB catalogue cache restored", {
    stores: selected,
    rowCounts: Object.fromEntries(selected.map((name, index) => [name, rows[index]?.length || 0])),
    openMs: Math.round(openedAt - startedAt),
    readMs: Math.round(performance.now() - openedAt),
    totalMs: Math.round(performance.now() - startedAt)
  });
  return result;
}

export async function clearCatalogStore(db, storeName) {
  if (!db || !DATA_STORES.includes(storeName)) return;
  const transaction = db.transaction(storeName, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(storeName).clear();
  await done;
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

function scheduleLegacyTrackCompaction(db) {
  if (!db || trackCompactionScheduled || !db.objectStoreNames.contains("tracks")) return;
  trackCompactionScheduled = true;
  const compact = () => {
    let transaction;
    try {
      transaction = db.transaction("tracks", "readwrite");
      transaction.onabort = () => { trackCompactionScheduled = false; };
      transaction.onerror = () => { trackCompactionScheduled = false; };
      const request = transaction.objectStore("tracks").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const compacted = compactCatalogItem("tracks", cursor.value);
        if (compacted !== cursor.value) cursor.update(compacted);
        cursor.continue();
      };
      request.onerror = () => {
        try { transaction.abort(); } catch {}
      };
    } catch (error) {
      trackCompactionScheduled = false;
      console.warn("[FRAME Audio] Background cache compaction could not start.", error);
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(compact, { timeout: 3000 });
  } else {
    setTimeout(compact, 1200);
  }
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
