// FILE: src/Db/index.js
// Barrel exports. Importers can do `import { connectToDb, getJobsPaginated, ... } from './Db'`.

export { client, connectToDb, closeDb, col } from './connection.js';

export * from './jobs/index.js';
export * from './companies/index.js';
export * from './analytics/index.js';
