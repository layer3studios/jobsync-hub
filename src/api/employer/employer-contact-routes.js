// FILE: src/api/employer/employer-contact-routes.js
// Contact-level actions that are not scoped to one application. Mounted at
// /api/employer/contacts behind requireEmployer + requireEmployerCompany.
//
// The contactId is tenant-verified by re-reading the contact company-scoped — a
// cross-tenant id is indistinguishable from a missing one (§6.5), so it 404s rather
// than telling the caller that someone else's contact exists.

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { requireMemberOrHigher } from '../../middleware/require-company-role-middleware.js';
import { getContactForCompany, toPublicContact } from '../../models/public/contact-model.js';
import { setDoNotContactForCompany } from '../../models/public/contact-do-not-contact-model.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';

const router = Router();

/**
 * PATCH /api/employer/contacts/:contactId/do-not-contact — { flag, reason? }.
 *
 * Member+ to change it; an Interviewer still SEES the flag everywhere it renders,
 * because the warning is the safety feature and hiding it from the people most
 * likely to reach out would invert the point of it.
 *
 * The actor's name is snapshot onto the record, not joined at read time: the banner
 * has to keep saying who made this call after that person leaves the company.
 */
router.patch('/:contactId/do-not-contact', requireMemberOrHigher, asyncHandler(async (req, res) => {
  const { flag, reason } = req.body || {};
  if (typeof flag !== 'boolean') {
    throw new HttpError(400, 'flag must be true or false.', 'INVALID_DO_NOT_CONTACT');
  }

  const contact = await getContactForCompany(req.employerCompanyId, req.params.contactId);
  if (!contact) throw new HttpError(404, 'Candidate not found', 'CONTACT_NOT_FOUND');

  const actor = await getEmployerUserById(req.employerUser.employerUserId);
  const updated = await setDoNotContactForCompany(req.employerCompanyId, contact._id, {
    flag,
    reason,
    setBy: req.employerUser.employerUserId,
    setByName: actor?.name ?? actor?.email ?? null,
  });
  if (!updated) throw new HttpError(404, 'Candidate not found', 'CONTACT_NOT_FOUND');

  res.json({ contact: toPublicContact(updated) });
}));

export default router;
