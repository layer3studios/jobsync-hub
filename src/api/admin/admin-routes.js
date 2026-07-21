// FILE: src/api/admin/admin-routes.js
// Admin router index. Applies requireAdmin (jm_admin_token) once, then mounts the
// sub-routers. Mounted at /api/admin by server.js — the public URLs
// (e.g. /api/admin/reclean-descriptions) are unchanged from before the refactor.

import { Router } from 'express';
import { requireAdmin } from '../../middleware/require-admin-middleware.js';
import recleanRouter from './reclean-routes.js';
import employerAccessRouter from './employer-access-routes.js';

const router = Router();

// Every admin endpoint requires a valid admin session (jm_admin_token). Standalone
// now — no seeker cookie needed (D5): admin + seeker sessions coexist independently.
router.use(requireAdmin);

router.use('/', recleanRouter);
router.use('/', employerAccessRouter);

export default router;
