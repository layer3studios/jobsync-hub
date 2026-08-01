// FILE: src/services/interview/interview-feedback-service.js
// Post-interview feedback: records the verdict, audits it, and SUGGESTS the
// next pipeline action — it never auto-advances or auto-archives. The frontend
// (a human) makes the actual move; this keeps the one stage-move path
// (applicant-move-service) the only writer of stage changes.

import {
  completeInterview as defaultCompleteInterview,
  markInterviewNoShow as defaultMarkNoShow,
} from '../../models/interview/interview-outcome-model.js';
import { INTERVIEW_RECOMMENDATIONS } from '../../models/interview/interview-constants.js';
import { getApplicationForCompany as defaultGetApplication } from '../../models/public/application-model.js';
import { listStagesForCompany as defaultListStages } from '../../models/employer/stage-model.js';
import { AUDIT_EVENTS } from '../../models/dpdp/dpdp-constants.js';
import { appendAudit as defaultAppendAudit } from '../dpdp/audit-log-service.js';

const AUDIT_PURPOSE = 'interview_feedback';
const ARCHIVE_SUGGESTED_REASON = 'Not a fit after interview';

const POSITIVE = [INTERVIEW_RECOMMENDATIONS.STRONG_YES, INTERVIEW_RECOMMENDATIONS.YES];

/**
 * The stage after the application's current one, in pipeline order. If the
 * current stage is the last non-terminal one, suggest the terminal 'hired'
 * stage. Returns a stage id string, or null when nothing sensible exists.
 */
export async function suggestNextStage(companyId, applicationId, deps = {}) {
  const {
    getApplication = defaultGetApplication,
    listStages = defaultListStages,
  } = deps;
  const application = await getApplication(companyId, applicationId);
  if (!application) return null;
  const stages = (await listStages(companyId)).sort((a, b) => a.order - b.order);
  const currentIndex = stages.findIndex((s) => s._id.toString() === application.stageId?.toString());
  if (currentIndex === -1) return null;

  const nonTerminal = stages.filter((s) => !s.isTerminal);
  const isLastNonTerminal = nonTerminal.length > 0
    && nonTerminal[nonTerminal.length - 1]._id.toString() === stages[currentIndex]._id.toString();
  if (isLastNonTerminal) {
    const hired = stages.find((s) => s.terminalType === 'hired');
    return hired ? hired._id.toString() : null;
  }
  const next = stages[currentIndex + 1];
  return next ? next._id.toString() : null;
}

/**
 * Complete + audit + suggest. Returns { error } (caller maps to HTTP) or
 * { interview, nextAction, suggestedStage? / suggestedReason? }.
 */
export async function submitInterviewFeedback(companyId, interviewId, body = {}, deps = {}) {
  const {
    complete = defaultCompleteInterview,
    appendAuditEntry = defaultAppendAudit,
  } = deps;

  const result = await complete(companyId, interviewId, {
    recommendation: body.recommendation,
    feedbackText: body.feedbackText,
    actorUserId: body.actorUserId,
  });
  if (result.error) return result;
  const { interview } = result;

  await appendAuditEntry({
    event: AUDIT_EVENTS.INTERVIEW_COMPLETED, actorType: 'employer', actorId: body.actorUserId,
    targetType: 'interview', targetId: interview._id, purpose: AUDIT_PURPOSE,
    metadata: { recommendation: body.recommendation },
  });

  if (POSITIVE.includes(body.recommendation)) {
    const suggestedStage = await suggestNextStage(companyId, interview.applicationId, deps);
    return { interview, nextAction: 'advance', suggestedStage };
  }
  return { interview, nextAction: 'archive', suggestedReason: ARCHIVE_SUGGESTED_REASON };
}

/** No-show + audit. Returns { error } or { interview, nextAction, message }. */
export async function handleNoShow(companyId, interviewId, body = {}, deps = {}) {
  const {
    markNoShow = defaultMarkNoShow,
    appendAuditEntry = defaultAppendAudit,
  } = deps;

  const result = await markNoShow(companyId, interviewId, {
    note: body.note,
    actorUserId: body.actorUserId,
  });
  if (result.error) return result;

  await appendAuditEntry({
    event: AUDIT_EVENTS.INTERVIEW_NO_SHOW, actorType: 'employer', actorId: body.actorUserId,
    targetType: 'interview', targetId: result.interview._id, purpose: AUDIT_PURPOSE,
    metadata: { note: body.note ?? null },
  });

  return { interview: result.interview, nextAction: 'flag', message: 'Candidate flagged as no-show' };
}
