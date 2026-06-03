// FILE: src/server.js
// Application entry. Wires middleware, routes, and scheduled tasks.

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';

import { PORT, FRONTEND_URL, RUN_SCRAPER_ON_START } from './env.js';
import { connectToDb, closeDb } from './Db/connection.js';
import { ensureUserIndexes } from './models/user/index.js';
import { ensureJobIndexes } from './models/jobModel.js';

import { runScraper } from './tasks/runScraper.js';

import authRouter from './api/auth.routes.js';
import meRouter from './api/me.routes.js';
import { jobsApiRouter } from './api/jobs.routes.js';
import usersRouter from './api/users.routes.js';
import adminRouter from './api/admin.routes.js';

import { authenticate } from './middleware/authMiddleware.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ─── Health ───────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('Job Scraper Backend running.'));

// ─── Routes ───────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/me', authenticate, meRouter);
app.use('/api/jobs', jobsApiRouter);
app.use('/api/users', usersRouter); // legacy 410 wildcard
app.use('/api/admin', adminRouter);

// ─── 404 + central error handler (must be last) ───────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Boot ─────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  try {
    await connectToDb();
    await ensureUserIndexes();
    await ensureJobIndexes();
    console.log(`[server] listening on http://localhost:${PORT}`);

    // Daily scrape at 06:00 server time.
    cron.schedule('0 6 * * *', () => {
      console.log('[cron] daily scrape');
      runScraper();
    });
    console.log('[cron] scheduled');

    if (RUN_SCRAPER_ON_START) {
      console.log('[boot] RUN_SCRAPER_ON_START is true — running initial scrape');
      runScraper();
    }
  } catch (err) {
    console.error('[server] failed to start', err);
    process.exit(1);
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[server] ${signal} — shutting down`);
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  // hard-kill if close hangs
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
