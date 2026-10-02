/**
 * Host-affecting fleet checks on the first `--host`. Every change is undone in
 * cleanup (hostname reverted, daemon started, firewall rule removed). Daemon
 * stop and partition need `--ssh-host` for the same server. UIDs and the
 * Docker gate switch are never touched.
 */
import type { Check, CheckContext, SshExec } from '../types.ts'
import { affectedServer, createWorkspace, queued, sshNameFor, waitCommand } from './fixtures.ts'
import {
  excerpt,
  expectStatus,
  fail,
  listOf,
  objOf,
  pass,
  pollUntil,
  skip,
  str,
  type Rec,
} from './helpers.ts'
import { waitBackup, waitScheduledRun } from './managed.ts'

const V1 = '/client/v1'
const NO_HOST = 'needs --host <server> (not studio/adrastea/kore)'

/** Run `script` as root: directly when the SSH user is root, else via `sudo -n`. */
export function asRoot(script: string): string {
  const quoted = `'${script.replaceAll("'", `'\\''`)}'`
  return `if [ "$(id -u)" = 0 ]; then sh -c ${quoted}; else sudo -n sh -c ${quoted}; fi`
}

async function setHostname(ctx: CheckContext, serverId: string, hostname: string): Promise<string> {
  const res = await ctx.api.post(`${V1}/servers/${serverId}/hostname`, { body: { hostname } })
  if (res.status >= 300) return `HTTP ${res.status} ${excerpt(res.body, 80)}`
  return (
    await waitCommand(
      ctx,
      serverId,
      queued(res.body).commandId || str(objOf(res.body), 'commandId'),
      120_000
    )
  ).status
}

export const fleetHostname: Check = {
  rowId: 'fleet-hostname',
  title: "Change a server's hostname",
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const server = await affectedServer(ctx)
    if (!server) return skip(NO_HOST)
    const id = str(server, 'id')
    const original = str(server, 'hostname')
    const renamed = `${original}-clr`
    ctx.defer(`revert hostname ${original}`, async () => {
      const status = await setHostname(ctx, id, original)
      if (status !== 'succeeded') throw new Error(`revert hostname: ${status}`)
    })
    const status = await setHostname(ctx, id, renamed)
    const seen = await pollUntil(
      ctx,
      async () =>
        str((await findServerById(ctx, id)) ?? {}, 'hostname') === renamed ? true : undefined,
      12,
      5000
    )
    const evidence = `${original} -> ${renamed}: command ${status}, console shows new name: ${seen === true}; reverted in cleanup`
    return status === 'succeeded' && seen === true ? pass(evidence) : fail(evidence)
  },
}

async function findServerById(ctx: CheckContext, id: string): Promise<Rec | undefined> {
  const res = await ctx.api.get(`${V1}/servers/${id}`)
  return res.status === 200 ? objOf(res.body, 'server') : undefined
}

async function waitConnected(
  ctx: CheckContext,
  id: string,
  want: boolean,
  tries: number,
  everyMs: number
) {
  const started = Date.now()
  const hit = await pollUntil(
    ctx,
    async () => ((await findServerById(ctx, id))?.connected === want ? true : undefined),
    tries,
    everyMs
  )
  return { ok: hit === true, seconds: Math.round((Date.now() - started) / 1000) }
}

/** The affected server plus the `--ssh-host` spelling for it, or a skip reason. */
async function sshTarget(
  ctx: CheckContext
): Promise<{ server: Rec; host: string; exec: SshExec } | string> {
  const server = await affectedServer(ctx)
  if (!server) return NO_HOST
  const host = sshNameFor(ctx, server)
  if (!host || !ctx.ssh) return `needs --ssh-host for ${str(server, 'hostname')}`
  return { server, host, exec: ctx.ssh }
}

export const fleetOfflineOnline: Check = {
  rowId: 'fleet-offline-online',
  title: 'Stop and start the daemon',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const target = await sshTarget(ctx)
    if (typeof target === 'string') return skip(target)
    const exec = target.exec
    const id = str(target.server, 'id')
    ctx.defer('start turbopaneld', async () => {
      await exec(target.host, asRoot('systemctl start turbopaneld'))
    })
    await exec(target.host, asRoot('systemctl stop turbopaneld'))
    const down = await waitConnected(ctx, id, false, 40, 3000)
    await exec(target.host, asRoot('systemctl start turbopaneld'))
    const up = await waitConnected(ctx, id, true, 40, 3000)
    const restarts = await exec(
      target.host,
      'systemctl show -p NRestarts --value turbopaneld'
    ).catch(() => '?')
    const evidence = `${str(target.server, 'hostname')}: stop -> connected=false ${down.ok ? `in ~${down.seconds}s` : 'NOT seen'}; start -> connected=true ${up.ok ? `in ~${up.seconds}s` : 'NOT seen'}; NRestarts ${restarts.trim()}`
    return down.ok && up.ok ? pass(evidence) : fail(evidence)
  },
}

function partitionRule(op: '-I' | '-D', uid: string, tag: string): string {
  const spec = `OUTPUT -m owner --uid-owner ${uid} -m comment --comment ${tag} -j DROP`
  return `iptables ${op} ${spec}; ip6tables ${op} ${spec}`
}

export const resiliencePartition: Check = {
  rowId: 'resilience-partition',
  title: 'Network partition between a server and testing',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const target = await sshTarget(ctx)
    if (typeof target === 'string') return skip(target)
    const exec = target.exec
    const id = str(target.server, 'id')
    const user =
      (await exec(target.host, 'systemctl show -p User --value turbopaneld')).trim() || 'root'
    const uid = (await exec(target.host, `id -u ${user}`)).trim()
    if (!/^\d+$/.test(uid) || uid === '0')
      return skip(`daemon runs as uid ${uid}; refusing to drop root egress`)
    const heal = `${partitionRule('-D', uid, ctx.prefix)} || true`
    const deadman = `${ctx.prefix}-partition-deadman`
    ctx.defer('remove partition rule', async () => {
      await exec(
        target.host,
        asRoot(`${heal}; systemctl stop ${deadman}.timer 2>/dev/null || true`)
      )
    })
    // Host-side dead-man: heals the partition after 15 min even if this runner dies.
    await exec(
      target.host,
      asRoot(`systemd-run --unit=${deadman} --on-active=900 /bin/sh -c "${heal}"`)
    )
    await exec(target.host, asRoot(partitionRule('-I', uid, ctx.prefix)))
    const down = await waitConnected(ctx, id, false, 48, 10_000)
    const ping = await ctx.api.post(`${V1}/servers/${id}/commands/ping`)
    await exec(target.host, asRoot(`${partitionRule('-D', uid, ctx.prefix)} || true`))
    const up = await waitConnected(ctx, id, true, 36, 5000)
    const evidence = `${str(target.server, 'hostname')}: egress DROP for daemon uid -> offline ${down.ok ? `after ~${down.seconds}s` : 'NOT seen in 8 min'}; ping while offline HTTP ${ping.status} ${excerpt(ping.body, 80)}; healed -> online ${up.ok ? `after ~${up.seconds}s` : 'NOT seen'}`
    return down.ok && up.ok ? pass(evidence) : fail(evidence)
  },
}

export const backupsScheduleVolume: Check = {
  rowId: 'backups-schedule-volume',
  title: 'Schedule a tenant app volume backup on an interval',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const server = await affectedServer(ctx)
    if (!server) return skip(NO_HOST)
    const workspaceId = await createWorkspace(ctx, 'vol')
    const created = await ctx.api.post(`${V1}/storage`, {
      body: {
        kind: 'volume',
        name: `${ctx.prefix}-vol`,
        workspaceId,
        copy: { provider: 'docker', serverId: str(server, 'id') },
      },
    })
    expectStatus(created, 'create storage')
    const storageId = str(objOf(created.body), 'id')
    ctx.defer(`storage ${storageId}`, async () => {
      expectStatus(await ctx.api.del(`${V1}/storage/${storageId}`), 'delete storage', 200, 204, 404)
    })
    const copyId = str(
      listOf((await ctx.api.get(`${V1}/storage/${storageId}/copies`)).body, 'copies')[0],
      'id'
    )
    const base = `${V1}/storage/${storageId}/copies/${copyId}`
    const policy = await ctx.api.post(`${base}/backup-policies`, {
      body: {
        name: `${ctx.prefix}-vbk`,
        schedule: '*/2 * * * *',
        retentionKeep: 2,
        timezone: 'UTC',
      },
    })
    expectStatus(policy, 'create volume policy')
    const policyId = str(objOf(objOf(policy.body), 'policy'), 'id')
    ctx.defer('volume backups', () => deleteVolumeBackups(ctx, base, policyId))
    const manual = await ctx.api.post(`${base}/backups`)
    const manualStatus = await waitBackup(
      ctx,
      `${base}/backups`,
      str(objOf(manual.body), 'backupId')
    )
    const run = await waitScheduledRun(ctx, `${base}/backup-policies/${policyId}/runs`, 6)
    const evidence = `volume copy on ${str(server, 'hostname')}: policy ${policy.status} (*/2), manual backup ${manualStatus}, scheduled run ${run ? str(run, 'status') : 'none within 6 min'}`
    return ['succeeded', 'completed'].includes(manualStatus) && run
      ? pass(evidence)
      : fail(evidence)
  },
}

async function deleteVolumeBackups(
  ctx: CheckContext,
  base: string,
  policyId: string
): Promise<void> {
  await ctx.api.del(`${base}/backup-policies/${policyId}`)
  const backups = listOf((await ctx.api.get(`${base}/backups`)).body, 'backups')
  await backups.reduce<Promise<void>>(async (previous, b) => {
    await previous
    await ctx.api.del(`${base}/backups/${str(b, 'id')}`)
  }, Promise.resolve())
}

export const FLEET_HOST_CHECKS: readonly Check[] = [
  fleetHostname,
  fleetOfflineOnline,
  resiliencePartition,
  backupsScheduleVolume,
]
