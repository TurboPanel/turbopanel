/**
 * Tokenizer for a pasted `docker run` command line.
 *
 * **Nothing here executes anything.** No `child_process`, no `Deno.Command`, no
 * shell. That is the whole point of writing a lexer instead of asking a shell to
 * split the string for us: the input is a command line an operator pasted into a
 * web form, and handing it to `sh -c` would mean a text box on the dashboard is
 * a remote code execution endpoint on the control plane.
 *
 * So the shell's *syntax* is deliberately only half-implemented, and the
 * unimplemented half is the half that runs things:
 *
 * - Quoting (`'…'`, `"…"`) and backslash escapes are honoured, because they are
 *   how a value containing a space arrives intact.
 * - Command substitution (`$(…)`, `` `…` ``), pipelines (`|`), sequencing
 *   (`&&`, `||`, `;`), redirection (`>`, `<`) and globbing (`*`, `?`) are
 *   **treated as ordinary characters**. `$(id -u)` lexes to the literal
 *   seven-character string `$(id -u)`; it is never evaluated, and never will be.
 *   Each one raises a warning so the operator is told the text was taken
 *   literally rather than left to discover it in a running container.
 * - `$VAR` / `${VAR}` are likewise literal. Compose has its own interpolation
 *   and TurboPanel has variables; a shell expansion performed here would resolve
 *   against the control plane's environment, which is the wrong machine and the
 *   wrong secrets.
 */

/** Something the lexer took literally, or could not close. */
export type DockerRunLexWarningCode =
  | 'command_substitution_literal'
  | 'shell_operator_literal'
  | 'redirection_literal'
  | 'glob_literal'
  | 'unterminated_quote'

export type DockerRunLexWarning = {
  code: DockerRunLexWarningCode
  message: string
  /** The offending text, exactly as pasted. */
  text: string
}

export type DockerRunLexResult = {
  /** argv after prefix stripping — `['-d', 'nginx:alpine']`. */
  tokens: string[]
  warnings: DockerRunLexWarning[]
}

const SHELL_OPERATORS = ['&&', '||', '|', ';', '&']
const REDIRECTIONS = ['>>', '>', '<<', '<']

function pushWarning(
  warnings: DockerRunLexWarning[],
  code: DockerRunLexWarningCode,
  text: string,
  message: string,
) {
  // One warning per distinct construct is enough; a command with four globs
  // does not need four identical notices.
  if (warnings.some((w) => w.code === code && w.text === text)) return
  warnings.push({ code, message, text })
}

function scanLiteralShellSyntax(
  source: string,
  warnings: DockerRunLexWarning[],
) {
  if (/\$\([^)]*\)/.test(source) || source.includes('`')) {
    const match = /\$\([^)]*\)/.exec(source)
    pushWarning(
      warnings,
      'command_substitution_literal',
      match?.[0] ?? '`',
      'Command substitution is never evaluated — the text was imported literally. Substitute the value yourself, or use a TurboPanel variable.',
    )
  }
  for (const operator of SHELL_OPERATORS) {
    if (!source.includes(operator)) continue
    pushWarning(
      warnings,
      'shell_operator_literal',
      operator,
      `"${operator}" was imported as a literal character — this importer reads one docker run command, not a shell pipeline.`,
    )
    break
  }
  for (const redirection of REDIRECTIONS) {
    if (!source.includes(redirection)) continue
    pushWarning(
      warnings,
      'redirection_literal',
      redirection,
      `"${redirection}" was imported as a literal character — redirection belongs to the shell that ran the command, not to the container.`,
    )
    break
  }
  if (/(^|\s)[^\s'"]*[*?][^\s'"]*/.test(source)) {
    pushWarning(
      warnings,
      'glob_literal',
      '*',
      'Glob patterns were imported literally — nothing is expanded against the control plane filesystem.',
    )
  }
}

/**
 * Split a command string into argv, honouring quotes and backslash escapes.
 *
 * Line continuations (`\` immediately before a newline) are folded away first,
 * because a pasted command is nearly always the multi-line form from a README.
 */
type SplitState = {
  readonly tokens: string[]
  current: string
  hasCurrent: boolean
  quote: '"' | "'" | null
}

function append(state: SplitState, text: string) {
  state.current += text
  state.hasCurrent = true
}

function flushToken(state: SplitState) {
  if (state.hasCurrent) {
    state.tokens.push(state.current)
    state.current = ''
    state.hasCurrent = false
  }
}

/** One character inside `'…'`; returns the index of the next one to read. */
function readSingleQuoted(state: SplitState, source: string, i: number): number {
  const char = source[i]!
  // Single quotes are literal all the way to the closing quote — not even
  // a backslash escapes inside them, same as the shell.
  if (char === "'") {
    state.quote = null
  } else {
    append(state, char)
  }
  return i + 1
}

/** One character inside `"…"`; returns the index of the next one to read. */
function readDoubleQuoted(state: SplitState, source: string, i: number): number {
  const char = source[i]!
  if (char === '\\') {
    const next = source[i + 1]
    // Inside double quotes the shell only treats `\` as an escape before
    // these; anywhere else it is a literal backslash (e.g. a Windows path).
    if (next === '"' || next === '\\' || next === '$' || next === '`') {
      append(state, next)
      return i + 2
    }
    if (next === '\n') return i + 2
    append(state, char)
    return i + 1
  }
  if (char === '"') {
    state.quote = null
    state.hasCurrent = true
    return i + 1
  }
  append(state, char)
  return i + 1
}

/** An unquoted `\`; returns the index of the next character to read. */
function readUnquotedBackslash(
  state: SplitState,
  source: string,
  i: number,
): number {
  const next = source[i + 1]
  if (next === undefined) {
    append(state, '\\')
    return i + 1
  }
  if (next === '\n' || (next === '\r' && source[i + 2] === '\n')) {
    // Line continuation: swallow it and the newline.
    return i + (next === '\r' ? 3 : 2)
  }
  append(state, next)
  return i + 2
}

/**
 * `$(…)` and `` `…` `` are consumed whole rather than split on the spaces
 * inside them. Not because they are evaluated — they never are — but
 * because `-e UID=$(id -u)` is one argument in the operator's head, and
 * splitting it would hand `-u)` to the parser as a real `--user` flag.
 */
function readCommandSubstitution(
  state: SplitState,
  source: string,
  i: number,
): number {
  let depth = 0
  let j = i + 1
  for (; j < source.length; j += 1) {
    const inner = source[j]!
    if (inner === '(') depth += 1
    else if (inner === ')') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const end = j < source.length ? j : source.length - 1
  append(state, source.slice(i, end + 1))
  return end + 1
}

function readBacktickSpan(state: SplitState, source: string, i: number): number {
  const close = source.indexOf('`', i + 1)
  const end = close === -1 ? source.length - 1 : close
  append(state, source.slice(i, end + 1))
  return end + 1
}

/** One character outside any quote; returns the index of the next one to read. */
function readUnquoted(state: SplitState, source: string, i: number): number {
  const char = source[i]!
  if (char === '\\') return readUnquotedBackslash(state, source, i)
  if (char === "'" || char === '"') {
    state.quote = char
    state.hasCurrent = true
    return i + 1
  }
  if (char === '$' && source[i + 1] === '(') {
    return readCommandSubstitution(state, source, i)
  }
  if (char === '`') return readBacktickSpan(state, source, i)
  if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
    flushToken(state)
    return i + 1
  }
  append(state, char)
  return i + 1
}

function splitCommandString(
  source: string,
  warnings: DockerRunLexWarning[],
): string[] {
  const state: SplitState = {
    tokens: [],
    current: '',
    hasCurrent: false,
    quote: null,
  }

  let i = 0
  while (i < source.length) {
    if (state.quote === "'") {
      i = readSingleQuoted(state, source, i)
    } else if (state.quote === '"') {
      i = readDoubleQuoted(state, source, i)
    } else {
      i = readUnquoted(state, source, i)
    }
  }

  if (state.quote !== null) {
    pushWarning(
      warnings,
      'unterminated_quote',
      state.quote,
      `Unterminated ${state.quote === '"' ? 'double' : 'single'} quote — the rest of the command was read as one argument.`,
    )
  }
  flushToken(state)
  return state.tokens
}

/**
 * Drop the `docker run` invocation itself, so both a pasted command line and a
 * bare argv array reach the parser in the same shape.
 *
 * Only a *complete* prefix is matched — `[sudo] docker run` or
 * `[sudo] docker container run` — never a lone leading word. Stripping word by
 * word would eat the IMAGE out of `docker run run`, and out of a bare
 * `container …`: the endpoint accepts argv with the prefix already removed, so
 * a leading `run` / `docker` / `container` / `sudo` is the image until a
 * `docker` in front of it says otherwise, and eating it turns a valid command
 * into `missing_image`.
 */
function stripCommandPrefix(tokens: readonly string[]): string[] {
  let index = 0
  if (tokens[index] === 'sudo') index += 1
  if (tokens[index] !== 'docker') return [...tokens]
  index += 1
  if (tokens[index] === 'container') index += 1
  if (tokens[index] !== 'run') return [...tokens]
  return tokens.slice(index + 1)
}

/**
 * Lex `input` into argv.
 *
 * A string is tokenized; an array is taken as argv already split by the caller
 * (its elements are *not* re-split or unquoted — they came from a real argv, so
 * re-lexing them would corrupt a value that legitimately contains a space).
 * Both forms then have a leading `docker run` invocation stripped, if present.
 */
export function lexDockerRunCommand(
  input: string | readonly string[],
): DockerRunLexResult {
  const warnings: DockerRunLexWarning[] = []

  if (Array.isArray(input)) {
    const argv = (input as readonly string[]).filter((token) =>
      typeof token === 'string'
    )
    scanLiteralShellSyntax(argv.join(' '), warnings)
    return { tokens: stripCommandPrefix(argv), warnings }
  }

  const source = input as string
  scanLiteralShellSyntax(source, warnings)
  return { tokens: stripCommandPrefix(splitCommandString(source, warnings)), warnings }
}
