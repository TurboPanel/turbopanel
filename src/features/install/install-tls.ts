/**
 * Decide whether an install/control-plane origin needs bootstrap insecure TLS
 * (`curl -k` / `TURBOPANEL_INSECURE_TLS=1`).
 *
 * The decision follows the hostname's certificate source. Let's Encrypt uses
 * the system trust store. An uploaded leaf uses it only when that dialed
 * certificate is publicly trusted (`publicUploaded` on the matching hostname).
 * `TURBOPANEL_TLS_PUBLIC` is an aggregate compatibility signal: it marks
 * uploaded leaves public only when no sibling is Let's Encrypt and the dialed
 * certificate has no trust of its own. It is not proof for an unrelated
 * upload. A Platform CA hostname needs `-k` on `:8443` even when that flag
 * is set.
 *
 * With no stored source, a loopback, private, or LAN-TLD name needs `-k`.
 * Every Platform CA catch-all name on the self-hosted `:8443` listener —
 * including a private IP or a `.lan` name, listed or not — needs `-k` only
 * when that leaf's SANs cover it. A name the leaf does not cover is refused
 * before a command is returned. Let's Encrypt and uploaded hostnames use
 * their own leaf. A public name on another port (hosted control plane,
 * tunnel edge) uses system trust.
 *
 * `resolvePublicInstanceTls` reports the instance-wide flag. The CA route
 * serves the Platform CA bundle when the requested name hits the catch-all,
 * including an unlisted name, and withholds it when that name presents a
 * Let's Encrypt or uploaded leaf. URL-only copies of this helper in the
 * daemon and the UI do not see the certificate source; the server-rendered
 * install command is authoritative.
 */

import { coversHostname } from "../../lib/tls/match.ts";

export type InstallOriginCertificateSource =
  | "platform-ca"
  | "uploaded"
  | "lets-encrypt";

export type InstallOriginTlsOptions = {
  /** Certificate source of the hostname this origin dials. */
  source?: InstallOriginCertificateSource;
  /**
   * The uploaded leaf for this hostname chains to a public root. Honored
   * only when `source` is `uploaded`, and only for the hostname that was
   * dialed. A sibling upload's trust does not apply.
   */
  publicUploaded?: boolean;
  /**
   * The origin is dialed on the self-hosted control-plane listener. A
   * Platform CA name on that listener, including a private IP or `.lan`
   * alias, is the catch-all leaf.
   */
  selfHostedListener?: boolean;
};

/** Managed control-plane HTTPS listener. The Platform CA catch-all binds here. */
const SELF_HOSTED_LISTENER_PORT = "8443";

/**
 * Returned when an unlisted public `:8443` override is not a name the
 * Platform CA catch-all leaf covers. The install command is not emitted.
 */
export const UNLISTED_INSTALL_HOSTNAME_UNCOVERED =
  "Add this hostname under Admin → Access before installing. The Platform CA certificate does not cover it.";

/** One stored hostname plus that upload's own public-trust result. */
export type InstallHostnameTrust = {
  host?: string;
  source: InstallOriginCertificateSource;
  /**
   * This uploaded certificate chains to a public root. Absent means the
   * certificate was not checked; the aggregate flag then applies only when
   * no sibling is Let's Encrypt.
   */
  publicUploaded?: boolean;
};

export type InstallOriginTlsContext = {
  /** Sibling hostnames, including the dialed row's uploaded public trust. */
  hostnames?: readonly InstallHostnameTrust[];
  /** Dialed install origin. Selects that hostname's uploaded public trust. */
  origin?: string;
  selfHostedListener?: boolean;
};

const LOCAL_TLDS = new Set([
  "lan",
  "local",
  "internal",
  "home",
  "corp",
  "localhost",
]);

function stripIpv6Brackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateOrLoopbackIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === undefined || b === undefined) return false;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * True when the hostname resolves inside the operator's own network — loopback,
 * RFC1918 / link-local IPv4, unique-local or link-local IPv6, or a reserved LAN
 * TLD. Shared with `src/features/git/webhook-reachability.ts`, which needs the same
 * question answered for a different reason: a host the public internet cannot
 * route to is a host GitHub cannot deliver a webhook to.
 */
export function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host.startsWith("fe80:")) return true;
    // Unique local IPv6 (fc00::/7).
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
  }

  const octets = ipv4Octets(host);
  if (octets) return isPrivateOrLoopbackIpv4(octets);

  const tld = host.split(".").at(-1);
  return Boolean(tld && LOCAL_TLDS.has(tld));
}

function envFlag(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * True when `TURBOPANEL_TLS_PUBLIC` is set (`1` / `true`, case-insensitive).
 * Pure; no module-load I/O (Workers-bundle safe).
 */
export function resolvePublicInstanceTls(
  env: Record<string, string | undefined>,
): boolean {
  return envFlag(env, "TURBOPANEL_TLS_PUBLIC");
}

/**
 * True when the CA route should return the Platform CA bundle. The
 * instance-wide flag hides the bundle only for a name that presents a
 * Let's Encrypt or uploaded leaf. An unlisted name on the catch-all still
 * receives it.
 */
export function shouldServePlatformCaBundle(
  tlsPublic: boolean,
  presentsPlatformCaLeaf: boolean,
): boolean {
  if (!tlsPublic) return true;
  return presentsPlatformCaLeaf;
}

/** Host label of a URL, `Host` header, or stored hostname entry. */
export function hostLabel(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const host = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    ).hostname;
    const bare = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    return bare.length > 0 ? bare : null;
  } catch {
    return null;
  }
}

/**
 * Hostname the CA route was dialed as. The `Host` header wins; the request
 * URL is the fallback when that header is absent.
 */
export function dialedInstallHostname(
  hostHeader: string | undefined,
  requestUrl: string,
): string {
  const header = hostHeader?.trim() ?? "";
  if (header.length > 0) {
    const fromHeader = hostLabel(header);
    if (fromHeader) return fromHeader;
  }
  try {
    return new URL(requestUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when this request reaches the Platform CA catch-all. An unlisted name
 * does. A stored `platform-ca` name does. A Let's Encrypt or uploaded name
 * presents that leaf instead.
 */
export function hostnamePresentsPlatformCaLeaf(
  requestHost: string,
  hostnames: readonly {
    host: string;
    source: InstallOriginCertificateSource;
  }[],
): boolean {
  const wanted = hostLabel(requestHost);
  if (!wanted) return true;
  const match = hostnames.find((row) => hostLabel(row.host) === wanted);
  if (!match) return true;
  return match.source === "platform-ca";
}

function letsEncryptSibling(
  hostnames: InstallOriginTlsContext["hostnames"],
): boolean {
  return hostnames?.some((row) => row.source === "lets-encrypt") === true;
}

function declaredUploadedTrust(
  context: InstallOriginTlsContext,
): boolean | undefined {
  const origin = context.origin?.trim();
  if (!origin || !context.hostnames) return undefined;
  const wanted = hostLabel(origin);
  if (!wanted) return undefined;
  const match = context.hostnames.find((row) =>
    row.source === "uploaded" && hostLabel(row.host ?? "") === wanted
  );
  return match?.publicUploaded;
}

function uploadedLeafIsPublic(
  env: Record<string, string | undefined>,
  context: InstallOriginTlsContext,
): boolean {
  const declared = declaredUploadedTrust(context);
  if (declared !== undefined) return declared;
  if (letsEncryptSibling(context.hostnames)) return false;
  return resolvePublicInstanceTls(env);
}

function withSelfHostedListener(
  options: InstallOriginTlsOptions,
  selfHostedListener: boolean | undefined,
): InstallOriginTlsOptions {
  if (selfHostedListener !== true) return options;
  return { ...options, selfHostedListener: true };
}

/**
 * Options for {@link installOriginNeedsInsecureTls} from a known hostname
 * source. An uploaded leaf's public trust is that hostname's declaration,
 * not `TURBOPANEL_TLS_PUBLIC` forced by a Let's Encrypt sibling.
 */
export function installOriginTlsOptions(
  source: InstallOriginCertificateSource | undefined,
  env: Record<string, string | undefined>,
  context: InstallOriginTlsContext = {},
): InstallOriginTlsOptions {
  if (!source) {
    return withSelfHostedListener({}, context.selfHostedListener);
  }
  if (source === "uploaded") {
    return withSelfHostedListener({
      source,
      publicUploaded: uploadedLeafIsPublic(env, context),
    }, context.selfHostedListener);
  }
  return withSelfHostedListener({ source }, context.selfHostedListener);
}

function dialsSelfHostedListener(origin: string): URL | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return null;
    if (url.port !== SELF_HOSTED_LISTENER_PORT) return null;
    if (url.hostname.length === 0) return null;
    return url;
  } catch {
    return null;
  }
}

function servedByPlatformCaCatchAll(
  source: InstallOriginCertificateSource | undefined,
): boolean {
  return source === undefined || source === "platform-ca";
}

/**
 * Refusal when a self-hosted `:8443` origin is served by the Platform CA
 * catch-all and that leaf's SANs do not cover it. Private IPs and `.lan`
 * names are checked the same way as public names. Let's Encrypt and
 * uploaded sources use a different leaf and return null. An unreadable
 * leaf is a refusal.
 */
export function unlistedSelfHostedInstallRefusal(
  origin: string,
  opts: {
    source?: InstallOriginCertificateSource;
    selfHostedListener?: boolean;
    leafNames: readonly string[] | null;
  },
): string | null {
  if (!servedByPlatformCaCatchAll(opts.source)) return null;
  if (opts.selfHostedListener !== true) return null;
  const url = dialsSelfHostedListener(origin.trim());
  if (!url) return null;
  if (
    opts.leafNames && coversHostname([...opts.leafNames], url.hostname)
  ) {
    return null;
  }
  return UNLISTED_INSTALL_HOSTNAME_UNCOVERED;
}

function unlistedOriginNeedsInsecureTls(
  origin: string,
  opts: InstallOriginTlsOptions | undefined,
): boolean {
  try {
    const url = new URL(origin);
    if (isLoopbackOrPrivateHostname(url.hostname)) return true;
    return opts?.selfHostedListener === true &&
      url.port === SELF_HOSTED_LISTENER_PORT;
  } catch {
    return false;
  }
}

/**
 * True when bootstrap should skip public TLS verification for this origin
 * (Platform CA, an uploaded leaf that is not publicly trusted, or the
 * self-hosted `:8443` catch-all). False for Let's Encrypt, a publicly
 * trusted uploaded leaf, and a public hostname reached through an external
 * edge. Non-https origins are not TLS candidates.
 */
export function installOriginNeedsInsecureTls(
  origin: string,
  opts?: InstallOriginTlsOptions,
): boolean {
  const trimmed = origin.trim();
  if (!trimmed.startsWith("https://")) return false;
  if (trustedCertificateSource(opts)) return false;
  if (opts?.source === "platform-ca" || opts?.source === "uploaded") {
    return true;
  }
  return unlistedOriginNeedsInsecureTls(trimmed, opts);
}

function trustedCertificateSource(
  opts: InstallOriginTlsOptions | undefined,
): boolean {
  if (opts?.source === "lets-encrypt") return true;
  return opts?.source === "uploaded" && opts.publicUploaded === true;
}

/** Overlay artifact catalog on the same origin the installer was fetched from. */
export function formatInstanceDlBase(origin: string): string {
  return `${origin.replace(/\/$/, "")}/downloads/daemon`;
}
