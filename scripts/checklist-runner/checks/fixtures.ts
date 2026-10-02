/**
 * Building blocks shared by the checks. Everything created here is named with
 * the run prefix and registered for cleanup the moment its id is known, so a
 * failure half-way still tears down what exists. Cleanup works by tracked id,
 * never by name, so nothing the run did not create is ever touched.
 */
import { assertAffectedHost, assertManagedPlacement, shortHost } from '../safety.ts'
import type { CheckContext, Json } from '../types.ts'
import { excerpt, expectStatus, listOf, objOf, pollUntil, str, type Rec } from './helpers.ts'

const V1 = '/client/v1'
export const TERMINAL = ['succeeded', 'failed', 'timed_out', 'cancelled']

export async function listServers(ctx: CheckContext): Promise<Rec[]> {
  const res = expectStatus(await ctx.api.get(`${V1}/servers`), 'list servers', 200)
  return listOf(res.body, 'servers')
}

export async function findServer(ctx: CheckContext, name: string): Promise<Rec> {
  const servers = await listServers(ctx)
  const found = servers.find((s) => shortHost(str(s, 'hostname', 'name')) === shortHost(name))
  if (!found) throw new Error(`server ${name} is not in this organization`)
  return found
}

/** The first `--host` the operator passed, validated for host-affecting work. */
export async function affectedServer(ctx: CheckContext): Promise<Rec | undefined> {
  const name = ctx.hosts[0]
  if (!name) return undefined
  assertAffectedHost(name, ctx.hosts)
  const server = await findServer(ctx, name)
  assertAffectedHost(str(server, 'hostname'), ctx.hosts)
  return server
}

/** A managed-database placement: the first `--host` that is themisto or megaclite. */
export async function managedServer(ctx: CheckContext): Promise<Rec | undefined> {
  const name = ctx.hosts.find((h) => ['themisto', 'megaclite'].includes(shortHost(h)))
  if (!name) return undefined
  const server = await findServer(ctx, name)
  assertManagedPlacement(str(server, 'hostname'))
  return server
}

export async function createWorkspace(ctx: CheckContext, label: string): Promise<string> {
  const name = `${ctx.prefix}-${label}`
  const res = expectStatus(await ctx.api.post(`${V1}/workspaces`, { body: { name } }), 'workspace')
  const id = str(objOf(res.body), 'id')
  ctx.defer(`workspace ${name}`, async () => {
    expectStatus(await ctx.api.del(`${V1}/workspaces/${id}`), 'delete workspace', 200, 204, 404)
  })
  return id
}

export interface ProjectRef {
  projectId: string
  environmentId: string
}

/** Create a project and register its deletion; returns its default environment. */
export async function createProject(
  ctx: CheckContext,
  body: { [key: string]: Json }
): Promise<ProjectRef> {
  const res = expectStatus(await ctx.api.post(`${V1}/projects`, { body }), 'create project')
  const projectId = str(objOf(res.body), 'id')
  ctx.defer(`project ${String(body.name)}`, () => deleteProject(ctx, projectId))
  const envs = await ctx.api.get(`${V1}/environments?projectId=${projectId}`)
  const environmentId = str(listOf(envs.body, 'environments')[0], 'id')
  if (!environmentId) throw new Error(`project ${projectId} has no default environment`)
  return { projectId, environmentId }
}

/** Delete a project, retrying while the panel still sees running services. */
export async function deleteProject(ctx: CheckContext, projectId: string): Promise<void> {
  const done = await pollUntil(
    ctx,
    async () => {
      const res = await ctx.api.del(`${V1}/projects/${projectId}`)
      if ([200, 204, 404].includes(res.status)) return true
      if (res.status === 409) return undefined
      throw new Error(`delete project: HTTP ${res.status} ${excerpt(res.body)}`)
    },
    12,
    10_000
  )
  if (!done) throw new Error(`project ${projectId} still busy after 2 minutes`)
}

export interface CommandRecord {
  status: string
  record: Rec
}

/** Poll a queued command until it reaches a terminal status. */
export async function waitCommand(
  ctx: CheckContext,
  serverId: string,
  commandId: string,
  maxMs = 600_000
): Promise<CommandRecord> {
  const every = 5000
  const result = await pollUntil(
    ctx,
    async () => {
      const res = await ctx.api.get(`${V1}/servers/${serverId}/commands/${commandId}`)
      const record = objOf(res.body, 'command')
      const status = str(record, 'status')
      return TERMINAL.includes(status) ? { status, record } : undefined
    },
    Math.ceil(maxMs / every),
    every
  )
  return result ?? { status: 'poll_timeout', record: {} }
}

/** `{commandId, serverId}` from any enqueue response shape. */
export function queued(body: Json): { commandId: string; serverId: string } {
  const rec = objOf(body)
  return { commandId: str(rec, 'commandId'), serverId: str(rec, 'serverId') }
}

/** Compose document wrapper used by PATCH /environments/:id. */
export function composeOptions(
  services: { [name: string]: Json },
  root?: { [key: string]: Json }
): { [key: string]: Json } {
  const data: { [key: string]: Json } = { services }
  if (root) data['x-turbopanel'] = root
  return {
    compose: { version: 1, data, presentation: { comments: {}, keyOrder: Object.keys(services) } },
  }
}

export const APP_PRINCIPAL = { principals: { app: { access: 'none' } } }

/** Put services on an environment, placed on `serverId`. */
export async function setCompose(
  ctx: CheckContext,
  environmentId: string,
  serverId: string,
  options: { [key: string]: Json }
): Promise<void> {
  const res = await ctx.api.patch(`${V1}/environments/${environmentId}`, {
    body: { serverId, options },
  })
  expectStatus(res, 'set compose', 200, 204)
}

/** Stop an environment and wait for the stop to land (best effort). */
export async function stopEnvironment(ctx: CheckContext, environmentId: string): Promise<void> {
  const res = await ctx.api.post(`${V1}/environments/${environmentId}/stop`)
  if (res.status >= 300) return
  const q = queued(res.body)
  if (q.commandId && q.serverId) await waitCommand(ctx, q.serverId, q.commandId, 180_000)
}

export interface DeployResult {
  status: string
  commandId: string
  serverId: string
  error: string
}

/** Deploy an environment and wait; acknowledges optional health-check warnings once. */
export async function deploy(
  ctx: CheckContext,
  environmentId: string,
  extra: { [key: string]: Json } = {}
): Promise<DeployResult> {
  const path = `${V1}/environments/${environmentId}/deploy`
  let res = await ctx.api.post(path, { body: extra })
  if (res.status === 409 && /health_check_missing/.test(JSON.stringify(res.body))) {
    res = await ctx.api.post(path, { body: { ...extra, acknowledgeHealthCheckWarnings: true } })
  }
  expectStatus(res, 'deploy', 200, 201, 202)
  const q = queued(res.body)
  const done = await waitCommand(ctx, q.serverId, q.commandId)
  const error = str(done.record, 'errorMessage', 'error', 'errorCode')
  return { status: done.status, commandId: q.commandId, serverId: q.serverId, error }
}

/**
 * A compose project on the operator's `--host`, torn down (stop, then delete)
 * in cleanup. Returns undefined when no `--host` was given.
 */
export async function composeProject(
  ctx: CheckContext,
  label: string,
  services: { [name: string]: Json },
  root?: { [key: string]: Json }
): Promise<(ProjectRef & { server: Rec }) | undefined> {
  const server = await affectedServer(ctx)
  if (!server) return undefined
  const workspaceId = await createWorkspace(ctx, label)
  const serverId = str(server, 'id')
  const ref = await createProject(ctx, {
    workspaceId,
    type: 'empty',
    name: `${ctx.prefix}-${label}`,
    serverId,
  })
  ctx.defer(`stop environment ${ref.environmentId}`, () => stopEnvironment(ctx, ref.environmentId))
  await setCompose(ctx, ref.environmentId, serverId, composeOptions(services, root))
  return { ...ref, server }
}

/** Running service containers of one environment. */
export async function environmentContainers(ctx: CheckContext, environmentId: string) {
  const res = await ctx.api.get(`${V1}/containers?environmentId=${environmentId}`)
  return listOf(res.body, 'containers').filter((c) => str(c, 'role') !== 'ingress')
}

/** `curl` a hostname through the host's hosting proxy over SSH; '' when SSH is not available. */
export async function servedStatus(ctx: CheckContext, host: string, hostname: string) {
  if (!ctx.ssh) return ''
  const cmd = `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${hostname}' http://127.0.0.1/`
  return (await ctx.ssh(host, cmd).catch(() => 'ssh-error')).trim()
}

/** The `--ssh-host` spelling matching a server, if the operator passed one. */
export function sshNameFor(ctx: CheckContext, server: Rec): string | undefined {
  const short = shortHost(str(server, 'hostname'))
  return ctx.sshHosts.find((h) => shortHost(h) === short)
}
