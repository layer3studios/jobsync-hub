// FILE: src/middleware/require-admin-middleware.js
// Verifies the admin auth cookie and attaches req.adminUser. Strictly isolated
// from the seeker + employer stacks: reads ONLY jm_admin_token and verifies with
// JWT_SECRET. It never reads tj_token or jm_employer_token, so a seeker or
// employer session can coexist with (and never masquerade as) an admin session.
// Missing/invalid token → 401. Valid token but the admin row is gone or
// isActive:false → 403 (revocation takes effect immediately, mid-session).

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../env.js';
import { HttpError } from './error-handler-middleware.js';
import { findAdminById } from '../models/admin/index.js';

export async function requireAdmin(req, _res, next) {
  const token = req.cookies?.jm_admin_token;
  if (!token) return next(new HttpError(401, 'Unauthorized'));

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return next(new HttpError(401, 'Unauthorized'));
  }
  const adminUserId = decoded?.adminUserId;
  if (typeof adminUserId !== 'string' || !adminUserId) {
    return next(new HttpError(401, 'Unauthorized'));
  }

  try {
    const admin = await findAdminById(adminUserId);
    if (!admin) return next(new HttpError(403, 'Forbidden'));
    req.adminUser = { adminUserId: admin._id.toString(), email: admin.email, role: admin.role };
    next();
  } catch (err) {
    next(err);
  }
}

export default requireAdmin;
