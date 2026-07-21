// FILE: src/api/public/public-invite-routes.js
// Public (unauthenticated) invite preview (feat/team-invites chunk 2). Mounted at
// /api/public/invites. The invitee isn't necessarily signed in yet, so no auth. The
// response is a SANITIZED shape — never the raw invite row, never the token (it's in
// the URL, D3), never invitedByEmployerUserId (only invitedByName), and never
// acceptedBy/acceptedAt. Stale invites return 410 Gone with { status } (not 404) so
// the UI can render a specific message (R5).

import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler-middleware.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';
import { getInvitePreview } from '../../services/employer/invite-service.js';

const router = Router();

const GONE_CODE = { expired: 'INVITE_EXPIRED', revoked: 'INVITE_REVOKED', accepted: 'INVITE_ALREADY_ACCEPTED' };

// GET /api/public/invites/:token — sanitized preview, or 404 (unknown) / 410 (stale).
router.get('/:token', asyncHandler(async (req, res) => {
  const result = await getInvitePreview(req.params.token);
  if (!result) throw new HttpError(404, 'Invite not found', 'INVITE_NOT_FOUND');
  if (result.gone) {
    return res.status(410).json({
      error: `This invite is ${result.gone}`,
      code: GONE_CODE[result.gone] ?? 'INVITE_GONE',
      status: result.gone,
    });
  }
  res.json(result.preview);
}));

export default router;
