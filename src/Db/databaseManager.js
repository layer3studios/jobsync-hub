// Barrel re-export — all existing imports from this path continue to work
export { client, connectToDb } from './connection.js';
export * from './jobCrud.js';
export * from './companyQueries.js';
export * from './analyticsQueries.js';