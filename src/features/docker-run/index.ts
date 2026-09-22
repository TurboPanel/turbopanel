/**
 * `docker run` → Compose importer.
 *
 * A standalone module rather than part of `../compose/`: this is an *input
 * path* into the compose model, not a change to the model. Its output is an
 * ordinary `ComposeDocument` that the existing five-stage validation pipeline
 * checks exactly as it checks a hand-authored one — the importer gets no
 * shortcut and no private vocabulary.
 *
 * Three stages, each pure and each testable on its own:
 *
 * 1. `./lexer.ts` — a pasted command line to argv, **without a shell**.
 * 2. `./parse.ts` — argv to options + IMAGE + COMMAND, against
 *    `./option-registry.ts`, which enumerates the whole `docker container run`
 *    surface so an unknown flag is a diagnostic rather than a mis-read image.
 * 3. `./to-compose.ts` — options to standard Compose fields, plus the
 *    diagnostics and risk flags the caller has to show before merging.
 */

export {
  DOCKER_RUN_OPTION_NAMES,
  DOCKER_RUN_OPTIONS,
  type DockerRunOptionBehavior,
  type DockerRunOptionDefinition,
  dockerRunOptionName,
  type DockerRunOptionPlatform,
  type DockerRunOptionValue,
  lookupDockerRunOption,
} from './option-registry.ts'
export {
  type DockerRunLexResult,
  type DockerRunLexWarning,
  type DockerRunLexWarningCode,
  lexDockerRunCommand,
} from './lexer.ts'
export {
  type DockerRunDiagnostic,
  type DockerRunDiagnosticCode,
  type DockerRunParseEntry,
  parseDockerRunCommand,
  parseDockerRunTokens,
  type ParsedDockerRun,
} from './parse.ts'
export {
  type DockerRunComposeOptions,
  type DockerRunComposeResult,
  dockerRunToComposeDocument,
  type DockerRunRiskFlag,
  type DockerRunRiskKind,
} from './to-compose.ts'

import type { ComposeDocument } from '../compose/types.ts'
import { lexDockerRunCommand } from './lexer.ts'
import { parseDockerRunTokens, type DockerRunDiagnostic } from './parse.ts'
import {
  dockerRunToComposeDocument,
  type DockerRunRiskFlag,
} from './to-compose.ts'

export type DockerRunImportInput = {
  /** Compose service key the imported container becomes. */
  serviceName: string
  /** A pasted command line, or an argv array. Either may keep `docker run`. */
  argv: string | readonly string[]
}

export type DockerRunImportResult = {
  compose: ComposeDocument
  diagnostics: DockerRunDiagnostic[]
  riskFlags: DockerRunRiskFlag[]
  /** The IMAGE that was read, so a caller can echo what it understood. */
  image: string | null
  /** COMMAND [ARG...] after the image. */
  command: string[]
}

/** Whether any diagnostic refuses the import. */
export function hasBlockingDockerRunDiagnostic(
  diagnostics: readonly DockerRunDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.blocking)
}

/**
 * Lex, parse, and compile a `docker run` command into a one-service compose
 * document.
 *
 * Always returns a result, blocking diagnostics included: the caller decides
 * whether a blocking finding ends the request, the same split the compose
 * linter uses between `lintComposeYaml` and `blockingComposeLintIssues`.
 */
export function importDockerRunCommand(
  input: DockerRunImportInput,
): DockerRunImportResult {
  const lexed = lexDockerRunCommand(input.argv)
  const parsed = parseDockerRunTokens(lexed.tokens, lexed.warnings)
  const compiled = dockerRunToComposeDocument(parsed, {
    serviceName: input.serviceName,
  })
  return {
    compose: compiled.compose,
    diagnostics: compiled.diagnostics,
    riskFlags: compiled.riskFlags,
    image: parsed.image,
    command: parsed.command,
  }
}
