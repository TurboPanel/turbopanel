/**
 * Which hostnames of a deploy the host may take over, and from which
 * environment.
 *
 * Deleting a hosting does nothing on the host: the environment's config keeps
 * serving the name until that environment is deployed again, and the host
 * refuses another environment's deploy of the same name. A name is listed only
 * when the panel can prove, from what it last sent that environment for this
 * server (`deployment.options.servedHostnames`), that a specific environment of
 * the same organization held it and has no hosting row for it any more. The
 * entry names that environment; the host takes the name only from that
 * environment's own config and refuses if any other config holds it too.
 * Hostname uniqueness is per organization, so another organization's
 * environment is never named. A first deploy of a name that nothing here ever
 * served lists nothing, and the host refuses a conflict as it always did.
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { deployment, environment, hosting, hostname, project, service } from '../../db/schema.ts'
import {
  foldHostname,
  hostingCertificateNames,
  type HostingWwwMode,
} from '../../contracts/commands/hostname.ts'
import { readWwwMode } from './deploy-routes-helpers.ts'

export type DeployTakeover = { hostname: string; fromEnvironmentId: string }

/** What the host accepts in a takeover entry's `hostname`. */
const TAKEOVER_NAME_RE = /^[a-z0-9*][a-z0-9.*-]*$/

type HostingNames = { hostnames: readonly string[]; www?: HostingWwwMode }

/** Every name the hostings answer on, www redirect names included, folded and unique. */
export function servedNamesOf(hostings: readonly HostingNames[]): string[] {
  const names = hostings.flatMap((hosting) =>
    hostingCertificateNames({
      hostnames: hosting.hostnames.map(foldHostname),
      ...(hosting.www ? { www: hosting.www } : {}),
    }).map(foldHostname)
  )
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

/** The names a deployment row says were last sent to its server. */
export function recordedServedNames(options: unknown): string[] {
  const names = (options as { servedHostnames?: unknown } | null)?.servedHostnames
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

/** The names the given environments' hostings answer on now. */
async function currentNamesByEnvironment(
  db: Pick<Db, 'select'>,
  environmentIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({
      environmentId: service.environmentId,
      hostingId: hosting.id,
      options: hosting.options,
      name: hostname.hostname,
    })
    .from(hostname)
    .innerJoin(hosting, eq(hostname.hostingId, hosting.id))
    .innerJoin(service, eq(hosting.serviceId, service.id))
    .where(inArray(service.environmentId, [...environmentIds]))
  const byHosting = new Map<
    string,
    { environmentId: string; options: unknown; hostnames: string[] }
  >()
  for (const row of rows) {
    const entry = byHosting.get(row.hostingId) ?? {
      environmentId: row.environmentId,
      options: row.options,
      hostnames: [],
    }
    entry.hostnames.push(row.name)
    byHosting.set(row.hostingId, entry)
  }
  const byEnvironment = new Map<string, Set<string>>()
  for (const entry of byHosting.values()) {
    const www = readWwwMode(entry.options)
    const names = servedNamesOf([{ hostnames: entry.hostnames, www }])
    const set = byEnvironment.get(entry.environmentId) ?? new Set<string>()
    for (const name of names) set.add(name)
    byEnvironment.set(entry.environmentId, set)
  }
  return byEnvironment
}

export async function takeoverHostnamesFor(
  db: Pick<Db, 'select'>,
  params: {
    environmentId: string
    organizationId: string
    serverId: string
    /** The hostings this server's deploy sends. */
    hostings: readonly HostingNames[]
  }
): Promise<DeployTakeover[]> {
  const wanted = new Set(
    servedNamesOf(params.hostings).filter(
      (name) => name.length <= 253 && TAKEOVER_NAME_RE.test(name)
    )
  )
  if (wanted.size === 0) return []

  // Other environments of this organization this server was last sent a name of.
  const rows = await db
    .select({ environmentId: deployment.environmentId, options: deployment.options })
    .from(deployment)
    .innerJoin(environment, eq(deployment.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(
      and(
        eq(deployment.serverId, params.serverId),
        eq(project.organizationId, params.organizationId),
        ne(deployment.environmentId, params.environmentId)
      )
    )
  const recorded = rows
    .map((row) => ({
      environmentId: row.environmentId,
      names: recordedServedNames(row.options)
        .map(foldHostname)
        .filter((n) => wanted.has(n)),
    }))
    .filter((row) => row.names.length > 0)
  if (recorded.length === 0) return []

  // It no longer has a hosting row for the name: that is what makes it a leftover.
  const current = await currentNamesByEnvironment(
    db,
    recorded.map((row) => row.environmentId)
  )
  return recorded
    .flatMap((row) =>
      row.names
        .filter((name) => !current.get(row.environmentId)?.has(name))
        .map((name) => ({ hostname: name, fromEnvironmentId: row.environmentId }))
    )
    .sort(
      (a, b) =>
        a.hostname.localeCompare(b.hostname) ||
        a.fromEnvironmentId.localeCompare(b.fromEnvironmentId)
    )
}
