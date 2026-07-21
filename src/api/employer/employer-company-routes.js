// FILE: src/api/employer/employer-company-routes.js
// Company create + read + update. Mounted at /api/employer/company behind
// requireEmployer (applied in server.js). The owning company is always read
// from the authenticated user — never from request input (§6.5).

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';
import { getCompanyById, updateCompanyForOwner, toPublicCompany } from '../../models/employer/company-model.js';
import { onboardEmployerCompany } from '../../services/employer/onboarding-service.js';
import {
  validateName, validateOptionalUrl, validateRetentionDays, validateDpoEmail,
} from '../../services/employer/company-validators.js';
import {
  requireInterviewerOrHigher, requireOwnerOrHigher,
} from '../../middleware/require-company-role-middleware.js';

const router = Router();
const PATCHABLE_FIELDS = ['name', 'website', 'retentionDays', 'privacyPolicyUrl', 'dpoEmail'];

// This router mounts on requireEmployer only (POST onboarding must work before a
// company exists), so the role middleware — which needs req.employerCompanyId — gets
// it here. Preserves the existing 404 NO_COMPANY for a caller who hasn't onboarded.
async function attachCompanyForRole(req, _res, next) {
  try {
    const user = await getEmployerUserById(req.employerUser.employerUserId);
    if (!user?.companyId) return next(new HttpError(404, 'No company', 'NO_COMPANY'));
    req.employerCompanyId = user.companyId;
    next();
  } catch (err) {
    next(err);
  }
}

/** Validate a PATCH body: reject unknown keys, normalize each supplied field. */
function buildCompanyPatch(body) {
  for (const key of Object.keys(body)) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      throw new HttpError(400, `Unknown field: ${key}`, 'UNKNOWN_FIELD');
    }
  }
  const patch = {};
  if ('name' in body) patch.name = validateName(body.name);
  if ('website' in body) patch.website = validateOptionalUrl(body.website, 'INVALID_WEBSITE');
  if ('retentionDays' in body) patch.retentionDays = validateRetentionDays(body.retentionDays);
  if ('privacyPolicyUrl' in body) {
    patch.privacyPolicyUrl = validateOptionalUrl(body.privacyPolicyUrl, 'INVALID_PRIVACY_POLICY_URL');
  }
  if ('dpoEmail' in body) patch.dpoEmail = validateDpoEmail(body.dpoEmail);
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'No valid fields to update', 'EMPTY_PATCH');
  }
  return patch;
}

// POST /api/employer/company — create + onboard.
router.post('/', asyncHandler(async (req, res) => {
  const { name, website, retentionDays } = req.body || {};
  const result = await onboardEmployerCompany({
    employerUserId: req.employerUser.employerUserId, name, website, retentionDays,
  });
  res.json(result);
}));

// GET /api/employer/company — the caller's company (404 NO_COMPANY when absent).
router.get('/', attachCompanyForRole, requireInterviewerOrHigher, asyncHandler(async (req, res) => {
  const user = await getEmployerUserById(req.employerUser.employerUserId);
  if (!user?.companyId) throw new HttpError(404, 'No company', 'NO_COMPANY');
  const company = await getCompanyById(user.companyId);
  if (!company) throw new HttpError(404, 'No company', 'NO_COMPANY');
  res.json({ company: toPublicCompany(company) });
}));

// PATCH /api/employer/company — update the caller's own company only. Owner+.
router.patch('/', attachCompanyForRole, requireOwnerOrHigher, asyncHandler(async (req, res) => {
  const user = await getEmployerUserById(req.employerUser.employerUserId);
  if (!user?.companyId) throw new HttpError(404, 'No company', 'NO_COMPANY');
  const patch = buildCompanyPatch(req.body || {});
  const company = await updateCompanyForOwner(user.companyId, user._id, patch);
  if (!company) throw new HttpError(404, 'No company', 'NO_COMPANY');
  res.json({ company: toPublicCompany(company) });
}));

export default router;
