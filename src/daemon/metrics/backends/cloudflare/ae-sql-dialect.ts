/**
 * What Cloudflare's Analytics Engine SQL API accepts, as far as the builders
 * in `sql-api.ts` need to know — checked against the generated statements by
 * the fake AE engine and `sql-limits.test.ts`, because the DuckDB engine the
 * parity tests run on accepts far more than AE does. Every rule here came from
 * a live `422` on testing (2026-09-27) or from the AE SQL reference:
 * https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/
 *
 * - Functions: only those the reference documents (aggregate, bit,
 *   conditional, date-time, encoding, mathematical, string and type
 *   conversion pages). Notably absent: `concat` (`422 unknown function call:
 *   CONCAT`), `toFloat64`, `greatest`/`least`, `abs`, `multiIf`.
 * - `if(cond, a, b)`: `a` and `b` must have the same type — Integer vs Double
 *   is refused (`422 the 2nd and 3rd arguments to IF() function must have the
 *   same type but instead had Integer and Double`). Use `0.0` / `x * 1.0`.
 * - `min`/`max`/`sum`/`avg` over a String blob column is refused.
 * - Statements longer than 10,000 characters are refused.
 */

/** Longest statement the AE SQL API accepts (`422 SQL was excessively long`). */
export const AE_SQL_MAX_LENGTH = 10_000

/** Every function the AE SQL reference documents, lower-cased. */
export const AE_SQL_DOCUMENTED_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregate
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'quantileexactweighted',
  'quantileweighted',
  'argmax',
  'argmin',
  'first_value',
  'last_value',
  'topk',
  'topkweighted',
  'countif',
  'sumif',
  'avgif',
  // bit
  'bitand',
  'bitcount',
  'bithammingdistance',
  'bitnot',
  'bitor',
  'bitrotateleft',
  'bitrotateright',
  'bitshiftleft',
  'bitshiftright',
  'bittest',
  'bitxor',
  // conditional
  'if',
  // date-time
  'formatdatetime',
  'now',
  'today',
  'todatetime',
  'toyear',
  'tomonth',
  'todayofweek',
  'todayofmonth',
  'tohour',
  'tominute',
  'tosecond',
  'tounixtimestamp',
  'tostartofinterval',
  'tostartofyear',
  'tostartofmonth',
  'tostartofweek',
  'tostartofday',
  'tostartofhour',
  'tostartoffifteenminutes',
  'tostartoftenminutes',
  'tostartoffiveminutes',
  'tostartofminute',
  'toyyyymm',
  // encoding
  'bin',
  'hex',
  // mathematical
  'intdiv',
  'log',
  'pow',
  'round',
  'floor',
  'ceil',
  // string
  'length',
  'empty',
  'lower',
  'lowerutf8',
  'upper',
  'upperutf8',
  'startswith',
  'endswith',
  'position',
  'substring',
  'format',
  'extract',
  // type conversion
  'touint8',
  'touint32',
])

/** SQL keywords that can precede `(` without being a function call. */
const NON_FUNCTION_KEYWORDS = new Set(['in', 'and', 'or', 'not', 'from', 'select', 'where', 'as'])

type AeType = 'Integer' | 'Double' | 'String' | 'DateTime' | 'Boolean' | 'Unknown'

/** Remove string literals so their contents never look like SQL. */
function blankStringLiterals(sql: string): string {
  return sql.replace(
    /'(?:[^']|'')*'/g,
    (literal) => `'${'s'.repeat(Math.max(0, literal.length - 2))}'`
  )
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchingParen(sql: string, open: number): number {
  let depth = 0
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split `text` at top-level occurrences of `separator` (outside parentheses). */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0) {
      separator.lastIndex = i
      const match = separator.exec(text)
      if (match?.index === i) {
        parts.push(text.slice(start, i))
        start = i + match[0].length
        i = start
        continue
      }
    }
    i++
  }
  parts.push(text.slice(start))
  return parts
}

function stripOuterParens(expr: string): string {
  let text = expr.trim()
  while (text.startsWith('(') && matchingParen(text, 0) === text.length - 1) {
    text = text.slice(1, -1).trim()
  }
  return text
}

const INTEGER_FUNCTIONS = new Set([
  'tounixtimestamp',
  'intdiv',
  'touint8',
  'touint32',
  'count',
  'countif',
  'length',
])
const DOUBLE_FUNCTIONS = new Set(['avg', 'avgif', 'log', 'pow'])
const STRING_FUNCTIONS = new Set([
  'lower',
  'upper',
  'lowerutf8',
  'upperutf8',
  'substring',
  'format',
  'hex',
  'bin',
])

/** Functions whose result type is simply their first argument's type. */
const FIRST_ARG_TYPE_FUNCTIONS = new Set([
  'sum',
  'sumif',
  'min',
  'max',
  'round',
  'floor',
  'ceil',
  'argmax',
  'argmin',
])

/**
 * Type of a top-level `+`/`-` or `*`/`/`/`%` combination, or `undefined` when
 * `text` is a single term (a literal, a column, or a function call) instead.
 */
function inferArithmeticType(text: string): AeType | undefined {
  const additive = splitTopLevel(text, /\s[+-]\s/y)
  const multiplicative = additive.length > 1 ? additive : splitTopLevel(text, /\s*[*/%]\s*/y)
  if (multiplicative.length <= 1) return undefined
  if (/(^|[^*])\/(?!\*)/.test(text.replace(/\([^()]*\)/g, ''))) return 'Double'
  const types = multiplicative.map(inferAeExpressionType)
  if (types.includes('Double')) return 'Double'
  if (types.every((t) => t === 'Integer')) return 'Integer'
  return 'Unknown'
}

/** Type of a literal or a bare column reference, or `undefined` when `text` is neither. */
function inferLiteralType(text: string): AeType | undefined {
  if (/^-?\d+$/.test(text)) return 'Integer'
  if (/^-?(\d+\.\d*|\d*\.\d+)$/.test(text)) return 'Double'
  if (/^-?\d+(\.\d+)?e[+-]?\d+$/i.test(text)) return 'Double'
  if (/^'.*'$/s.test(text)) return 'String'
  if (/^double\d+$/.test(text)) return 'Double'
  if (/^blob\d+$/.test(text) || /^index\d+$/.test(text)) return 'String'
  if (text === '_sample_interval') return 'Integer'
  if (text === 'timestamp') return 'DateTime'
  return undefined
}

/** Type of `if(cond, a, b)`'s result — the branch type when both agree, else `Unknown`. */
function inferIfCallType(args: readonly string[]): AeType {
  if (args.length !== 3) return 'Unknown'
  const a = inferAeExpressionType(args[1])
  const b = inferAeExpressionType(args[2])
  return a === b ? a : 'Unknown'
}

/** Type of a function call already confirmed well-formed (name matched, parens balanced). */
function inferFunctionCallType(name: string, args: readonly string[]): AeType {
  const lower = name.toLowerCase()
  if (INTEGER_FUNCTIONS.has(lower)) return 'Integer'
  if (DOUBLE_FUNCTIONS.has(lower)) return 'Double'
  if (STRING_FUNCTIONS.has(lower)) return 'String'
  if (lower === 'todatetime' || lower === 'now') return 'DateTime'
  if (lower === 'if') return inferIfCallType(args)
  if (FIRST_ARG_TYPE_FUNCTIONS.has(lower)) {
    return args[0] === undefined ? 'Unknown' : inferAeExpressionType(args[0])
  }
  return 'Unknown'
}

/**
 * Best-effort type of one expression, enough to hold `if()` branches to AE's
 * same-type rule for the shapes the builders emit. `Unknown` never fails a
 * check — only two confidently different types do.
 */
export function inferAeExpressionType(expr: string): AeType {
  const text = stripOuterParens(expr)
  if (text === '') return 'Unknown'

  const arithmetic = inferArithmeticType(text)
  if (arithmetic !== undefined) return arithmetic

  const literal = inferLiteralType(text)
  if (literal !== undefined) return literal

  const call = /^([A-Za-z_]\w*)\s*\(/.exec(text)
  if (call && matchingParen(text, call[0].length - 1) === text.length - 1) {
    const args = splitTopLevel(text.slice(call[0].length, -1), /,/y)
    return inferFunctionCallType(call[1], args)
  }
  return 'Unknown'
}

function* functionCalls(sql: string): Generator<{ name: string; start: number; open: number }> {
  const pattern = /\b([A-Za-z_]\w*)\s*\(/g
  for (const match of sql.matchAll(pattern)) {
    const name = match[1]
    if (NON_FUNCTION_KEYWORDS.has(name.toLowerCase())) continue
    yield { name, start: match.index, open: match.index + match[0].length - 1 }
  }
}

/** Aggregates AE only accepts with one argument, and only over a numeric column. */
const SINGLE_ARG_AGGREGATE_FUNCTIONS = new Set(['min', 'max', 'sum', 'avg'])

/** The one dialect failure this already-documented, well-formed call produces, if any. */
function functionCallFailure(lower: string, args: readonly string[]): string | undefined {
  if (SINGLE_ARG_AGGREGATE_FUNCTIONS.has(lower) && args.length === 1) {
    if (inferAeExpressionType(args[0]) === 'String') {
      return `Input was invalid: cannot use the String type as argument 1 in ${lower}(`
    }
  }
  if (lower === 'if' && args.length === 3) {
    const a = inferAeExpressionType(args[1])
    const b = inferAeExpressionType(args[2])
    if (a !== 'Unknown' && b !== 'Unknown' && a !== b) {
      return `Input was invalid: the 2nd and 3rd arguments to IF() function must have the same type but instead had ${a} and ${b}: if(${args.join(',').trim().slice(0, 120)}`
    }
  }
  return undefined
}

/**
 * Every reason AE's SQL API would refuse `sql`, in the wording AE uses where
 * we know it. Empty when the statement passes every rule this module knows.
 */
export function aeSqlDialectFailures(sql: string): string[] {
  if (sql.length > AE_SQL_MAX_LENGTH) {
    return [
      `Input was invalid: SQL was excessively long, exceeded maximum length: ${AE_SQL_MAX_LENGTH}`,
    ]
  }
  const failures: string[] = []
  const text = blankStringLiterals(sql)
  for (const call of functionCalls(text)) {
    const lower = call.name.toLowerCase()
    if (!AE_SQL_DOCUMENTED_FUNCTIONS.has(lower)) {
      failures.push(`Input was invalid: unknown function call: ${call.name}`)
      continue
    }
    const close = matchingParen(text, call.open)
    if (close < 0) continue
    const args = splitTopLevel(text.slice(call.open + 1, close), /,/y)
    const failure = functionCallFailure(lower, args)
    if (failure !== undefined) failures.push(failure)
  }
  return failures
}
