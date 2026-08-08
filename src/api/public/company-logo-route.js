// FILE: src/api/public/company-logo-route.js
// Public (unauthenticated) company-logo read, mounted at /api/public/company-logo.
// The careers and apply pages are unauthenticated, so the logo they render cannot
// live behind requireEmployer — hence a separate public route keyed by companyId.
//
// This serves ONE thing: bytes previously uploaded through the Owner-gated employer
// route, from data/logos/ only. The path comes from the company row (never from the
// URL) and is re-checked for directory containment before any read, so this can
// never be walked into an arbitrary-file reader.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getCompanyById } from '../../models/employer/company-model.js';
import { readLogoFile, contentTypeForLogo } from '../../services/employer/logo-storage-service.js';

const router = Router();
const CACHE_CONTROL = 'public, max-age=3600';

// GET /api/public/company-logo/:companyId — stream one company's logo.
router.get('/:companyId', asyncHandler(async (req, res) => {
  const company = await getCompanyById(req.params.companyId);
  // A bad id and a company with no logo are the same thing to a caller: no image.
  // 404 rather than a placeholder — the client falls back to its initials mark.
  if (!company?.logoStoragePath) throw new HttpError(404, 'No logo', 'LOGO_NOT_FOUND');

  const contentType = contentTypeForLogo(company.logoStoragePath);
  const buffer = contentType ? readLogoFile(company.logoStoragePath) : null;
  // The row says there is a logo but the bytes are gone (deleted by hand). Not a
  // 500 — the <img> onError handler falls back to initials.
  if (!buffer) throw new HttpError(404, 'No logo', 'LOGO_NOT_FOUND');

  res.set('Content-Type', contentType);
  res.set('Cache-Control', CACHE_CONTROL);
  res.set('Content-Length', String(buffer.length));
  res.send(buffer);
}));

export default router;
