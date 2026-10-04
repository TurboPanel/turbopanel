/**
 * Which ports the outside reachability probe checks on one server.
 *
 * The probe answers one question after a firewall change: "can the people and
 * traffic that must still get in, still get in?" It looks at three kinds of
 * port, taken from the same facts the derivation uses so the two cannot drift:
 *
 * - `invariant`: the ports a ruleset can never intentionally close: sshd, and
 *   on the control plane's own host its entrypoint. A change that cuts one is
 *   a lockout. They gate confirmation.
 * - `public`: tcp ports the derived ruleset opens to everyone (hosting 80/443,
 *   apps' published ports). They gate confirmation too, unless an enabled
 *   block/reject rule an operator typed covers the port: then closing it is the
 *   point, so it is not checked.
 * - `informational`: checked and reported, never gating. Today that is sshd
 *   when the organization limited SSH to some addresses (the control plane's
 *   own address may not be among them, so a failure would not mean a lockout).
 *
 * Pure: no database, no network.
 */

import { parseFirewallPortRange } from '../../contracts/commands/schemas.ts'
import type { FirewallDeriveInput } from './derive.ts'

export type ProbeRole = 'invariant' | 'public' | 'informational'

export type ProbePort = {
  port: number
  role: ProbeRole
  /** Plain words for the console: what listens there. */
  reason: string
}

export type ProbePortPlan = {
  ports: ProbePort[]
  /** Plain-words facts about ports that were left out, and why. */
  notes: string[]
}

/** Most public ports one server's check will dial; the rest are reported in `notes`. */
export const MAX_PUBLIC_PROBE_PORTS = 6

function blockedByTypedRule(port: number, edicts: FirewallDeriveInput['edicts']): boolean {
  return edicts.some((edict) => {
    if (edict.action === 'accept' || edict.proto === 'udp') return false
    if (edict.ports === null) return true
    const range = parseFirewallPortRange(edict.ports)
    return range !== null && port >= range.from && port <= range.to
  })
}

function sshPort(input: FirewallDeriveInput, notes: string[]): ProbePort {
  const port = input.sshPortHint ?? 22
  const everyone = input.policy.sshSources.includes('any')
  if (!everyone) {
    notes.push(
      `SSH is limited to some addresses, so the outside check only reports on port ${port} and does not gate on it`
    )
  }
  return {
    port,
    role: everyone ? 'invariant' : 'informational',
    reason: 'SSH',
  }
}

function controlPlanePorts(input: FirewallDeriveInput): ProbePort[] {
  if (!input.coLocated) return []
  return input.controlPlaneTcpPorts.map((port) => ({
    port,
    role: 'invariant' as const,
    reason: `Control plane port ${port}`,
  }))
}

function singlePublicPort(exposure: FirewallDeriveInput['exposures'][number]): number | null {
  if (exposure.proto !== 'tcp' || exposure.reach !== 'public') return null
  if (exposure.destination !== undefined) return null
  return /^\d{1,5}$/.test(exposure.ports) ? Number.parseInt(exposure.ports, 10) : null
}

function publicPorts(input: FirewallDeriveInput, taken: Set<number>, notes: string[]): ProbePort[] {
  const found: ProbePort[] = []
  let left = 0
  for (const exposure of input.exposures) {
    const port = singlePublicPort(exposure)
    if (port === null || taken.has(port)) continue
    if (blockedByTypedRule(port, input.edicts)) {
      notes.push(`Port ${port} is not checked: a rule you typed restricts it`)
      continue
    }
    taken.add(port)
    if (found.length >= MAX_PUBLIC_PROBE_PORTS) {
      left += 1
      continue
    }
    found.push({ port, role: 'public', reason: exposure.comment })
  }
  if (left > 0) notes.push(`${left} more public port(s) are not checked`)
  return found
}

/** The ports to check on a server, in the order they are reported. */
export function planProbePorts(input: FirewallDeriveInput): ProbePortPlan {
  const notes: string[] = []
  const first = sshPort(input, notes)
  const invariants = [first, ...controlPlanePorts(input)]
  const taken = new Set<number>()
  const ports: ProbePort[] = []
  for (const port of invariants) {
    if (taken.has(port.port)) continue
    taken.add(port.port)
    ports.push(port)
  }
  ports.push(...publicPorts(input, taken, notes))
  return { ports, notes }
}
