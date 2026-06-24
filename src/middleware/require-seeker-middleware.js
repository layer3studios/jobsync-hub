// FILE: src/middleware/authMiddleware.js
// Verifies the auth cookie and attaches req.user. requireAdmin uses ADMIN_EMAILS.

import jwt from 'jsonwebtoken';
import { JWT_SECRET, ADMIN_EMAILS } from '../env.js';
import { HttpError } from './errorHandler.js';

export function authenticate(req, _res, next) {
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

// Real admin check — only emails in ADMIN_EMAILS pass.
export function requireAdmin(req, _res, next) {
  const email = req.user?.email?.toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return next(new HttpError(403, 'Forbidden'));
  }
  next();
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

export const requireAuth = authenticate;
export default authenticate;
