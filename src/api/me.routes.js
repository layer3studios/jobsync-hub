// FILE: src/api/me.routes.js
// All routes here assume req.user.userId is set by the authenticate middleware.

import { Router } from 'express';
import {
  getUserById, touchVisit,
  getAppliedJobs, getAppliedJobDetails, addAppliedJob, removeAppliedJob, updateAppliedJobStage,
  updateSkills,
  getComeBackTo, upsertComeBackTo, removeComeBackTo,
  setDailyGoal,
  getDismissedJobs, addDismissedJob, removeDismissedJob,
} from '../models/user/index.js';
import { findJobById } from '../Db/jobs/queries.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { HttpError } from '../middleware/errorHandler.js';

const VALID_STAGES = ['applied', 'screening', 'interview', 'offer', 'accepted', 'rejected', 'ghosted'];
const router = Router();

// GET /  — profile + dismissed IDs for initial load
router.get('/', asyncHandler(async (req, res) => {
  const [user, dismissed] = await Promise.all([
    getUserById(req.user.userId),
    getDismissedJobs(req.user.userId),
  ]);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({
    name: user.name,
    email: user.email,
    picture: user.picture,
    slug: user.slug,
    skills: Array.isArray(user.skills) ? user.skills : [],
    dailyGoal: typeof user.dailyGoal === 'number' ? user.dailyGoal : 5,
    appliedCount: typeof user.appliedCount === 'number' ? user.appliedCount : 0,
    dismissedJobIds: Array.isArray(dismissed) ? dismissed : [],
  });
}));

// PATCH /visit
router.patch('/visit', asyncHandler(async (req, res) => {
  const result = await touchVisit(req.user.userId);
  if (!result) throw new HttpError(404, 'User not found');
  res.json(result);
}));

// ─── Applied ────────────────────────────────────────────────────────
router.get('/applied', asyncHandler(async (req, res) => {
  res.json(await getAppliedJobs(req.user.userId));
}));

router.get('/applied/details', asyncHandler(async (req, res) => {
  res.json(await getAppliedJobDetails(req.user.userId));
}));

router.post('/applied/:jobId', asyncHandler(async (req, res) => {
  // Snapshot the job for resilience: if the listing is later deleted, the
  // user can still see what they applied to.
  let snapshot = {};
  try {
    const job = await findJobById(req.params.jobId);
    if (job) {
      snapshot = {
        jobTitle: job.JobTitle || null,
        company: job.Company || null,
        applicationURL: job.DirectApplyURL || job.ApplicationURL || null,
        location: job.Location || null,
        department: job.Department || null,
      };
    }
  } catch { /* snapshot is optional */ }
  res.json(await addAppliedJob(req.user.userId, req.params.jobId, snapshot));
}));

router.delete('/applied/:jobId', asyncHandler(async (req, res) => {
  res.json(await removeAppliedJob(req.user.userId, req.params.jobId));
}));

router.patch('/applied/:jobId/stage', asyncHandler(async (req, res) => {
  const { stage } = req.body || {};
  if (!stage || typeof stage !== 'string') throw new HttpError(400, 'stage is required');
  if (!VALID_STAGES.includes(stage)) {
    throw new HttpError(400, `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}`);
  }
  const applied = await updateAppliedJobStage(req.user.userId, req.params.jobId, stage);
  if (applied === null) throw new HttpError(404, 'User or applied job not found');
  res.json(applied);
}));

// ─── Skills ─────────────────────────────────────────────────────────
const handleSkills = asyncHandler(async (req, res) => {
  res.json(await updateSkills(req.user.userId, req.body?.skills));
});
router.put('/skills', handleSkills);
router.patch('/skills', handleSkills);

// ─── Comeback (save for later) ──────────────────────────────────────
router.get('/comeback', asyncHandler(async (req, res) => {
  res.json(await getComeBackTo(req.user.userId));
}));

router.post('/comeback/:jobId', asyncHandler(async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '';
  res.json(await upsertComeBackTo(req.user.userId, req.params.jobId, note));
}));

router.delete('/comeback/:jobId', asyncHandler(async (req, res) => {
  res.json(await removeComeBackTo(req.user.userId, req.params.jobId));
}));

// ─── Daily goal ─────────────────────────────────────────────────────
router.patch('/goal', asyncHandler(async (req, res) => {
  const goal = await setDailyGoal(req.user.userId, req.body?.goal);
  if (goal === null) throw new HttpError(404, 'User not found');
  res.json({ dailyGoal: goal });
}));

// ─── Dismissed ──────────────────────────────────────────────────────
router.get('/dismissed', asyncHandler(async (req, res) => {
  res.json(await getDismissedJobs(req.user.userId));
}));

router.post('/dismissed/:jobId', asyncHandler(async (req, res) => {
  res.json(await addDismissedJob(req.user.userId, req.params.jobId));
}));

router.delete('/dismissed/:jobId', asyncHandler(async (req, res) => {
  res.json(await removeDismissedJob(req.user.userId, req.params.jobId));
}));

export default router;
