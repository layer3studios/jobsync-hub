// FILE: tests/services/send-email-service.test.js
// Pure unit tests — no database, no network. The Resend client is always an
// injected fake; the service's contract is that it never rejects.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendTransactionalEmail } from '../../src/services/email/send-email-service.js';
import { EMAIL_ERROR_CODES } from '../../src/services/email/email-constants.js';

/** A fake Resend client that records the send() call and returns `response`. */
function fakeClient(response = { data: { id: 'email_123' }, error: null }) {
  const calls = [];
  return {
    calls,
    emails: {
      send: async (payload, options) => { calls.push({ payload, options }); return response; },
    },
  };
}

const BASE_INPUT = { to: 'candidate@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

test('EMAIL_ENABLED false → EMAIL_DISABLED without touching the client', async () => {
  let clientRequested = false;
  const result = await sendTransactionalEmail(BASE_INPUT, {
    emailEnabled: false,
    getEmailClient: () => { clientRequested = true; return fakeClient(); },
  });
  assert.deepEqual(result, { sent: false, code: EMAIL_ERROR_CODES.EMAIL_DISABLED, emailId: null });
  assert.equal(clientRequested, false);
});

test('null client → EMAIL_NOT_CONFIGURED, never throws', async () => {
  const result = await sendTransactionalEmail(BASE_INPUT, { getEmailClient: () => null });
  assert.deepEqual(result, { sent: false, code: EMAIL_ERROR_CODES.EMAIL_NOT_CONFIGURED, emailId: null });
});

test('invalid recipient → INVALID_RECIPIENT without calling the client', async () => {
  const client = fakeClient();
  for (const to of ['', '   ', 'no-at-sign', null, undefined, 42]) {
    const result = await sendTransactionalEmail({ ...BASE_INPUT, to }, { getEmailClient: () => client });
    assert.equal(result.sent, false);
    assert.equal(result.code, EMAIL_ERROR_CODES.INVALID_RECIPIENT);
  }
  assert.equal(client.calls.length, 0);
});

test('happy path builds the from string and returns the emailId', async () => {
  const client = fakeClient({ data: { id: 'email_abc' }, error: null });
  const result = await sendTransactionalEmail(BASE_INPUT, { getEmailClient: () => client });
  assert.deepEqual(result, { sent: true, code: null, emailId: 'email_abc' });
  assert.equal(client.calls.length, 1);
  const { payload } = client.calls[0];
  assert.equal(payload.from, 'JobMesh <hello@jobmesh.in>');
  assert.equal(payload.to, 'candidate@example.com');
  assert.equal(payload.subject, 'Hi');
});

test('a throwing client → SEND_FAILED, no rejection', async () => {
  const client = { emails: { send: async () => { throw new Error('boom'); } } };
  const result = await sendTransactionalEmail(BASE_INPUT, { getEmailClient: () => client });
  assert.deepEqual(result, { sent: false, code: EMAIL_ERROR_CODES.SEND_FAILED, emailId: null });
});

test('a Resend error response → SEND_FAILED, no rejection', async () => {
  const client = fakeClient({ data: null, error: { name: 'invalid_from_address', message: 'bad from' } });
  const result = await sendTransactionalEmail(BASE_INPUT, { getEmailClient: () => client });
  assert.deepEqual(result, { sent: false, code: EMAIL_ERROR_CODES.SEND_FAILED, emailId: null });
});

test('attachments and contentType forwarded unchanged; idempotencyKey in options', async () => {
  const client = fakeClient();
  const attachments = [{ filename: 'interview.ics', content: 'QkFTRTY0', contentType: 'text/calendar; charset=utf-8; method=REQUEST' }];
  await sendTransactionalEmail(
    { ...BASE_INPUT, attachments, idempotencyKey: 'invite-1' },
    { getEmailClient: () => client },
  );
  const { payload, options } = client.calls[0];
  assert.deepEqual(payload.attachments, attachments);
  assert.equal(options.idempotencyKey, 'invite-1');
});
