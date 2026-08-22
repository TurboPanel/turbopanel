/**
 * Select the execution-log store for the current runtime.
 *
 * Mirrors `resolveServerMetricsStore` (`src/daemon/metrics/store-selection.ts`):
 * runtime-branch first, `warnOnce` on incomplete configuration, and a disabled
 * no-op store rather than a throw so a half-converged deployment still serves
 * commands — it just does not retain their transcripts.
 */

import { DisabledExecutionLogStore } from './disabled-store.ts'
import { FilesystemExecutionLogStore } from './filesystem-store.ts'
import { R2ExecutionLogStore, type R2BucketLike } from './r2-store.ts'
import { S3ExecutionLogStore, type S3ExecutionLogConfig } from './s3-store.ts'
import { EXECUTION_LOG_RETENTION_DAYS, type ExecutionLogStore } from './types.ts'

export type { R2BucketLike, S3ExecutionLogConfig }

const warnedKeys = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(message)
}

/** Test seam: clear warn-once keys. */
export function resetExecutionLogStoreSelectionWarningsForTests(): void {
  warnedKeys.clear()
}

/** Deno driver choice, from `TURBOPANEL_EXECUTION_LOG_DRIVER`. */
export type ExecutionLogDriver = 'filesystem' | 's3'

/** Parse the driver env value; anything unrecognized falls back to `filesystem`. */
export function parseExecutionLogDriver(value: string | undefined | null): ExecutionLogDriver {
  const normalized = value?.trim().toLowerCase()
  return normalized === 's3' ? 's3' : 'filesystem'
}

/** Parse an optional positive-integer retention override. */
export function parseExecutionLogRetentionDays(
  value: string | number | undefined | null
): number {
  if (value === undefined || value === null) return EXECUTION_LOG_RETENTION_DAYS
  const parsed = Number(String(value).trim())
  if (!Number.isInteger(parsed) || parsed <= 0) return EXECUTION_LOG_RETENTION_DAYS
  return parsed
}

function isFullS3Config(
  config: Partial<S3ExecutionLogConfig> | undefined
): config is S3ExecutionLogConfig {
  if (!config) return false
  return Boolean(
    config.endpoint?.trim() &&
      config.bucket?.trim() &&
      config.region?.trim() &&
      config.accessKeyId?.trim() &&
      config.secretAccessKey?.trim()
  )
}

/**
 * Read the Deno S3 driver configuration from process env. Returns a partial
 * object; {@link resolveExecutionLogStore} decides whether it is complete.
 */
export function resolveS3ExecutionLogConfig(env: {
  TURBOPANEL_EXECUTION_LOG_S3_ENDPOINT?: string
  TURBOPANEL_EXECUTION_LOG_S3_BUCKET?: string
  TURBOPANEL_EXECUTION_LOG_S3_REGION?: string
  TURBOPANEL_EXECUTION_LOG_S3_ACCESS_KEY_ID?: string
  TURBOPANEL_EXECUTION_LOG_S3_SECRET_ACCESS_KEY?: string
  TURBOPANEL_EXECUTION_LOG_S3_FORCE_PATH_STYLE?: string
}): Partial<S3ExecutionLogConfig> {
  const forcePathStyle = env.TURBOPANEL_EXECUTION_LOG_S3_FORCE_PATH_STYLE?.trim()
  return {
    endpoint: env.TURBOPANEL_EXECUTION_LOG_S3_ENDPOINT?.trim(),
    bucket: env.TURBOPANEL_EXECUTION_LOG_S3_BUCKET?.trim(),
    region: env.TURBOPANEL_EXECUTION_LOG_S3_REGION?.trim(),
    accessKeyId: env.TURBOPANEL_EXECUTION_LOG_S3_ACCESS_KEY_ID?.trim(),
    secretAccessKey: env.TURBOPANEL_EXECUTION_LOG_S3_SECRET_ACCESS_KEY?.trim(),
    forcePathStyle: forcePathStyle !== '0' && forcePathStyle !== 'false',
  }
}

export type ResolveExecutionLogStoreInput = {
  runtime: 'workers' | 'deno'
  /** Workers: the `EXECUTION_LOGS` R2 bucket binding. */
  r2?: R2BucketLike
  deno?: {
    driver?: ExecutionLogDriver
    /** Resolved via `resolveExecutionLogDir` — the state-tree transcript root. */
    directory?: string
    s3?: Partial<S3ExecutionLogConfig>
  }
}

/**
 * Workers → R2; Deno → filesystem by default, S3 when opted in.
 * Incomplete backend config falls back to a no-op store until converge wires it.
 */
export function resolveExecutionLogStore(
  input: ResolveExecutionLogStoreInput
): ExecutionLogStore {
  if (input.runtime === 'workers') {
    if (input.r2) return new R2ExecutionLogStore(input.r2)
    warnOnce(
      'workers-missing-r2',
      'execution logs on Workers but EXECUTION_LOGS R2 binding missing; transcripts will not be retained'
    )
    return new DisabledExecutionLogStore()
  }

  const driver = input.deno?.driver ?? 'filesystem'
  if (driver === 's3') {
    if (isFullS3Config(input.deno?.s3)) {
      return new S3ExecutionLogStore(input.deno.s3)
    }
    warnOnce(
      'deno-missing-s3',
      'execution logs on Deno set to the s3 driver but its config is incomplete; transcripts will not be retained'
    )
    return new DisabledExecutionLogStore()
  }

  const directory = input.deno?.directory?.trim()
  if (!directory) {
    warnOnce(
      'deno-missing-directory',
      'execution logs on Deno but no transcript directory resolved; transcripts will not be retained'
    )
    return new DisabledExecutionLogStore()
  }
  return new FilesystemExecutionLogStore(directory)
}
