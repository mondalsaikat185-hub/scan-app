import { openDB } from 'idb';

const DB_NAME = 'scan-app-db';
const STORE = 'documents';

async function getDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    },
  });
}

export async function saveDocument(doc) {
  const db = await getDB();
  doc.updatedAt = Date.now();
  await db.put(STORE, doc);
  return doc;
}

export async function getAllDocuments() {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE, 'updatedAt');
  return all.reverse(); // Newest first
}

export async function getDocument(id) {
  const db = await getDB();
  return db.get(STORE, id);
}

export async function deleteDocument(id) {
  const db = await getDB();
  await db.delete(STORE, id);
}
