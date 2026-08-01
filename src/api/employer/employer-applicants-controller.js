// FILE: src/api/employer/employer-applicants-controller.js
// GET /api/employer/jobs/:postingId/applicants — the employer applicant list for
// one posting (D5, R6). Runs behind requireEmployerPosting, so the company and
// posting are already tenant-verified on the request. Joins are explicit lookup
// chains (no $lookup): list applications → batch-fetch contacts + scores, merge.
// Every read is companyId-scoped (§6.5). Default sort: highest score first.

import {
  listApplicationsForJob, listApplicationsForJobFiltered,
  toPublicApplication, EXPERIENCE_BUCKETS,
} from '../../models/public/application-model.js';
import { countApplicationsForJob } from '../../models/public/application-model.js';
import { getContactForCompany, toPublicContact } from '../../models/public/contact-model.js';
import { listResumeScoresForJob, toPublicResumeScore } from '../../models/public/resume-score-model.js';
import {
  listAssignmentSubmissionsForApplications, getAssignmentSubmissionStatsForJob,
} from '../../models/public/assignment-submission-model.js';
import { listAssignmentReviewsForSubmissions } from '../../models/public/assignment-review-model.js';
import { HttpError } from '../../middleware/error-handler-middleware.js';

const ASSIGNMENT_FILTERS = ['reviewed', 'not_reviewed', 'passed', 'failed'];

/**
 * Sort merged applicant rows.
 *
 * TWO SEPARATE SCORES EXIST and must never be blended: `score.score` is the AI
 * resume score (0-100, banded into tiers) and `assignment.review.overallScore` is
 * a human verdict (1-5). They measure different things on different scales, so
 * there is no meaningful combined value — a sort is by one axis or the other.
 */
function sortApplicants(applicants, sort) {
  const sorted = [...applicants];
  if (sort === 'date') {
    sorted.sort((first, second) => new Date(second.application.appliedAt) - new Date(first.application.appliedAt));
  } else if (sort === 'assignment') {
    // Reviewed rows by score desc, then unreviewed submissions, then no submission.
    const rank = (row) => {
      if (!row.assignment) return -2;          // no submission at all — last
      if (!row.assignment.review) return -1;   // submitted but unreviewed
      return row.assignment.review.overallScore;
    };
    sorted.sort((first, second) => rank(second) - rank(first));
  } else {
    sorted.sort((first, second) => (second.score?.score ?? -1) - (first.score?.score ?? -1));
  }
  return sorted;
}

/** Keep only rows matching the assignmentReview filter. Rows without a submission never match. */
function filterByAssignmentReview(applicants, filter) {
  if (!filter) return applicants;
  return applicants.filter((row) => {
    if (!row.assignment) return false; // a legacy row satisfies none of these
    const review = row.assignment.review;
    if (filter === 'reviewed') return Boolean(review);
    if (filter === 'not_reviewed') return !review;
    if (filter === 'passed') return Boolean(review?.passesBar);
    if (filter === 'failed') return Boolean(review) && !review.passesBar;
    return true;
  });
}

const csv = (v) => typeof v === 'string'
  ? v.split(',').map((t) => t.trim()).filter(Boolean)
  : [];

/** Parse the advanced filter params. Returns null when none are active. */
function parseAdvancedFilters(query) {
  const filters = {};
  const buckets = csv(query.experience).filter((b) => b in EXPERIENCE_BUCKETS);
  if (buckets.length > 0) filters.experienceBuckets = buckets;
  const skills = csv(query.skills).slice(0, 10);
  if (skills.length > 0) filters.skills = skills;
  const locations = csv(query.locations).slice(0, 10);
  if (locations.length > 0) filters.locations = locations;
  if (['24h', '7d', '30d'].includes(query.appliedWithin)) filters.appliedWithin = query.appliedWithin;
  if (query.hasResume === 'true') filters.hasResume = true;
  if (query.hasNotes === 'true') filters.hasNotes = true;
  return Object.keys(filters).length > 0 ? filters : null;
}

export async function listApplicantsForPosting(req, res) {
  const companyId = req.employerCompanyId;
  const jobId = req.posting._id;

  const filters = {};
  if (req.query.stageId) filters.stageId = req.query.stageId;
  if (req.query.archived === 'false') filters.archived = false;

  // Advanced filters use the aggregation path; the plain path is untouched so
  // existing behavior (pipeline tab, unfiltered ranked list) cannot regress.
  const advanced = parseAdvancedFilters(req.query);
  const applications = advanced
    ? await listApplicationsForJobFiltered(companyId, jobId, { ...filters, ...advanced })
    : await listApplicationsForJob(companyId, jobId, filters);

  const applicationIds = applications.map((application) => application._id);
  const contactIds = [...new Set(
    applications.map((application) => application.contactId?.toString()).filter(Boolean),
  )];
  const contacts = await Promise.all(contactIds.map((contactId) => getContactForCompany(companyId, contactId)));
  const contactById = new Map(contacts.filter(Boolean).map((contact) => [contact._id.toString(), contact]));

  const scores = await listResumeScoresForJob(companyId, jobId, applicationIds);
  const scoreByApplicationId = new Map(scores.map((score) => [score.applicationId.toString(), score]));

  const merged = applications.map((application) => {
    const contact = contactById.get(application.contactId?.toString()) ?? null;
    const score = scoreByApplicationId.get(application._id.toString()) ?? null;
    return {
      application: toPublicApplication(application),
      contact: contact ? toPublicContact(contact) : null,
      score: score ? toPublicResumeScore(score) : null,
    };
  });

  // GUARD FIRST. A posting with no assignment runs zero assignment queries and
  // returns exactly the shape it always has — no `assignment` key on rows, no
  // `stats`. Everything below this branch is additive for assignment postings only.
  if (!req.posting.assignmentId) {
    const sort = req.query.sort === 'date' ? 'date' : 'score';
    return res.json({ applicants: sortApplicants(merged, sort) });
  }

  const assignmentFilter = req.query.assignmentReview;
  if (assignmentFilter !== undefined && !ASSIGNMENT_FILTERS.includes(assignmentFilter)) {
    throw new HttpError(400, `assignmentReview must be one of: ${ASSIGNMENT_FILTERS.join(', ')}`, 'INVALID_ASSIGNMENT_FILTER');
  }

  const submissions = await listAssignmentSubmissionsForApplications(companyId, applicationIds);
  const reviews = await listAssignmentReviewsForSubmissions(
    companyId, submissions.map((submission) => submission._id),
  );
  const reviewBySubmissionId = new Map(
    reviews.map((review) => [review.assignmentSubmissionId.toString(), review]),
  );
  const submissionByApplicationId = new Map(
    submissions.map((submission) => [submission.applicationId.toString(), submission]),
  );

  for (const row of merged) {
    const submission = submissionByApplicationId.get(row.application.id) ?? null;
    const review = submission ? reviewBySubmissionId.get(submission._id.toString()) ?? null : null;
    // A NEW key. `score` (the AI resume score) is left exactly as it was.
    row.assignment = submission
      ? {
          submissionId: submission._id.toString(),
          submittedAt: submission.submittedAt ?? null,
          linkCount: (submission.links ?? []).length,
          fileCount: (submission.files ?? []).length,
          review: review
            ? {
                overallScore: review.overallScore,
                passesBar: Boolean(review.passesBar),
                reviewedAt: review.reviewedAt ?? null,
              }
            : null,
        }
      : null;
  }

  /*
   * STATS DESCRIBE THE POSTING, NOT THE VIEW.
   *
   * They come from their own aggregation across ALL applications for this posting,
   * never from reducing `merged`. They also deliberately ignore assignmentReview:
   * the strip summarises where the posting stands, not what is on screen. So a
   * filtered response can correctly return stats.total: 47 beside a single row.
   * Chunk 7 must label it "47 applications", never "showing 47".
   */
  const [total, submissionStats] = await Promise.all([
    countApplicationsForJob(companyId, jobId),
    getAssignmentSubmissionStatsForJob(companyId, jobId),
  ]);
  const stats = { total, ...submissionStats };

  const sortKey = ['date', 'assignment'].includes(req.query.sort) ? req.query.sort : 'score';
  const visible = filterByAssignmentReview(merged, assignmentFilter);
  res.json({ applicants: sortApplicants(visible, sortKey), stats });
}

/** Non-city noise seen in free-text contact locations. */
const NON_CITY = new Set(['remote', 'india', 'n/a', 'na', 'anywhere', 'wfh', 'work from home', '']);

function extractCity(raw) {
  if (typeof raw !== 'string') return null;
  const seg = raw.split(/[,/|]/)[0].trim().replace(/\s+/g, ' ');
  if (seg.length < 2 || seg.length > 40 || NON_CITY.has(seg.toLowerCase())) return null;
  return seg;
}

function topCounts(map, cap) {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, cap);
}

function countInto(map, value) {
  const key = value.toLowerCase();
  const entry = map.get(key);
  if (entry) entry.count += 1;
  else map.set(key, { value, count: 1 });
}

/**
 * GET .../applicants/facets — filter options scoped to THIS posting:
 * top 30 skills (from AI score matched+bonus skills) and top 20 applicant
 * cities (from contact locations).
 */
export async function listApplicantFacetsForPosting(req, res) {
  const companyId = req.employerCompanyId;
  const jobId = req.posting._id;

  const applications = await listApplicationsForJob(companyId, jobId, {});
  const applicationIds = applications.map((application) => application._id);
  const contactIds = [...new Set(
    applications.map((application) => application.contactId?.toString()).filter(Boolean),
  )];

  const [scores, contacts] = await Promise.all([
    listResumeScoresForJob(companyId, jobId, applicationIds),
    Promise.all(contactIds.map((contactId) => getContactForCompany(companyId, contactId))),
  ]);

  const skillCounts = new Map();
  for (const score of scores) {
    const pool = [...(score.matchedSkills ?? []), ...(score.bonusSkills ?? [])];
    for (const skill of new Set(pool.map((s) => String(s).trim()).filter(Boolean))) {
      countInto(skillCounts, skill);
    }
  }

  const cityCounts = new Map();
  for (const contact of contacts) {
    const city = contact ? extractCity(contact.location) : null;
    if (city) countInto(cityCounts, city);
  }

  res.json({
    skills: topCounts(skillCounts, 30).map((e) => ({ skill: e.value, count: e.count })),
    cities: topCounts(cityCounts, 20).map((e) => ({ city: e.value, count: e.count })),
  });
}

export default listApplicantsForPosting;
