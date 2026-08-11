// FILE: src/services/employer/resume-parse-heuristics.js
// Name + email guessing for bulk-imported resumes. Heuristics, not parsing: this
// runs before any AI scoring and only has to get a recruiter to a recognizable row.
// Everything it produces is overwritable by hand afterwards.

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Header noise that sits above or beside a name on real resumes.
const NOT_A_NAME = /(resume|curriculum|vitae|cv|profile|portfolio|phone|email|linkedin|github|address|http|www\.|@|\d{4})/i;

/** The first email address in the text, lowercased. null when there is none. */
export function findEmail(text) {
  const match = EMAIL_PATTERN.exec(String(text ?? ''));
  return match ? match[0].toLowerCase() : null;
}

/**
 * The candidate's name, guessed from the first few lines. A resume almost always
 * opens with it, so we take the first short line of 1–4 title-ish words that
 * carries none of the header noise above.
 */
export function findName(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).slice(0, 12);
  for (const line of lines) {
    if (!line || line.length > 60 || NOT_A_NAME.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) continue;
    if (!words.every((word) => /^[A-Za-z][A-Za-z'.-]*$/.test(word))) continue;
    return line.replace(/\s+/g, ' ');
  }
  return null;
}

/** Split a guessed name into first/last. A single word is the first name. */
export function splitGuessedName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || null };
}

/** A filename reduced to a safe local-part for the placeholder address. */
function emailSafeStem(filename) {
  const stem = String(filename ?? 'candidate').replace(/\.[^.]+$/, '');
  const safe = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return safe || 'candidate';
}

/**
 * A stand-in address for a resume that names no email. `.local` is reserved and
 * unroutable by design, so nothing here can ever be mailed by accident, and the
 * filename keeps it unique within the batch AND recognizable in the list.
 */
export const placeholderEmail = (filename) => `${emailSafeStem(filename)}@imported.local`;

/** Everything the importer needs from one resume's text. */
export function parseResumeIdentity(text, filename) {
  const name = findName(text);
  const { firstName, lastName } = splitGuessedName(name);
  const email = findEmail(text);
  return {
    firstName: firstName ?? emailSafeStem(filename),
    lastName,
    email: email ?? placeholderEmail(filename),
    emailWasGuessed: !email,
  };
}
