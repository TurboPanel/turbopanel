/**
 * Display-name labels (org / project / workspace / environment / …).
 * These are not identifiers — routes and compose keys use UUIDs. There is no
 * charset restriction, and the database no longer enforces this rule.
 *
 * Typographic quotes from iOS/macOS are folded to ASCII `'` before persist
 * so uniqueness stays stable across input methods.
 */

/** App-side cap for `name` / `displayName` labels. Not a DB CHECK. */
export const DISPLAY_NAME_MAX_LENGTH = 255;

/** App-side cap for optional `description` fields. Not a DB CHECK. */
export const DESCRIPTION_MAX_LENGTH = 255;

/**
 * Rejection-only: Unicode C0/C1 controls, DEL, NUL (in C0), and Unicode
 * line/paragraph separators. Nothing else is disallowed.
 */
const DISPLAY_NAME_CONTROL_CHARS_RE =
  // deno-lint-ignore no-control-regex -- matching control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

const LEFT_SINGLE_QUOTE = "\u2018";
const RIGHT_SINGLE_QUOTE = "\u2019";
const MODIFIER_LETTER_APOSTROPHE = "\u02BC";

/** Code-point length so astral characters and emoji are not double-counted. */
export function displayNameCodePointLength(value: string): number {
  return [...value].length;
}

export function hasDisallowedDisplayNameChars(value: string): boolean {
  return DISPLAY_NAME_CONTROL_CHARS_RE.test(value);
}

/** Fold typographic apostrophes to ASCII `'` so uniqueness agrees. */
export function foldDisplayNameApostrophes(name: string): string {
  return name
    .replaceAll(LEFT_SINGLE_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_QUOTE, "'")
    .replaceAll(MODIFIER_LETTER_APOSTROPHE, "'");
}

export function normalizeDisplayName(name: string): string {
  return foldDisplayNameApostrophes(name.trim().normalize("NFC"));
}

/** Trim + NFC + apostrophe-fold + lowercase key for uniqueness compares. */
export function normalizeDisplayNameKey(name: string): string {
  return normalizeDisplayName(name).toLowerCase();
}

export function isValidDisplayName(name: string): boolean {
  const length = displayNameCodePointLength(name);
  return (
    length >= 1 &&
    length <= DISPLAY_NAME_MAX_LENGTH &&
    !hasDisallowedDisplayNameChars(name)
  );
}

/** Empty is allowed (callers map it to null). Control chars and over-length are not. */
export function isValidDescription(description: string): boolean {
  return (
    displayNameCodePointLength(description) <= DESCRIPTION_MAX_LENGTH &&
    !hasDisallowedDisplayNameChars(description)
  );
}
