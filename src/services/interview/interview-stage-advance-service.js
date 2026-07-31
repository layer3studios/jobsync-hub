// FILE: src/services/interview/interview-stage-advance-service.js
// Best-effort pipeline auto-advance: when a candidate books a slot, move the
// application to the company's "Interview" stage (matched case-insensitively by
// name). Reuses moveApplicantToStage — the ONE move path — so the stage_change
// history stays accurate; movedByUserId is null because the move is attributable
// to the booking, not to a person. Every failure is logged and swallowed: a
// renamed/deleted stage, an archived application, or any error must never fail
// the booking.

import { listStagesForCompany as defaultListStages } from '../../models/employer/stage-model.js';
import { getApplicationForCompany as defaultGetApplication } from '../../models/public/application-model.js';
import { moveApplicantToStage as defaultMoveApplicant } from '../employer/applicant-move-service.js';

const INTERVIEW_STAGE_NAME = 'interview';
const AUTO_MOVE_NOTE = 'Moved automatically when the candidate booked an interview';

/**
 * Returns { moved, reason } and never throws. Never moves an application
 * backwards: if it already sits at or past the Interview stage, it stays put.
 */
export async function advanceApplicationToInterviewStage(companyId, applicationId, deps = {}) {
  const {
    listStages = defaultListStages,
    getApplication = defaultGetApplication,
    moveApplicant = defaultMoveApplicant,
  } = deps;

  try {
    const stages = await listStages(companyId);
    const interviewStage = stages.find(
      (stage) => String(stage.text ?? '').trim().toLowerCase() === INTERVIEW_STAGE_NAME,
    );
    if (!interviewStage) {
      console.log('[interview] no "Interview" stage configured for this company — skipping auto-advance');
      return { moved: false, reason: 'NO_INTERVIEW_STAGE' };
    }

    const application = await getApplication(companyId, applicationId);
    if (!application) return { moved: false, reason: 'APPLICATION_NOT_FOUND' };

    const currentStage = stages.find(
      (stage) => stage._id.toString() === application.stageId?.toString(),
    );
    if (currentStage && currentStage.order >= interviewStage.order) {
      return { moved: false, reason: 'ALREADY_AT_OR_PAST_INTERVIEW' };
    }

    await moveApplicant(
      companyId, applicationId,
      { stageId: interviewStage._id.toString(), note: AUTO_MOVE_NOTE },
      null,
    );
    return { moved: true, reason: null };
  } catch (err) {
    console.warn(`[interview] stage auto-advance failed: ${err.message}`);
    return { moved: false, reason: 'ERROR' };
  }
}
