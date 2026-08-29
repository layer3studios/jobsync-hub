// FILE: src/models/admin/alert-settings-model.js
// alert_settings collection — a single config doc (_id: 'config'), mirroring
// feature-flags-model's singleton pattern.
//
// DEFAULT OFF, unlike the feature flags. A flag defaults open because the
// product must run without an admin panel; alerting defaults closed because an
// unconfigured install must never start emailing people on its own.

import { col } from '../../Db/connection.js';
import { appendAudit } from '../../services/dpdp/audit-log-service.js';
import { AUDIT_EVENTS } from '../dpdp/dpdp-constants.js';

const CONFIG_ID = 'config';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ALERT_EMAILS = 10;

const settingsCol = () => col('alert_settings');

export const DEFAULT_ALERT_SETTINGS = Object.freeze({
  alertsEnabled: false,
  dailyTokenThreshold: 1_000_000,
  errorRateThresholdPct: 20,
  alertEmails: [],
});

/** Full settings, with defaults for a missing doc. */
export async function getAlertSettings() {
  const collection = await settingsCol();
  const doc = await collection.findOne({ _id: CONFIG_ID });
  if (!doc) return { ...DEFAULT_ALERT_SETTINGS, lastAlertSentAt: null, updatedAt: null };
  return {
    alertsEnabled: doc.alertsEnabled === true,
    dailyTokenThreshold: Number.isFinite(doc.dailyTokenThreshold)
      ? doc.dailyTokenThreshold : DEFAULT_ALERT_SETTINGS.dailyTokenThreshold,
    errorRateThresholdPct: Number.isFinite(doc.errorRateThresholdPct)
      ? doc.errorRateThresholdPct : DEFAULT_ALERT_SETTINGS.errorRateThresholdPct,
    alertEmails: Array.isArray(doc.alertEmails) ? doc.alertEmails : [],
    lastAlertSentAt: doc.lastAlertSentAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

/** Validate an incoming patch. Returns { ok, patch } or { ok: false, reason }. */
export function validateAlertPatch(patch = {}) {
  const next = {};
  if ('alertsEnabled' in patch) {
    if (typeof patch.alertsEnabled !== 'boolean') return { ok: false, reason: 'invalid_alertsEnabled' };
    next.alertsEnabled = patch.alertsEnabled;
  }
  if ('dailyTokenThreshold' in patch) {
    const value = Number(patch.dailyTokenThreshold);
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: 'invalid_dailyTokenThreshold' };
    next.dailyTokenThreshold = Math.trunc(value);
  }
  if ('errorRateThresholdPct' in patch) {
    const value = Number(patch.errorRateThresholdPct);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { ok: false, reason: 'invalid_errorRateThresholdPct' };
    }
    next.errorRateThresholdPct = value;
  }
  if ('alertEmails' in patch) {
    if (!Array.isArray(patch.alertEmails)) return { ok: false, reason: 'invalid_alertEmails' };
    const emails = [...new Set(
      patch.alertEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean),
    )];
    if (emails.length > MAX_ALERT_EMAILS) return { ok: false, reason: 'too_many_alertEmails' };
    if (emails.some((email) => !EMAIL_PATTERN.test(email))) return { ok: false, reason: 'invalid_alertEmails' };
    next.alertEmails = emails;
  }
  if (Object.keys(next).length === 0) return { ok: false, reason: 'empty_patch' };
  return { ok: true, patch: next };
}

/** Apply a validated patch and audit it. Returns the post-write settings. */
export async function setAlertSettings(patch, adminUserId) {
  const validated = validateAlertPatch(patch);
  if (!validated.ok) return { ok: false, reason: validated.reason };

  const before = await getAlertSettings();
  const collection = await settingsCol();
  await collection.updateOne(
    { _id: CONFIG_ID },
    { $set: { ...validated.patch, updatedAt: new Date(), updatedByAdminUserId: adminUserId ?? null } },
    { upsert: true },
  );

  const after = await getAlertSettings();
  await appendAudit({
    event: AUDIT_EVENTS.ALERT_SETTINGS_CHANGED,
    actorType: 'admin', actorId: adminUserId ?? null,
    targetType: 'alert_settings', targetId: null,
    // Recipient addresses are recorded as a COUNT, not a list — an audit row
    // should not become a mailing list.
    metadata: {
      changed: Object.keys(validated.patch),
      alertsEnabled: after.alertsEnabled,
      dailyTokenThreshold: after.dailyTokenThreshold,
      errorRateThresholdPct: after.errorRateThresholdPct,
      alertEmailCount: after.alertEmails.length,
      previousAlertsEnabled: before.alertsEnabled,
    },
  });
  return { ok: true, settings: after };
}

/** Stamp the cooldown clock after an alert goes out. Never audited — noise. */
export async function markAlertSent(now = new Date()) {
  const collection = await settingsCol();
  await collection.updateOne({ _id: CONFIG_ID }, { $set: { lastAlertSentAt: now } }, { upsert: true });
}

export default getAlertSettings;
