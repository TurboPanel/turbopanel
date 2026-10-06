/**
 * Which Node major series a version range written by an app's author allows.
 *
 * Reads the range grammar npm uses for `engines.node` (and the bare versions
 * `.nvmrc` / `.node-version` hold): `>=26.7.0`, `^22`, `~22.1`, `22.x`, `22`,
 * `*`, `20 || 22`, `>=22.5 <22.8`, `20 - 24`, with an optional `v` prefix and
 * prerelease / build suffixes ignored. Parsed by hand rather than with one
 * large pattern: each alternative becomes one half-open interval of versions,
 * and a series is allowed when its `[major.0.0, (major+1).0.0)` overlaps one.
 *
 * Pure: no runtime APIs, safe on every runtime.
 */

type Version = readonly [number, number, number]

/** `[lo, hi)`; `hi === null` is unbounded. */
type Interval = { lo: Version; hi: Version | null }

/** A version as written: the numbers given before the first wildcard. */
type WrittenVersion = { parts: number[] }

const ZERO: Version = [0, 0, 0]
const EVERYTHING: Interval = { lo: ZERO, hi: null }
const NOTHING: Interval = { lo: ZERO, hi: ZERO }
const MAX_COMPONENT_DIGITS = 9

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function floorOf(written: WrittenVersion): Version {
  const [major = 0, minor = 0, patch = 0] = written.parts
  return [major, minor, patch]
}

/** The first version past everything `written` names when `count` parts are kept. */
function nextAfter(written: WrittenVersion, count: number): Version {
  const [major = 0, minor = 0, patch = 0] = written.parts
  if (count <= 1) return [major + 1, 0, 0]
  if (count === 2) return [major, minor + 1, 0]
  return [major, minor, patch + 1]
}

function isDigits(value: string): boolean {
  if (value.length === 0 || value.length > MAX_COMPONENT_DIGITS) return false
  for (const ch of value) {
    if (ch < '0' || ch > '9') return false
  }
  return true
}

function isWildcard(value: string): boolean {
  return value === 'x' || value === 'X' || value === '*'
}

/** Cut a prerelease (`-rc.1`) or build (`+sha`) suffix off a version. */
function withoutSuffix(value: string): string {
  let end = value.length
  for (const marker of ['-', '+']) {
    const at = value.indexOf(marker)
    if (at !== -1 && at < end) end = at
  }
  return value.slice(0, end)
}

/** `22`, `v22.1`, `22.x`, `*`, `22.1.0-rc.1` → the numbers given, or null (`20-24`). */
function parseWrittenVersion(raw: string): WrittenVersion | null {
  let text = raw
  if (text.startsWith('v') || text.startsWith('V')) text = text.slice(1)
  const core = withoutSuffix(text)
  if (core.length === 0) return null
  const pieces = core.split('.')
  if (pieces.length > 3) return null
  // A prerelease or build suffix belongs to a full `x.y.z`, as in npm. So
  // `20-24` (a hyphen range written without spaces) is not a version, rather
  // than `20` with a prerelease tag of `24`.
  if (core.length !== text.length && pieces.length !== 3) return null
  const parts: number[] = []
  let wildcardSeen = false
  for (const piece of pieces) {
    if (isWildcard(piece)) {
      wildcardSeen = true
      continue
    }
    if (wildcardSeen || !isDigits(piece)) return null
    parts.push(Number(piece))
  }
  return { parts }
}

/** `^x.y.z`: up to (not including) the next change in the first non-zero part. */
function caretInterval(written: WrittenVersion): Interval {
  const { parts } = written
  const lo = floorOf(written)
  if (parts.length === 0) return EVERYTHING
  const [major = 0, minor = 0] = parts
  if (major > 0 || parts.length === 1) return { lo, hi: nextAfter(written, 1) }
  if (minor > 0 || parts.length === 2) return { lo, hi: nextAfter(written, 2) }
  return { lo, hi: nextAfter(written, 3) }
}

function tildeInterval(written: WrittenVersion): Interval {
  const count = written.parts.length
  if (count === 0) return EVERYTHING
  return { lo: floorOf(written), hi: nextAfter(written, Math.min(count, 2)) }
}

function exactInterval(written: WrittenVersion): Interval {
  const count = written.parts.length
  if (count === 0) return EVERYTHING
  return { lo: floorOf(written), hi: nextAfter(written, count) }
}

function comparisonInterval(operator: string, written: WrittenVersion): Interval {
  const count = written.parts.length
  switch (operator) {
    case '>=':
      return count === 0 ? EVERYTHING : { lo: floorOf(written), hi: null }
    case '>':
      return count === 0 ? NOTHING : { lo: nextAfter(written, count), hi: null }
    case '<=':
      return count === 0 ? EVERYTHING : { lo: ZERO, hi: nextAfter(written, count) }
    default:
      // '<'
      return count === 0 ? NOTHING : { lo: ZERO, hi: floorOf(written) }
  }
}

/** Longest first, so `>=` is not read as `>` followed by `=1.2`. */
const OPERATORS: readonly string[] = ['>=', '<=', '~>', '>', '<', '=', '~', '^']
const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATORS)

function splitOperator(token: string): { operator: string; version: string } {
  for (const operator of OPERATORS) {
    if (token.startsWith(operator)) {
      return { operator, version: token.slice(operator.length) }
    }
  }
  return { operator: '', version: token }
}

function comparatorInterval(token: string): Interval | null {
  const { operator, version } = splitOperator(token)
  const written = parseWrittenVersion(version)
  if (!written) return null
  if (operator === '^') return caretInterval(written)
  if (operator === '~' || operator === '~>') return tildeInterval(written)
  if (operator === '' || operator === '=') return exactInterval(written)
  return comparisonInterval(operator, written)
}

function intersect(a: Interval, b: Interval): Interval {
  const lo = compareVersions(a.lo, b.lo) >= 0 ? a.lo : b.lo
  if (a.hi === null) return { lo, hi: b.hi }
  if (b.hi === null) return { lo, hi: a.hi }
  return { lo, hi: compareVersions(a.hi, b.hi) <= 0 ? a.hi : b.hi }
}

/** `1.2 - 2.3.4`: from the first (filled with zeros) through all of the second. */
function hyphenInterval(from: string, to: string): Interval | null {
  const low = parseWrittenVersion(from)
  const high = parseWrittenVersion(to)
  if (!low || !high) return null
  const hi = high.parts.length === 0 ? null : nextAfter(high, high.parts.length)
  return { lo: floorOf(low), hi }
}

/**
 * Space-separated tokens, with a bare operator joined to the version after it
 * (`>= 22` is the same comparator as `>=22`).
 */
function comparatorTokens(alternative: string): string[] {
  const tokens: string[] = []
  let pending = ''
  for (const word of alternative.split(' ')) {
    if (word.length === 0) continue
    if (OPERATOR_SET.has(word)) {
      pending += word
      continue
    }
    tokens.push(pending + word)
    pending = ''
  }
  if (pending.length > 0) tokens.push(pending)
  return tokens
}

/** One `||` alternative → the versions it allows, or null when it is not a range. */
function alternativeInterval(alternative: string): Interval | null {
  const tokens = comparatorTokens(alternative)
  if (tokens.length === 0) return EVERYTHING
  if (tokens.length === 3 && tokens[1] === '-') {
    return hyphenInterval(tokens[0] ?? '', tokens[2] ?? '')
  }
  let interval = EVERYTHING
  for (const token of tokens) {
    const next = comparatorInterval(token)
    if (!next) return null
    interval = intersect(interval, next)
  }
  return interval
}

/** Tabs and line breaks count as spaces; nothing else in a range needs them. */
function normalizeSpaces(range: string): string {
  return range.replaceAll('\t', ' ').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

/** A parsed range: one interval per `||` alternative. */
export type NodeVersionRange = { readonly intervals: readonly Interval[] }

/**
 * Parse `range`, or `null` when it is not a version range at all (`lts/*`,
 * `node`, a typo). Callers treat `null` as "says nothing", not as an error.
 */
export function parseNodeVersionRange(range: string): NodeVersionRange | null {
  const trimmed = normalizeSpaces(range).trim()
  if (trimmed.length === 0) return null
  const intervals: Interval[] = []
  for (const alternative of trimmed.split('||')) {
    const interval = alternativeInterval(alternative)
    if (!interval) return null
    intervals.push(interval)
  }
  return { intervals }
}

/** Whether some release of Node `major` (any minor or patch) satisfies `range`. */
export function rangeAllowsMajor(range: NodeVersionRange, major: number): boolean {
  const seriesLo: Version = [major, 0, 0]
  const seriesHi: Version = [major + 1, 0, 0]
  return range.intervals.some((interval) => {
    const { lo, hi } = interval
    if (hi !== null && compareVersions(lo, hi) >= 0) return false
    return compareVersions(lo, seriesHi) < 0 && (hi === null || compareVersions(hi, seriesLo) > 0)
  })
}

/**
 * The newest of `offered` (major series such as `22`, `24`, `26`) that `range`
 * allows, or `null` when none does.
 */
export function newestAllowedSeries(
  range: NodeVersionRange,
  offered: readonly string[]
): string | null {
  const majors = offered
    .filter(isDigits)
    .map(Number)
    .sort((a, b) => b - a)
  const match = majors.find((major) => rangeAllowsMajor(range, major))
  return match === undefined ? null : String(match)
}
