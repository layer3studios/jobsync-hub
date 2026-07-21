// FILE: src/middleware/require-seeker-middleware.js
// Verifies the seeker auth cookie (tj_token) and attaches req.user. Admin identity
// is a separate audience now — see require-admin-middleware.js (jm_admin_token).
// This file no longer knows anything about admins.

import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../env.js';
import { HttpError } from './error-handler-middleware.js';

export function requireSeeker(req, _res, next) {
  const token = req.cookies?.tj_token;
  if (!token) return next(new HttpError(401, 'Unauthorized'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded?.userId) return next(new HttpError(401, 'Unauthorized'));
    req.user = { userId: decoded.userId, email: decoded.email };
    next();
  } catch {
    next(new HttpError(401, 'Unauthorized'));
  }
}

// Optional auth: attaches req.user if a valid cookie is present, never rejects.
export function optionalAuth(req, _res, next) {
  const token = req.cookies?.tj_token;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded?.userId) req.user = { userId: decoded.userId, email: decoded.email };
  } catch { /* ignore */ }
  next();
}

export default requireSeeker;
