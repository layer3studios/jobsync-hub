// FILE: src/Db/connection.js
// MongoDB connection — native driver only. Mongoose was dual-loaded but never
// actually used (saveJobs uses native bulkWrite, hooks never fired). Removed.

import { MongoClient } from 'mongodb';
import { MONGO_URI } from '../env.js';

export const client = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 10000,
  retryWrites: true,
});

let db = null;
let connecting = null;

export async function connectToDb() {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      await client.connect();
      db = client.db();
      console.log('[db] connected');
      return db;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

export async function closeDb() {
  if (client) {
    await client.close();
    db = null;
  }
}

// Convenience: get a collection by name.
export async function col(name) {
  const database = await connectToDb();
  return database.collection(name);
}
