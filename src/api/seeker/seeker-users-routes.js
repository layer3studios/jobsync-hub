// FILE: src/api/users.routes.js
// Legacy router. All endpoints under /api/users have been migrated to /api/me.
// Catch-all middleware — works in both Express 4 and 5 (no path = matches everything).

import { Router } from 'express';

const router = Router();

router.use((_req, res) => {
  res.status(410).json({
    error: 'Legacy endpoint. Please use Google login and the /api/me endpoints.',
  });
});

export default router;
