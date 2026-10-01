import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  type EnvironmentDeployResultApp,
  type EnvironmentDeployResultSite,
  parseDeployResultApp,
} from '../../contracts/commands/schemas.ts'
import { service } from '../../db/schema.ts'

/**
 * The application a site service runs, as detected by the daemon from the
 * document root's file names. A fact, not configuration: it lives in
 * `service.metadata.app` (no table) and the next deploy re-asserts it.
 */
export type ServiceApp = EnvironmentDeployResultApp

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A well-formed detected app, or `undefined` for anything else. */
export const parseServiceApp: (value: unknown) => ServiceApp | undefined = parseDeployResultApp

/** The detected app recorded on a service's `metadata`, when valid. */
export function readServiceApp(metadata: unknown): ServiceApp | undefined {
  return isRecord(metadata) ? parseServiceApp(metadata.app) : undefined
}

/** `metadata` with `app` set (or removed when `app` is `undefined`). */
export function withServiceApp(
  metadata: unknown,
  app: ServiceApp | undefined
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(metadata) ? { ...metadata } : {}
  if (app === undefined) {
    delete next.app
  } else {
    next.app = app
  }
  return next
}

/** Carry the stored `app` fact across a client metadata replacement. */
export function preserveServiceApp(
  existingMetadata: unknown,
  nextMetadata: Record<string, unknown>
): Record<string, unknown> {
  return withServiceApp(nextMetadata, readServiceApp(existingMetadata))
}

function sameApp(a: ServiceApp | undefined, b: ServiceApp | undefined): boolean {
  return a?.kind === b?.kind && a?.version === b?.version
}

/**
 * Record what a deploy found in each applied site's document root.
 *
 * Scope is the command's own `environmentId` (never a daemon-supplied id): a
 * reported name that is not a service of that environment is ignored. A site
 * reported without `app` clears a previous fact, so a WordPress tree that was
 * replaced stops being labelled. Rows are only written when the fact changed.
 */
export async function recordDeployedSiteApps(
  db: Db,
  input: { environmentId: string; sites: readonly EnvironmentDeployResultSite[] }
): Promise<number> {
  if (input.sites.length === 0) return 0
  const names = input.sites.map((site) => site.composeServiceName)
  const rows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
      metadata: service.metadata,
    })
    .from(service)
    .where(
      and(
        eq(service.environmentId, input.environmentId),
        inArray(service.composeServiceName, names)
      )
    )
  const byName = new Map(rows.map((row) => [row.composeServiceName, row]))

  const changes = input.sites.flatMap((site) => {
    const row = byName.get(site.composeServiceName)
    if (!row || sameApp(readServiceApp(row.metadata), site.app)) return []
    return [{ id: row.id, metadata: withServiceApp(row.metadata, site.app) }]
  })
  await Promise.all(
    changes.map((change) =>
      db.update(service).set({ metadata: change.metadata }).where(eq(service.id, change.id))
    )
  )
  return changes.length
}
