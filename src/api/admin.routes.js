// FILE: src/api/admin.routes.js
import { Router } from 'express';
import { col } from '../Db/connection.js';
import { cleanJobDescription } from '../core/cleanJobDescription/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requireAdmin } from '../middleware/authMiddleware.js';

const router = Router();

// Every admin endpoint requires both: a valid auth cookie AND admin email.
router.use(authenticate, requireAdmin);

// POST /api/admin/reclean-descriptions — re-run cleanJobDescription across the corpus.
router.post('/reclean-descriptions', asyncHandler(async (_req, res) => {
  const jobs = await col('jobs');
  const query = {
    Description: { $exists: true, $ne: null },
    $or: [
      { DescriptionCleaned: { $exists: false } },
      { DescriptionCleaned: null },
      { $expr: { $eq: ['$DescriptionCleaned', '$Description'] } },
      { DescriptionCleaned: { $regex: '&lt;', $options: 'i' } },
    ],
  };

  const total = await jobs.countDocuments(query);
  const cursor = jobs.find(query, { projection: { _id: 1, Description: 1 } });

  let updated = 0;
  let skipped = 0;
  let errored = 0;
  const errors = [];

  for await (const job of cursor) {
    try {
      if (!job.Description || typeof job.Description !== 'string') { skipped++; continue; }
      const cleaned = cleanJobDescription(job.Description);
      if (!cleaned || cleaned === job.Description) { skipped++; continue; }
      const result = await jobs.updateOne(
        { _id: job._id },
        { $set: { DescriptionCleaned: cleaned, updatedAt: new Date() } },
      );
      if (result.modifiedCount > 0) updated++; else skipped++;
    } catch (err) {
      errored++;
      errors.push({ id: String(job._id), error: err?.message || 'Unknown error' });
    }
  }

  res.json({ success: true, total, updated, skipped, errored, errors });
}));

export default router;
