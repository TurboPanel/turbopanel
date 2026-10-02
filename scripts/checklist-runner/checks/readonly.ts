/** Read-only checks: GET requests (and optional read-only SSH) only. */
import { FORBIDDEN_HOSTS, shortHost } from '../safety.ts'
import type { Check, CheckContext } from '../types.ts'
import { listServers, sshNameFor } from './fixtures.ts'
import { excerpt, fail, listOf, pass, sequential, skip, str, type Rec } from './helpers.ts'

const V1 = '/client/v1'

/** Studio is never a subject, not even of a read. */
function fleet(servers: Rec[]): Rec[] {
  return servers.filter((s) => !FORBIDDEN_HOSTS.includes(shortHost(str(s, 'hostname'))))
}

function describeServer(s: Rec): string {
  const os = (s.os ?? {}) as Rec
  const docker = (s.docker ?? {}) as Rec
  const flag = s.connected === true ? 'up' : 'DOWN'
  return `${str(s, 'hostname')}:${flag}/os ${str(os, 'version') || '?'}/docker ${str(docker, 'version') || '-'}`
}

export const fleetOverview: Check = {
  rowId: 'fleet-overview',
  title: 'Fleet list and server overview',
  requires: ['api'],
  safety: 'readonly',
  async run(ctx) {
    const servers = fleet(await listServers(ctx))
    if (servers.length === 0) return fail('GET /servers listed no servers')
    const down = servers.filter((s) => s.connected !== true)
    const noOs = servers.filter((s) => !str((s.os ?? {}) as Rec, 'version'))
    const summary = servers.map(describeServer).join(', ')
    if (down.length > 0 || noOs.length > 0) {
      return fail(`${down.length} disconnected, ${noOs.length} without OS version: ${summary}`)
    }
    const ssh = await sshCrossCheck(ctx, servers)
    return pass(
      `GET /servers: ${servers.length} servers all connected with OS/docker versions (${summary})${ssh}`
    )
  },
}

/** Compare the reported docker version with `docker version` on each `--ssh-host`. */
async function sshCrossCheck(ctx: CheckContext, servers: Rec[]): Promise<string> {
  if (!ctx.ssh || ctx.sshHosts.length === 0) return ''
  const exec = ctx.ssh
  const notes = await sequential(servers, async (s) => {
    const host = sshNameFor(ctx, s)
    if (!host) return ''
    const out = await exec(
      host,
      "docker version --format '{{.Server.Version}}' 2>/dev/null || true"
    )
    const reported = str((s.docker ?? {}) as Rec, 'version')
    return `${str(s, 'hostname')} docker ssh=${out.trim() || 'none'} api=${reported || 'none'}`
  })
  const used = notes.filter(Boolean)
  return used.length > 0 ? `; ssh: ${used.join(', ')}` : ''
}

export const fleetDaemonUpdate: Check = {
  rowId: 'fleet-daemon-update',
  title: 'Daemons on the channel target',
  requires: ['api'],
  safety: 'readonly',
  async run(ctx) {
    const res = await ctx.api.get(`${V1}/servers/updates`)
    if (res.status !== 200) return fail(`GET /servers/updates HTTP ${res.status}`)
    const body = (res.body ?? {}) as Rec
    const target = str((body.target ?? {}) as Rec, 'commit').slice(0, 7)
    const rows = listOf(res.body, 'servers')
    const behind = rows.filter((r) => r.updateAvailable === true)
    const commits = new Set(rows.map((r) => str((r.current ?? {}) as Rec, 'commit').slice(0, 7)))
    const evidence = `target ${target || '?'}; ${rows.length} servers on ${[...commits].join(',')}; ${behind.length} with updateAvailable`
    return behind.length === 0 && rows.length > 0 ? pass(evidence) : fail(evidence)
  },
}

export const opsAudit: Check = {
  rowId: 'ops-audit',
  title: 'Audit records',
  requires: ['api'],
  safety: 'readonly',
  async run(ctx) {
    const res = await ctx.api.get(`${V1}/organizations/${ctx.api.orgId}/audit?limit=20`)
    if (res.status !== 200) {
      return fail(`GET /organizations/:id/audit HTTP ${res.status} ${excerpt(res.body, 120)}`)
    }
    const entries = listOf(res.body, 'entries')
    const complete = entries.filter((e) => str(e, 'action') && str(e, 'createdAt') && e.actorUserId)
    if (entries.length === 0) return fail('audit returned 200 but no entries')
    const actions = [...new Set(entries.map((e) => str(e, 'action')))].slice(0, 6).join(', ')
    const evidence = `audit 200: ${entries.length} entries, ${complete.length} with actor+action+time (${actions})`
    return complete.length === entries.length ? pass(evidence) : fail(evidence)
  },
}

export const opsContainerLogs: Check = {
  rowId: 'ops-container-logs',
  title: 'Container logs on demand',
  requires: ['api'],
  safety: 'readonly',
  async run(ctx) {
    const servers = fleet(await listServers(ctx))
    const allowed = new Set(servers.map((s) => str(s, 'id')))
    const res = await ctx.api.get(`${V1}/containers?status=running`)
    const running = listOf(res.body, 'containers').filter(
      (c) => str(c, 'status') === 'running' && allowed.has(str(c, 'serverId'))
    )
    const byRole = (role: string) => running.filter((c) => str(c, 'role') === role)
    const sample = [
      ...pickAcrossServers(byRole('service'), 3),
      ...pickAcrossServers(byRole('ingress'), 1),
    ]
    if (sample.length === 0) return skip('no running containers outside studio to read logs from')
    const results = await sequential(sample, async (c) => {
      const logs = await ctx.api.get(`${V1}/containers/${str(c, 'id')}/logs?tail=20`)
      const ok = logs.status === 200 && typeof ((logs.body ?? {}) as Rec).logs === 'string'
      return {
        ok,
        note: `${str(c, 'containerName') || str(c, 'id')}: HTTP ${logs.status}${ok ? '' : ` ${excerpt(logs.body, 80)}`}`,
      }
    })
    const evidence = `GET /containers/:id/logs?tail=20 on ${sample.length} running containers (service + ingress): ${results.map((r) => r.note).join('; ')}`
    return results.every((r) => r.ok) ? pass(evidence) : fail(evidence)
  },
}

/** Up to `n` containers, preferring distinct servers. */
function pickAcrossServers(containers: Rec[], n: number): Rec[] {
  const byServer = new Map<string, Rec>()
  for (const c of containers) {
    const sid = str(c, 'serverId')
    if (!byServer.has(sid)) byServer.set(sid, c)
  }
  return [...byServer.values()].slice(0, n)
}

/** Every address the panel reports must show up in `ip -j addr` on the host. */
export const networkAddresses: Check = {
  rowId: 'network-addresses',
  title: 'Addresses page matches ip addr',
  requires: ['api'],
  safety: 'readonly',
  async run(ctx) {
    if (!ctx.ssh || ctx.sshHosts.length === 0)
      return skip('needs --ssh-host to compare with ip addr')
    const exec = ctx.ssh
    const servers = fleet(await listServers(ctx)).filter((s) => sshNameFor(ctx, s))
    if (servers.length === 0) return skip('no --ssh-host matches a server in this organization')
    const results = await sequential(servers, async (s) => {
      const host = sshNameFor(ctx, s) ?? ''
      const local = await exec(host, 'ip -j addr')
      const reported = listOf({ ips: s.ips ?? [] }, 'ips').map((ip) => str(ip, 'address'))
      const missing = reported.filter((a) => a && !local.includes(`"${a}"`))
      return {
        ok: reported.length > 0 && missing.length === 0,
        note: `${str(s, 'hostname')}: ${reported.length} reported, missing on host [${missing.join(' ')}]`,
      }
    })
    const evidence = results.map((r) => r.note).join('; ')
    return results.every((r) => r.ok) ? pass(evidence) : fail(evidence)
  },
}

export const READONLY_CHECKS: readonly Check[] = [
  fleetOverview,
  fleetDaemonUpdate,
  opsAudit,
  opsContainerLogs,
  networkAddresses,
]
