/**
 * Grammar-aware walk over lexed `docker run` argv.
 *
 * `docker container run [OPTIONS] IMAGE [COMMAND] [ARG...]` looks trivial until
 * you notice that the boundary between OPTIONS and IMAGE is decided entirely by
 * whether the parser recognizes each flag *and knows whether it takes a value*.
 * Get either wrong and the failure is silent: `--shiny-new-flag nginx:alpine`
 * parses as image `nginx:alpine` under one reading and image `--shiny-new-flag`
 * under another, and both produce a compose fragment rather than an error.
 *
 * So this module never guesses. An unrecognized flag is an `unknown_option`
 * diagnostic and stops the option scan from consuming anything after it as a
 * value — the operator is told which flag the importer does not know, instead of
 * being handed a document assembled around a bad guess.
 *
 * Pure: takes tokens, returns data. See `./lexer.ts` for the no-shell rule.
 */

import {
  DOCKER_RUN_OPTION_NAMES,
  type DockerRunOptionDefinition,
  dockerRunOptionName,
  lookupDockerRunOption,
} from './option-registry.ts'
import { lexDockerRunCommand, type DockerRunLexWarning } from './lexer.ts'

export type DockerRunDiagnosticCode =
  /** A flag no registry entry claims — see the module doc for why this stops. */
  | 'unknown_option'
  /** `--flag` at the end of the line, or before another flag. */
  | 'missing_option_value'
  /** `--privileged=` style value on a flag that takes none. */
  | 'unexpected_option_value'
  /** No positional token was left to be the image. */
  | 'missing_image'
  /** A flag repeated that Docker itself would only honour once. */
  | 'option_not_repeatable'
  /** CLI-invocation flag: recorded, not imported. Never blocking. */
  | 'operational_option_ignored'
  /** Registry says `unsupported`. Blocking. */
  | 'option_unsupported'
  /** A value the compiler could not turn into a Compose field. */
  | 'option_value_unparsed'
  /** Shell syntax the lexer took literally. Never blocking. */
  | 'shell_syntax_literal'

export type DockerRunDiagnostic = {
  code: DockerRunDiagnosticCode
  /** The flag exactly as authored, when the diagnostic is about one. */
  flag?: string
  message: string
  /**
   * Whether this refuses the import. `false` means "imported anyway, and here
   * is what you should know" — the same permissive-while-editing posture the
   * compose linter takes.
   */
  blocking: boolean
}

export type DockerRunParseEntry = {
  definition: DockerRunOptionDefinition
  /** The spelling the operator used (`-v`, not `--volume`). */
  rawFlag: string
  /** `null` for a bare boolean; the `=`-suffixed text when one was given. */
  value: string | null
}

export type ParsedDockerRun = {
  image: string | null
  /** COMMAND [ARG...] — everything after IMAGE, in order. */
  command: string[]
  entries: DockerRunParseEntry[]
  /**
   * Every finding, in the order it was discovered — unknown flags, positional
   * problems, and the lexer's literal-shell-syntax warnings folded in, so a
   * caller has one list to render rather than three.
   */
  diagnostics: DockerRunDiagnostic[]
}

function levenshtein(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const candidate = previous[j]!
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diagonal = candidate
    }
  }
  return previous[b.length]!
}

/** Nearest known flag within edit distance 2, matching the linter's hint style. */
function suggestFlag(flag: string): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const candidate of DOCKER_RUN_OPTION_NAMES) {
    if (candidate.length < 3) continue
    const distance = levenshtein(flag, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function unknownOptionDiagnostic(flag: string): DockerRunDiagnostic {
  const suggestion = suggestFlag(flag)
  return {
    code: 'unknown_option',
    flag,
    blocking: true,
    message: suggestion
      ? `Unknown docker run option "${flag}" — did you mean "${suggestion}"?`
      : `Unknown docker run option "${flag}". It was not imported, and nothing after it was read as its value.`,
  }
}

function lexWarningDiagnostic(
  warning: DockerRunLexWarning,
): DockerRunDiagnostic {
  return {
    code: 'shell_syntax_literal',
    message: warning.message,
    blocking: false,
  }
}

function isOptionToken(token: string): boolean {
  return token.length > 1 && token.startsWith('-') && token !== '-'
}

/**
 * Walk lexed argv into options, IMAGE, and COMMAND.
 *
 * The scan stays in option position until the first token that is not a flag;
 * that token is IMAGE and everything after it is COMMAND, flags included — a
 * `-v` after the image belongs to the container's own program, not to Docker.
 */
export function parseDockerRunTokens(
  tokens: readonly string[],
  lexWarnings: readonly DockerRunLexWarning[] = [],
): ParsedDockerRun {
  const entries: DockerRunParseEntry[] = []
  const diagnostics: DockerRunDiagnostic[] = lexWarnings.map(lexWarningDiagnostic)
  const seen = new Set<string>()

  const record = (
    definition: DockerRunOptionDefinition,
    rawFlag: string,
    value: string | null,
  ) => {
    const canonical = dockerRunOptionName(definition)
    if (!definition.repeatable && seen.has(canonical)) {
      diagnostics.push({
        code: 'option_not_repeatable',
        flag: rawFlag,
        blocking: false,
        message:
          `"${canonical}" was given more than once; Docker keeps the last value, and so does this import.`,
      })
    }
    seen.add(canonical)
    entries.push({ definition, rawFlag, value })
  }

  let index = 0
  let sawTerminator = false

  /** Handle a `--flag[=value]` token; returns how many extra tokens it took. */
  const readLongOption = (token: string): number => {
    const equals = token.indexOf('=')
    const flag = equals === -1 ? token : token.slice(0, equals)
    const inlineValue = equals === -1 ? null : token.slice(equals + 1)
    const definition = lookupDockerRunOption(flag)
    if (!definition) {
      diagnostics.push(unknownOptionDiagnostic(flag))
      return 0
    }
    if (definition.value === 'none' && inlineValue !== null) {
      diagnostics.push({
        code: 'unexpected_option_value',
        flag,
        blocking: true,
        message: `"${flag}" takes no value, but "${inlineValue}" was given.`,
      })
      return 0
    }
    if (definition.value === 'required' && inlineValue === null) {
      const next = tokens[index + 1]
      if (next === undefined) {
        diagnostics.push({
          code: 'missing_option_value',
          flag,
          blocking: true,
          message: `"${flag}" needs a value and the command ended.`,
        })
        return 0
      }
      record(definition, flag, next)
      return 1
    }
    record(definition, flag, inlineValue)
    return 0
  }

  /** A value-taking short flag; returns how many extra tokens it took. */
  const readShortValue = (
    definition: DockerRunOptionDefinition,
    flag: string,
    rest: string,
  ): number => {
    if (rest.length > 0) {
      record(definition, flag, rest)
      return 0
    }
    const next = tokens[index + 1]
    if (next === undefined) {
      diagnostics.push({
        code: 'missing_option_value',
        flag,
        blocking: true,
        message: `"${flag}" needs a value and the command ended.`,
      })
      return 0
    }
    record(definition, flag, next)
    return 1
  }

  /**
   * Shorthand cluster: `-it`, `-p8080:80`, `-e=FOO=bar`, `-u root`.
   * Returns how many extra tokens it took.
   */
  const readShortCluster = (token: string): number => {
    let cursor = 1
    while (cursor < token.length) {
      const flag = `-${token[cursor]!}`
      const definition = lookupDockerRunOption(flag)
      if (!definition) {
        diagnostics.push(unknownOptionDiagnostic(flag))
        return 0
      }
      let rest = token.slice(cursor + 1)
      if (rest.startsWith('=')) rest = rest.slice(1)

      if (definition.value === 'required') {
        return readShortValue(definition, flag, rest)
      }

      // Boolean: `-d=false` is the only way it takes a value, and it never
      // reaches for the next token — that token is the image.
      if (token[cursor + 1] === '=') {
        record(definition, flag, rest)
        return 0
      }
      record(definition, flag, null)
      cursor += 1
    }
    return 0
  }

  while (index < tokens.length) {
    const token = tokens[index]!

    if (token === '--') {
      // pflag's end-of-options marker: everything after it is positional.
      sawTerminator = true
      index += 1
      break
    }

    if (!isOptionToken(token)) break

    const consumed = token.startsWith('--')
      ? readLongOption(token)
      : readShortCluster(token)
    index += 1 + consumed
  }

  const positionals = tokens.slice(index)
  const image = positionals.length > 0 ? positionals[0]! : null
  const command = positionals.slice(1)

  if (image === null) {
    diagnostics.push({
      code: 'missing_image',
      blocking: true,
      message: sawTerminator
        ? 'No image was given after "--".'
        : 'No image was found. A docker run command needs an IMAGE after its options.',
    })
  }

  return { image, command, entries, diagnostics }
}

/** Lex then parse, for callers holding a raw pasted command or an argv array. */
export function parseDockerRunCommand(
  input: string | readonly string[],
): ParsedDockerRun {
  const lexed = lexDockerRunCommand(input)
  return parseDockerRunTokens(lexed.tokens, lexed.warnings)
}
