// FILE: tests/api/admin-team-routes.test.js
// Admin team CRUD routes (feat/admin-team-management chunk 1). Mounted exactly as
// server.js does: /api/admin/team behind requireAdmin. Cookies are real JWTs so
// requireAdmin's row lookup + isActive revocation both run for real.
import './../_helpers/test-db.js';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { dropCollections, closeTestDb } from '../_helpers/test-db.js';
import { col } from '../../src/Db/connection.js';
import { JWT_SECRET, FRONTEND_URL } from '../../src/env.js';
import adminTeamRouter from '../../src/api/admin/admin-team-routes.js';
import { requireAdmin } from '../../src/middleware/require-admin-middleware.js';
import { errorHandler } from '../../src/middleware/error-handler-middleware.js';
import {
  ensureAdminUserIndexes, upsertAdminByEmail, createAdminInvite,
} from '../../src/models/admin/index.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/team', requireAdmin, adminTeamRouter); // mirrors server.js mount
  app.use(errorHandler);
  return app;
}

function cookieFor(row) {
  const token = jwt.sign(
    { adminUserId: row._id.toString(), email: row.email, role: row.role }, JWT_SECRET, { expiresIn: '8h' },
  );
  return `jm_admin_token=${token}`;
}

async function seed(email, role) {
  return upsertAdminByEmail({ email, role });
}

async function reset() {
  await dropCollections('admin_users');
  await ensureAdminUserIndexes();
}
before(reset);
beforeEach(reset);
after(async () => { await closeTestDb(); });

test('GET /team as admin → 200 roster with inviteToken stripped', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const plain = await seed('plain@x.com', 'admin');
  await createAdminInvite({ email: 'pending@x.com', role: 'admin', invitedByAdminUserId: superAdmin._id });

  const res = await request(buildApp()).get('/api/admin/team').set('Cookie', cookieFor(plain));
  assert.equal(res.status, 200);
  assert.equal(res.body.admins.length, 3);
  for (const row of res.body.admins) {
    assert.equal('inviteToken' in row, false, 'inviteToken never leaves GET /team');
  }
  const pending = res.body.admins.find((r) => r.email === 'pending@x.com');
  assert.equal(pending.isActive, false);
  assert.equal(pending.invitedByEmail, 'super@x.com'); // denormalized inviter email
});

test('GET /team as a deactivated admin → 403 (requireAdmin revocation)', async () => {
  const row = await seed('gone@x.com', 'admin');
  const cookie = cookieFor(row);
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  const res = await request(buildApp()).get('/api/admin/team').set('Cookie', cookie);
  assert.equal(res.status, 403);
});

test('POST /invite as non-super admin → 403 NOT_SUPER_ADMIN', async () => {
  const plain = await seed('plain@x.com', 'admin');
  const res = await request(buildApp()).post('/api/admin/team/invite')
    .set('Cookie', cookieFor(plain)).send({ email: 'x@x.com', role: 'admin' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_SUPER_ADMIN');
});

test('POST /invite as super_admin → 201 with inviteUrl carrying FRONTEND_URL + token', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const res = await request(buildApp()).post('/api/admin/team/invite')
    .set('Cookie', cookieFor(superAdmin)).send({ email: 'new@x.com', role: 'admin' });
  assert.equal(res.status, 201);
  const { invite } = res.body;
  assert.equal(invite.email, 'new@x.com');
  assert.match(invite.inviteToken, /^[0-9a-f]{64}$/);
  assert.equal(invite.inviteUrl, `${FRONTEND_URL}/admin/invites/${invite.inviteToken}`);
});

test('POST /invite with an already-active email → 400 EMAIL_ALREADY_ADMIN', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  await seed('taken@x.com', 'admin');
  const res = await request(buildApp()).post('/api/admin/team/invite')
    .set('Cookie', cookieFor(superAdmin)).send({ email: 'taken@x.com', role: 'admin' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMAIL_ALREADY_ADMIN');
});

test('POST /invite with an invalid email → 400 INVALID_EMAIL', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const res = await request(buildApp()).post('/api/admin/team/invite')
    .set('Cookie', cookieFor(superAdmin)).send({ email: 'not-an-email', role: 'admin' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_EMAIL');
});

test('POST /invite with an invalid role → 400 INVALID_ROLE', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const res = await request(buildApp()).post('/api/admin/team/invite')
    .set('Cookie', cookieFor(superAdmin)).send({ email: 'x@x.com', role: 'viewer' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_ROLE');
});

test('PATCH /:id/deactivate as super_admin succeeds', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const target = await seed('plain@x.com', 'admin');
  const res = await request(buildApp()).patch(`/api/admin/team/${target._id}/deactivate`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.isActive, false);
});

test('PATCH /:id/deactivate on self → 400 CANNOT_DEACTIVATE_SELF', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const res = await request(buildApp()).patch(`/api/admin/team/${superAdmin._id}/deactivate`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CANNOT_DEACTIVATE_SELF');
});

// NOTE: CANNOT_REMOVE_LAST_SUPER_ADMIN / CANNOT_DEMOTE_LAST_SUPER_ADMIN are
// defense-in-depth guards that are UNREACHABLE through the authenticated route
// path: requireAdmin re-reads the acting admin's role from the DB, so any actor
// who passes requireSuperAdmin is an ACTIVE super_admin — which means the target
// is never "the last" active super (count ≥ 2), and acting on oneself hits the
// self-guards first. Both codes are exercised directly in
// tests/models/admin-user-model.test.js; the route error-mapping machinery they
// share is proven by the CANNOT_DEACTIVATE_SELF / CANNOT_DEMOTE_SELF tests here.

test('PATCH /:id/deactivate of the other super succeeds when two supers exist (guard stays quiet)', async () => {
  const target = await seed('super@x.com', 'super_admin');
  const acting = await seed('super2@x.com', 'super_admin');
  const res = await request(buildApp()).patch(`/api/admin/team/${target._id}/deactivate`)
    .set('Cookie', cookieFor(acting));
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.isActive, false);
});

test('PATCH /:id/reactivate succeeds', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const target = await seed('plain@x.com', 'admin');
  await (await col('admin_users')).updateOne({ _id: target._id }, { $set: { isActive: false } });
  const res = await request(buildApp()).patch(`/api/admin/team/${target._id}/reactivate`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.isActive, true);
});

test('PATCH /:id/role promotes admin → super_admin', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const target = await seed('plain@x.com', 'admin');
  const res = await request(buildApp()).patch(`/api/admin/team/${target._id}/role`)
    .set('Cookie', cookieFor(superAdmin)).send({ role: 'super_admin' });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.role, 'super_admin');
});

test('PATCH /:id/role demoting self → 400 CANNOT_DEMOTE_SELF', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const res = await request(buildApp()).patch(`/api/admin/team/${superAdmin._id}/role`)
    .set('Cookie', cookieFor(superAdmin)).send({ role: 'admin' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CANNOT_DEMOTE_SELF');
});

test('PATCH /:id/role demoting the other super succeeds when two supers exist (guard stays quiet)', async () => {
  const target = await seed('super@x.com', 'super_admin');
  const acting = await seed('super2@x.com', 'super_admin');
  const res = await request(buildApp()).patch(`/api/admin/team/${target._id}/role`)
    .set('Cookie', cookieFor(acting)).send({ role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal(res.body.admin.role, 'admin');
});

async function seedPending(inviterId, email = 'pending@x.com') {
  return createAdminInvite({ email, role: 'admin', invitedByAdminUserId: inviterId });
}

async function seedEverActivatedInactive(inviterId, email = 'was@x.com') {
  const row = await createAdminInvite({ email, role: 'admin', invitedByAdminUserId: inviterId });
  const { activateAdminByInviteToken } = await import('../../src/models/admin/index.js');
  await activateAdminByInviteToken(row.inviteToken, email);
  await (await col('admin_users')).updateOne({ _id: row._id }, { $set: { isActive: false } });
  return row;
}

test('POST /:id/resend-invite on pending row → 200 with fresh token + FRONTEND_URL inviteUrl', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const pending = await seedPending(superAdmin._id);
  const res = await request(buildApp()).post(`/api/admin/team/${pending._id}/resend-invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 200);
  const { invite } = res.body;
  assert.match(invite.inviteToken, /^[0-9a-f]{64}$/);
  assert.notEqual(invite.inviteToken, pending.inviteToken);
  assert.ok(new Date(invite.inviteExpiresAt) > new Date(Date.now() + 6 * 24 * 3600 * 1000));
  assert.equal(invite.inviteUrl, `${FRONTEND_URL}/admin/invites/${invite.inviteToken}`);
});

test('POST /:id/resend-invite on an active admin → 400 CANNOT_RESEND_ACTIVE_ADMIN', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const active = await seed('active@x.com', 'admin');
  const res = await request(buildApp()).post(`/api/admin/team/${active._id}/resend-invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CANNOT_RESEND_ACTIVE_ADMIN');
});

test('POST /:id/resend-invite on an ever-activated inactive admin → 400 CANNOT_RESEND_ACTIVATED_ADMIN', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const was = await seedEverActivatedInactive(superAdmin._id);
  const res = await request(buildApp()).post(`/api/admin/team/${was._id}/resend-invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CANNOT_RESEND_ACTIVATED_ADMIN');
});

test('POST /:id/resend-invite on an unknown id → 404', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const res = await request(buildApp()).post(`/api/admin/team/${new (await import('mongodb')).ObjectId()}/resend-invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 404);
});

test('POST /:id/resend-invite as non-super_admin → 403 NOT_SUPER_ADMIN', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const plain = await seed('plain@x.com', 'admin');
  const pending = await seedPending(superAdmin._id);
  const res = await request(buildApp()).post(`/api/admin/team/${pending._id}/resend-invite`)
    .set('Cookie', cookieFor(plain));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_SUPER_ADMIN');
});

test('DELETE /:id/invite on pending row → 200 and the row is gone', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const pending = await seedPending(superAdmin._id);
  const res = await request(buildApp()).delete(`/api/admin/team/${pending._id}/invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 200);
  assert.equal(res.body.adminUserId, pending._id.toString());
  assert.equal(await (await col('admin_users')).findOne({ _id: pending._id }), null);
});

test('DELETE /:id/invite on an active admin → 400 CANNOT_REVOKE_ACTIVE_ADMIN', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const active = await seed('active@x.com', 'admin');
  const res = await request(buildApp()).delete(`/api/admin/team/${active._id}/invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CANNOT_REVOKE_ACTIVE_ADMIN');
});

test('DELETE /:id/invite on an ever-activated inactive admin → 400 CANNOT_REVOKE_ACTIVATED_ADMIN', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const was = await seedEverActivatedInactive(superAdmin._id);
  const res = await request(buildApp()).delete(`/api/admin/team/${was._id}/invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CANNOT_REVOKE_ACTIVATED_ADMIN');
});

test('DELETE /:id/invite on an unknown id → 404', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const res = await request(buildApp()).delete(`/api/admin/team/${new (await import('mongodb')).ObjectId()}/invite`)
    .set('Cookie', cookieFor(superAdmin));
  assert.equal(res.status, 404);
});

test('DELETE /:id/invite as non-super_admin → 403 NOT_SUPER_ADMIN', async () => {
  const superAdmin = await seed('super@x.com', 'super_admin');
  const plain = await seed('plain@x.com', 'admin');
  const pending = await seedPending(superAdmin._id);
  const res = await request(buildApp()).delete(`/api/admin/team/${pending._id}/invite`)
    .set('Cookie', cookieFor(plain));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_SUPER_ADMIN');
});

test('every PATCH route as non-super admin → 403 NOT_SUPER_ADMIN', async () => {
  const plain = await seed('plain@x.com', 'admin');
  const target = await seed('other@x.com', 'admin');
  for (const path of [`${target._id}/deactivate`, `${target._id}/reactivate`, `${target._id}/role`]) {
    const res = await request(buildApp()).patch(`/api/admin/team/${path}`)
      .set('Cookie', cookieFor(plain)).send({ role: 'admin' });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, 'NOT_SUPER_ADMIN', path);
  }
});
