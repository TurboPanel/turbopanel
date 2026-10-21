/**
 * What a finished `server.backups.test-target` command writes: the outcome on
 * the target, so the settings page shows when it was last tested and why a
 * test failed. The payload is the control plane's own, so the target id in it
 * can be trusted; the result is a host's, and only its `ok` flag and a
 * bounded, plain reason are kept.
 */

import { compatLogWarn } from '../../lib/log-compat.ts'
import type { Db } from '../../db/connection.ts'
import {
  parseBackupTargetTestPayload,
  parseBackupTargetTestResult,
} from '../../contracts/commands/schemas.ts'
import { recordTargetTest } from './targets.ts'

type TestCommandRecord = { id: string; type: string; payload: unknown }

async function record(
  db: Db,
  command: TestCommandRecord,
  outcome: { ok: boolean; error?: string }
): Promise<void> {
  try {
    const { target } = parseBackupTargetTestPayload(command.payload)
    await recordTargetTest(db, target.targetId, outcome, new Date().toISOString())
  } catch (err) {
    compatLogWarn(
      'command-consumer',
      `backup target test side effect failed for command ${command.id}: ${String(err)}`
    )
  }
}

export async function applyBackupTargetTestSideEffect(
  db: Db,
  command: TestCommandRecord,
  result: unknown
): Promise<void> {
  if (command.type !== 'server.backups.test-target') return
  const parsed = parseBackupTargetTestResult(result)
  await record(db, command, { ok: parsed.ok, ...(parsed.error ? { error: parsed.error } : {}) })
}

export async function applyBackupTargetTestFailure(
  db: Db,
  command: TestCommandRecord,
  error: string | undefined
): Promise<void> {
  if (command.type !== 'server.backups.test-target') return
  await record(db, command, { ok: false, error: error ?? 'The server did not finish the test' })
}
