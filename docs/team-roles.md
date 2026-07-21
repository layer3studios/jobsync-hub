# Team roles & membership (feat/team-invites)

How JobMesh models "who is on a company's hiring team and what they can do." This
document covers the data model, the four roles, the per-company role middleware, and
the backfill/audit scripts. It is the reference for chunks 2 (invite lifecycle),
3 (route enforcement), and 4 (frontend).

> Chunk 1 (this one) is **backend-only and additive**: schemas, model helpers,
> middleware, scripts, and two read endpoints. It does **not** wire enforcement into
> any existing route and does **not** change any user-facing behavior. After the
> backfill runs, every existing company has exactly one Founder and the current UI
> keeps working unchanged.

---

## The four roles

Role lives on `company_members`, **per company** — never on `employer_users`. (A
single employer user could later be Owner at company A and Interviewer at company B;
for now each employer user belongs to exactly one company.)

| Role | Count per company | Can do |
|---|---|---|
| **Founder** | exactly 1 | Everything an Owner can, **plus** delete the company and transfer Founder status. |
| **Owner** | many | Invite/remove teammates, change roles (except Founder transfer), edit company settings. Full pipeline + jobs. |
| **Member** | many | Full applicant pipeline access, create/edit jobs. **Cannot** invite/remove teammates or edit settings. |
| **Interviewer** | many | View applicants + add notes by default. Moving and archiving applicants are **per-user configurable** (see below). |

Role hierarchy for "or higher" checks: `interviewer < member < owner < founder`.

### Interviewer configurable permissions

Two booleans on the membership row, both **default `false`**, toggleable later by any
Owner/Founder:

- `canMoveApplicants` — may move applicants between pipeline stages.
- `canArchiveApplicants` — may archive/unarchive applicants.

These flags are stored on **every** `company_members` row regardless of role (D2), but
they are only *consulted* for interviewers — Founder/Owner/Member always have both
capabilities implicitly. When someone is promoted from Interviewer → Member the flags
stay in the doc but become moot.

---

## Data model

### `company_members`

One row per `(companyId, employerUserId)`.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `companyId` | ObjectId | indexed |
| `employerUserId` | ObjectId | indexed |
| `role` | `'founder' \| 'owner' \| 'member' \| 'interviewer'` | |
| `isFounder` | boolean | **MUST equal `role === 'founder'`** (invariant D1). Redundant with `role`, but the partial unique index needs a boolean to filter on. |
| `canMoveApplicants` | boolean | default false (interviewer-only meaning, D2) |
| `canArchiveApplicants` | boolean | default false |
| `invitedByEmployerUserId` | ObjectId \| null | null for the backfilled Founder |
| `joinedAt` | Date | backfill uses `companies.createdAt` when available |
| `updatedAt` | Date | |

**Indexes**

1. Unique compound `{ companyId: 1, employerUserId: 1 }` — one row per user per company.
2. **Partial unique** `{ companyId: 1, isFounder: 1 }` filtered on `isFounder: true` —
   enforces **at most one Founder per company** at the database level (R4/C11). This
   is the ground truth; application checks are a courtesy. Because it filters on the
   boolean, invariant D1 must hold or the guarantee breaks — the model layer rejects
   any insert/update that would violate it.
3. Secondary `{ employerUserId: 1 }` — "which companies is this user a member of."

### `company_invites`

Created this chunk (schema + indexes + model helpers) even though no lifecycle
endpoints exist yet (D3) — keeping model + schema + indexes in one migration commit
makes the invariants easier to reason about. Chunk 2 wires the routes.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `companyId` | ObjectId | indexed |
| `email` | string | normalized lowercase, indexed |
| `role` | `'owner' \| 'member' \| 'interviewer'` | **Founder is never invited** — only transferred. |
| `canMoveApplicants` / `canArchiveApplicants` | boolean | only meaningful for `role: 'interviewer'` |
| `token` | string | 64-char hex, 256-bit (see below) |
| `invitedByEmployerUserId` | ObjectId | |
| `status` | `'pending' \| 'accepted' \| 'revoked' \| 'expired'` | indexed |
| `expiresAt` | Date | 7 days from creation for pending |
| `createdAt` / `updatedAt` | Date | |
| `acceptedAt` | Date \| null | |
| `acceptedByEmployerUserId` | ObjectId \| null | |

**Indexes**

1. Unique `{ token: 1 }`.
2. **Partial unique** `{ companyId: 1, email: 1, status: 1 }` filtered on
   `status: 'pending'` — at most one *pending* invite per email per company.
3. Secondary `{ status: 1, expiresAt: 1 }` — for a future expiry sweep.

#### Invite token format + expiry

- **Token**: `crypto.randomBytes(32).toString('hex')` → 64-char hex string, 256 bits of
  entropy, single-use (R5, C10 — Node built-in only, no new deps). Never returned by
  the read endpoints; it only travels in the invite link (chunk 2).
- **Expiry**: `createdAt + 7 days`. `getPendingInvitesForCompany` treats an invite whose
  `expiresAt` is in the past as absent; a future sweep task flips lapsed pending
  invites to `status: 'expired'` using index #3.

---

## Role middleware — `require-company-role-middleware.js`

Runs **after** `requireEmployer` (sets `req.employerUser.employerUserId`) and
`requireEmployerCompany` (sets `req.employerCompanyId`). It looks up the
`company_members` row for that `(companyId, employerUserId)` pair, attaches
`req.companyMemberRole` and `req.companyMemberPermissions = { canMoveApplicants,
canArchiveApplicants }`, then permits or 403s.

> Note on field names: this codebase sets the session id at
> `req.employerUser.employerUserId` (not `req.employerUserId`), and the company owner
> link on `companies` is `claimedByEmployerUserId` (not `ownerEmployerUserId`). The
> middleware and scripts use the real field names.

| Export | Allows |
|---|---|
| `requireFounder` | `founder` |
| `requireOwnerOrHigher` | `founder`, `owner` |
| `requireMemberOrHigher` | `founder`, `owner`, `member` |
| `requireInterviewerOrHigher` | all four |
| `requireCanMoveApplicants` | Founder/Owner/Member always; Interviewer iff `canMoveApplicants` |
| `requireCanArchiveApplicants` | Founder/Owner/Member always; Interviewer iff `canArchiveApplicants` |

**403 error codes**

- `COMPANY_MEMBERSHIP_NOT_FOUND` — no membership row for this pair. Should never happen
  after backfill; means a session survived a company removal.
- `INSUFFICIENT_ROLE` — role ranks below the requirement.
- `INSUFFICIENT_INTERVIEWER_PERMS` — interviewer lacks the required move/archive flag.

### Which endpoints will use which check (foreshadowing chunk 3)

This chunk does **not** wire enforcement into existing routes. Chunk 3 will apply,
roughly:

- Company settings edit, invite create/revoke, role change → `requireOwnerOrHigher`
  (Founder transfer + company delete → `requireFounder`).
- Posting create/edit, applicant view → `requireMemberOrHigher`.
- Applicant **move** → `requireCanMoveApplicants`; applicant **archive** →
  `requireCanArchiveApplicants`.
- Team roster read → `requireInterviewerOrHigher` (already used by the read endpoints
  below); pending-invite read → `requireOwnerOrHigher`.

---

## Read endpoints (this chunk)

Both mounted under `/api/employer/team` behind `requireEmployer` +
`requireEmployerCompany`; `companyId` always comes from the session, never the body.

- `GET /api/employer/team/members` — the roster. Auth adds `requireInterviewerOrHigher`
  (visible to every member — seeing the team is not privileged). Returns
  `{ members: [{ id, employerUserId, name, email, picture, role, isFounder,
  canMoveApplicants, canArchiveApplicants, invitedByEmployerUserId, joinedAt }] }`.
  For an existing (backfilled) company this returns just the single Founder.
- `GET /api/employer/team/invites` — pending invites. Auth adds `requireOwnerOrHigher`
  (Founder/Owner only). Returns `{ invites: [...] }` — **empty this chunk** since no
  invites can be created yet (chunk 2 makes it useful). The token is never included.

---

## Scripts

### Backfill — `src/scripts/backfill-company-members.js`

Gives every existing company a Founder row derived from its current owner
(`companies.claimedByEmployerUserId`).

```
node src/scripts/backfill-company-members.js            # apply
node src/scripts/backfill-company-members.js --dry-run  # report only, no writes
```

- **Idempotent** (C9): for each company, if a Founder row already exists it is skipped;
  otherwise one is inserted with `role: 'founder', isFounder: true,
  invitedByEmployerUserId: null, joinedAt: companies.createdAt ?? now`. A second run
  inserts 0.
- A company with no `claimedByEmployerUserId` is logged and skipped (orphan; should not
  happen).
- Prints: `total`, `inserted`, `skipped-already-had-founder`, `skipped-orphan-no-owner`,
  `errors`.
- **Not run against production by this repo** — a human runs it on deploy (D5). There is
  no rollback script; to undo, drop the collection and re-run (safe in chunk 1 because
  nothing enforces yet).

### Audit — `src/scripts/audit-company-members.js` (read-only)

```
node src/scripts/audit-company-members.js
```

Reports and is safe to run anytime: total companies, companies with 0 founders (expect
0 after backfill), companies with >1 founders (expect 0), total members, role
distribution, duplicate `(companyId, employerUserId)` pairs (expect 0), and
founder-vs-owner drift (0 immediately after backfill; grows as ownership transfers
happen in later chunks).

---

## Invariants recap

- **One Founder per company** — enforced by the partial unique index on `isFounder`.
- **`isFounder === (role === 'founder')`** — enforced by the model layer on every
  insert/update.
- **One row per user per company** — enforced by the compound unique index.
- **At most one pending invite per email per company** — enforced by the partial unique
  index on `status: 'pending'`.
- **Multi-tenant** — every model helper and service function takes `companyId`
  explicitly; the middleware is the single place that reads it from the session.
