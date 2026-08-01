// FILE: src/services/employer/posting-defaults-service.js
// Interview defaults on a posting (pool scheduling configuration). Validated
// with the SAME validators as per-candidate interviews. When the meetingUrl
// changes under already-booked pool interviews, each booked candidate gets a
// re-sent .ics (same UID, bumped SEQUENCE) with the new link — best-effort,
// never thrown.

import {
  validateInterviewMode, validateDurationMinutes, validateMeetingLocation,
} from '../../models/interview/interview-validators.js';
import { DEFAULT_INTERVIEW_TIMEZONE } from '../email/calendar-invite-constants.js';
import { updatePostingForCompany as defaultUpdatePosting, getPostingForCompany as defaultGetPosting } from '../../models/employer/posting-model.js';
import { listTimesForPosting as defaultListTimes, INTERVIEW_TIME_STATUSES } from '../../models/interview/interview-time-model.js';
import { updateInterviewMeetingUrl as defaultUpdateMeetingUrl, getInterviewForCompany as defaultGetInterview } from '../../models/interview/interview-model.js';
import { buildInterviewEmailContext as defaultBuildContext } from '../interview/interview-context-helpers.js';
import { sendInterviewConfirmationEmails as defaultSendConfirmations } from '../interview/interview-notification-service.js';

/** Re-send updated invites to every booked pool candidate. Never throws. */
async function resendBookedPoolInvites(companyId, postingId, deps) {
  const {
    listTimes = defaultListTimes,
    getInterview = defaultGetInterview,
    updateMeetingUrl = defaultUpdateMeetingUrl,
    buildContext = defaultBuildContext,
    sendConfirmationEmails = defaultSendConfirmations,
    newMeetingUrl,
  } = deps;
  try {
    const bookedTimes = await listTimes(companyId, postingId, {
      statusFilter: INTERVIEW_TIME_STATUSES.BOOKED, includePast: false,
    });
    for (const time of bookedTimes) {
      if (!time.bookedByInterviewId) continue;
      const updated = await updateMeetingUrl(companyId, time.bookedByInterviewId, newMeetingUrl);
      if (!updated) continue;
      const context = await buildContext(updated, deps);
      if (context) await sendConfirmationEmails(context, deps);
    }
  } catch (err) {
    console.warn(`[interview] booked-pool re-invite failed: ${err.message}`);
  }
}

/**
 * Validate + $set postings.interviewDefaults, scoped to the company. Returns
 * the updated posting or null on a cross-tenant/missing posting.
 */
export async function updateInterviewDefaults(companyId, postingId, defaults, deps = {}) {
  const {
    getPosting = defaultGetPosting,
    updatePosting = defaultUpdatePosting,
  } = deps;

  validateInterviewMode(defaults.mode);
  validateDurationMinutes(defaults.durationMinutes);
  const details = validateMeetingLocation(defaults.mode, defaults.meetingUrl, defaults.locationText, {
    phoneNumber: defaults.phoneNumber,
    phoneCallDirection: defaults.phoneCallDirection,
    arrivalInstructions: defaults.arrivalInstructions,
  });

  const previous = await getPosting(companyId, postingId);
  if (!previous) return null;

  const interviewDefaults = {
    ...details, // meetingUrl / locationText / phoneNumber / phoneCallDirection / arrivalInstructions
    durationMinutes: defaults.durationMinutes,
    mode: defaults.mode,
    timezoneId: defaults.timezoneId || DEFAULT_INTERVIEW_TIMEZONE,
  };
  const posting = await updatePosting(companyId, postingId, { interviewDefaults });
  if (!posting) return null;

  const previousMeetingUrl = previous.interviewDefaults?.meetingUrl ?? null;
  if (details.meetingUrl && details.meetingUrl !== previousMeetingUrl) {
    await resendBookedPoolInvites(companyId, postingId, { ...deps, newMeetingUrl: details.meetingUrl });
  }
  return posting;
}
