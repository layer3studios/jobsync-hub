import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewParsedProfile, SECTIONS, SEVERITIES } from '../../src/gemma/review-resume.js';

/** A mock Gemma client whose generateContent returns a preset raw string. */
function mockClient(raw, capture) {
  return {
    generateContent: async (system, user) => {
      if (capture) { capture.system = system; capture.user = user; }
      return raw;
    },
  };
}

const PROFILE = { fullName: 'Asha', experience: [{ responsibilities: ['Improved system performance.'] }] };

function validRaw(over = {}) {
  return JSON.stringify({
    scores: { parseability: 80, contentStrength: 60, indiaMarketFit: 70, skillsDepth: 50, overall: 99 },
    strengths: ['Strong Node.js depth', 'Clear structure'],
    findings: [{ section: SECTIONS.EXPERIENCE, severity: SEVERITIES.WARNING, message: 'Weak verb used', sourceEvidence: 'Improved system performance.' }],
    topImprovements: [{ title: 'Quantify impact', why: 'Numbers signal scope', observedBullet: 'Improved system performance.', question: 'By what percentage, against what baseline, over what timeframe?' }],
    ...over,
  });
}

test('valid Gemma response normalizes into the full shape', async () => {
  const out = await reviewParsedProfile(PROFILE, mockClient(validRaw()));
  assert.deepEqual(Object.keys(out.scores).sort(), ['contentStrength', 'indiaMarketFit', 'overall', 'parseability', 'skillsDepth']);
  assert.equal(out.strengths.length, 2);
  assert.equal(out.findings[0].section, 'EXPERIENCE');
  assert.equal(out.findings[0].sourceEvidence, 'Improved system performance.');
  assert.equal(out.topImprovements[0].title, 'Quantify impact');
  assert.ok(typeof out.reviewedAt === 'string');
  assert.ok(typeof out.modelVersion === 'string' && out.modelVersion.length > 0);
});

test('findings with an unknown enum value are dropped, not thrown', async () => {
  const raw = validRaw({
    findings: [
      { section: 'NONSENSE', severity: 'warning', message: 'bad section' },
      { section: 'SKILLS', severity: 'apocalyptic', message: 'bad severity' },
      { section: 'SKILLS', severity: 'info', message: 'kept' },
    ],
  });
  const out = await reviewParsedProfile(PROFILE, mockClient(raw));
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].message, 'kept');
});

test('topImprovements accept only the four whitelisted keys (no ghostwriting fields)', async () => {
  const raw = validRaw({
    topImprovements: [{
      title: 'Quantify impact', why: 'matters', observedBullet: 'x', question: 'How much?',
      rewrittenBullet: 'Improved system performance by 40%', ghostwrite: 'nope',
    }],
  });
  const out = await reviewParsedProfile(PROFILE, mockClient(raw));
  assert.deepEqual(Object.keys(out.topImprovements[0]).sort(), ['observedBullet', 'question', 'title', 'why']);
});

test('scores out of range are clamped to [0,100]', async () => {
  const raw = validRaw({ scores: { parseability: 150, contentStrength: -20, indiaMarketFit: 70, skillsDepth: 50 } });
  const out = await reviewParsedProfile(PROFILE, mockClient(raw));
  assert.equal(out.scores.parseability, 100);
  assert.equal(out.scores.contentStrength, 0);
});

test('overall is recomputed in code, ignoring Gemma\'s own overall', async () => {
  const raw = validRaw({ scores: { parseability: 50, contentStrength: 100, indiaMarketFit: 0, skillsDepth: 0, overall: 99 } });
  const out = await reviewParsedProfile(PROFILE, mockClient(raw));
  // 100*0.35 + 0*0.25 + 0*0.20 + 50*0.20 = 45
  assert.equal(out.scores.overall, 45);
});

test('malformed JSON with a valid inner {...} block still parses', async () => {
  const raw = 'Here is your review:\n```json\n' + validRaw() + '\n```\nHope it helps!';
  const out = await reviewParsedProfile(PROFILE, mockClient(raw));
  assert.equal(out.scores.parseability, 80);
});

test('totally unparseable output throws', async () => {
  await assert.rejects(() => reviewParsedProfile(PROFILE, mockClient('no json here at all')));
});

test('throws when no client is provided', async () => {
  await assert.rejects(() => reviewParsedProfile(PROFILE, null));
});
