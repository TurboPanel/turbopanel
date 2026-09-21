/**
 * Optional host-IPv4 discovery port.
 *
 * The Deno composition root registers the filesystem/interface implementation.
 * Workers never registers one, so public-base-URL fallback stays `localhost`.
 * Shared modules import this port instead of `platform/deno`.
 */

export type HostIpv4Discovery = () => string | null

let discovery: HostIpv4Discovery | null = null

export function setHostIpv4Discovery(fn: HostIpv4Discovery | null): void {
  discovery = fn
}

export function discoverHostIpv4(): string | null {
  return discovery?.() ?? null
}
