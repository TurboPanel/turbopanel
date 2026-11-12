/**
 * Where the control plane's own hostnames come from, chosen by runtime.
 *
 * - **High availability (Workers):** only the platform environment,
 *   `TURBOPANEL_BASE_URL` first, then `TURBOPANEL_PUBLIC_URLS`. The control
 *   plane answers on 443 there, so every origin is port-free. Stored hostname
 *   rows are ignored: nothing may add one through the API on this runtime, and
 *   a row left behind must not change a link, a passkey origin or a hello.
 * - **Self-hosted (Deno):** only the hostname rows edited under Admin › Access
 *   › Hostnames. The process environment is never consulted; with no rows the
 *   caller falls back to the discovered address.
 *
 * Workers-safe: no Deno APIs, no I/O beyond the database read on Deno.
 */

import type { Db } from '../../db/connection.ts'
import { type InstanceHostnameRecord, listInstanceHostnames } from './instance-hostnames.ts'
import { orderedPublicOrigins } from './public-origins.ts'
import { formatHostForUrl, publicHttpsOrigin } from './public-urls.ts'

export type ControlPlaneRuntime = 'deno' | 'workers'

/** The two platform variables that name the hosted control plane. */
type PlatformEnv = Readonly<{ TURBOPANEL_BASE_URL?: string; TURBOPANEL_PUBLIC_URLS?: string }>

/** One platform entry (`https://host`, `host` or either with a port) as a port-free origin. */
function portlessPlatformOrigin(entry: string): string | null {
  const trimmed = entry.trim()
  if (!trimmed) return null
  const origin = publicHttpsOrigin(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  if (!origin) return null
  return `https://${formatHostForUrl(new URL(origin).hostname)}`
}

/**
 * The hosted control plane's origins from the platform environment, the base
 * URL first, normalized, port-free and de-duplicated. Empty when unset.
 */
export function platformControlPlaneOrigins(env: PlatformEnv | undefined): string[] {
  const entries = [
    env?.TURBOPANEL_BASE_URL ?? '',
    ...(env?.TURBOPANEL_PUBLIC_URLS ?? '').split(','),
  ]
  const origins = entries.map(portlessPlatformOrigin)
  return [...new Set(origins.filter((origin): origin is string => origin !== null))]
}

/** The hosted control plane's preferred origin, or `null` when the platform sets none. */
export function platformControlPlaneOrigin(env: PlatformEnv | undefined): string | null {
  return platformControlPlaneOrigins(env)[0] ?? null
}

/** The stored hostname rows that count on this runtime: none on Workers. */
export async function controlPlaneHostnameRows(
  db: Db,
  runtime: ControlPlaneRuntime | undefined
): Promise<InstanceHostnameRecord[]> {
  if (runtime === 'workers') return []
  return await listInstanceHostnames(db)
}

/**
 * The control plane's public origins, the preferred one first: the platform
 * environment on Workers, the stored rows (primary first) on Deno.
 */
export async function controlPlaneOrigins(
  db: Db | undefined,
  input: { runtime?: ControlPlaneRuntime; platformEnv?: PlatformEnv }
): Promise<string[]> {
  if (input.runtime === 'workers') return platformControlPlaneOrigins(input.platformEnv)
  return db ? orderedPublicOrigins(await listInstanceHostnames(db)) : []
}
