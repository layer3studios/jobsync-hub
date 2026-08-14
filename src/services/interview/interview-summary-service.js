// FILE: src/services/interview/interview-summary-service.js
// Aggregates every interviewer's verdict on one candidate into a single read.
//
// FEEDBACK LIVES ON THE INTERVIEW ROW. completeInterview writes `recommendation`
// and `feedbackText` onto the interview itself, so "all outcomes for this
// application" is one companyId-scoped read of the interviews collection — there is
// no separate outcomes collection to join.
//
// ANTI-BIAS IS COMPUTED HERE, NOT IN THE UI. Whether the viewer may see who said
// what is a property of the data, so the server decides it and simply omits the
// per-interviewer detail when the answer is no. A client-side hide would ship every
// teammate's verdict to a browser that has been told not to show it, which is not a
// control at all — it is a CSS suggestion.

import { listInterviewsForApplication } from '../../models/interview/interview-model.js';
import { INTERVIEW_STATUSES, INTERVIEW_RECOMMENDATIONS } from '../../models/interview/interview-constants.js';
import { getEmployerUserById } from '../../models/employer/employer-user-model.js';

const NOTE_PREVIEW_LENGTH = 100;

const POSITIVE = [INTERVIEW_RECOMMENDATIONS.STRONG_YES, INTERVIEW_RECOMMENDATIONS.YES];
const NEGATIVE = [INTERVIEW_RECOMMENDATIONS.NO, INTERVIEW_RECOMMENDATIONS.STRONG_NO];

/** An interview that still owes feedback: booked, in the past, no recommendation. */
function isAwaitingFeedback(interview) {
  return interview.status === INTERVIEW_STATUSES.SCHEDULED && !interview.recommendation;
}

/** Cancelled interviews are excluded everywhere — a call that did not happen is not a data point. */
const counts = (interviews) => interviews.reduce((tally, interview) => {
  if (interview.recommendation) tally[interview.recommendation] = (tally[interview.recommendation] ?? 0) + 1;
  return tally;
}, {});

/**
 * One word for the panel.
 *
 * MAJORITY, NOT AVERAGE. Averaging a four-point scale invents a precision the
 * scale does not have, and it hides exactly the case a hiring manager most needs to
 * see: a genuine split. A tie is "Mixed", stated plainly, rather than rounded into
 * a decision nobody made.
 */
export function overallSignalFor(recommendationCounts) {
  const strongYes = recommendationCounts[INTERVIEW_RECOMMENDATIONS.STRONG_YES] ?? 0;
  const yes = recommendationCounts[INTERVIEW_RECOMMENDATIONS.YES] ?? 0;
  const positives = strongYes + yes;
  const negatives = NEGATIVE.reduce((sum, key) => sum + (recommendationCounts[key] ?? 0), 0);
  if (positives + negatives === 0) return null;
  if (negatives === 0 && strongYes >= yes) return 'strong_hire';
  if (positives > negatives) return 'hire';
  if (negatives > positives) return 'no_hire';
  return 'mixed';
}

/** First 100 chars on one line, ellipsised only when something was actually cut. */
export function notePreviewOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > NOTE_PREVIEW_LENGTH ? `${flat.slice(0, NOTE_PREVIEW_LENGTH).trimEnd()}…` : flat;
}

/** Who ran this interview: the named panel, else whoever scheduled it. */
function interviewerIdsFor(interview) {
  const panel = (interview.interviewerEmployerUserIds ?? []).filter(Boolean);
  return panel.length > 0 ? panel : [interview.createdByEmployerUserId].filter(Boolean);
}

/**
 * Aggregate the panel's verdicts on one application.
 *
 * `viewerEmployerUserId` drives the anti-bias hold: a viewer who is on a panel that
 * still owes feedback gets counts and nothing else. Pass null (a manager who is not
 * interviewing) and the full detail comes back — the hold exists to stop a pending
 * interviewer anchoring on a colleague, not to keep the panel secret.
 *
 * Returns null when this application has no interviews at all, which is the caller's
 * signal to render nothing rather than an empty card.
 */
export async function getInterviewSummary(companyId, applicationId, { viewerEmployerUserId = null } = {}) {
  const all = await listInterviewsForApplication(companyId, applicationId);
  const interviews = all.filter((interview) => interview.status !== INTERVIEW_STATUSES.CANCELLED);
  if (interviews.length === 0) return null;

  const withFeedback = interviews.filter((interview) => Boolean(interview.recommendation));
  const recommendations = counts(withFeedback);

  // Held back only when the VIEWER personally owes feedback on this candidate.
  const viewerId = viewerEmployerUserId ? String(viewerEmployerUserId) : null;
  const viewerOwesFeedback = Boolean(viewerId) && interviews.some((interview) => (
    isAwaitingFeedback(interview)
    && interviewerIdsFor(interview).some((id) => String(id) === viewerId)
  ));

  const entries = await Promise.all(interviews.map(async (interview) => {
    const [firstInterviewerId] = interviewerIdsFor(interview);
    const interviewer = firstInterviewerId ? await getEmployerUserById(firstInterviewerId) : null;
    return {
      interviewId: interview._id.toString(),
      interviewerName: interviewer?.name ?? interviewer?.email ?? 'Interviewer',
      interviewerUserId: firstInterviewerId ? String(firstInterviewerId) : null,
      interviewerAvatarUrl: interviewer?.avatarUrl ?? interviewer?.picture ?? null,
      recommendation: interview.recommendation ?? null,
      notePreview: notePreviewOf(interview.feedbackText),
      feedbackText: interview.feedbackText ?? null,
      completedAt: interview.completedAt ?? null,
      status: interview.status,
    };
  }));

  return {
    totalInterviews: interviews.length,
    completedInterviews: withFeedback.length,
    recommendations,
    overallSignal: overallSignalFor(recommendations),
    // No numeric scorecards exist in this model — the scale is the four-point
    // recommendation. Declared null rather than omitted so the client has one shape.
    averageScore: null,
    viewerOwesFeedback,
    // The whole reason the hold works: the detail is not in the payload at all.
    feedbackSummaries: viewerOwesFeedback ? [] : entries,
  };
}

export default getInterviewSummary;
