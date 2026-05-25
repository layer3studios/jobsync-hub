import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { MONGO_URI } from '../env.js';

export const client = new MongoClient(MONGO_URI);
let db;

export async function connectToDb() {
    if (db) return db;

    await client.connect();

    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(MONGO_URI);
        console.log("🍃 Mongoose Connected");
    }

    db = client.db();
    console.log("🗄️  Successfully connected to MongoDB.");
    return db;
}
