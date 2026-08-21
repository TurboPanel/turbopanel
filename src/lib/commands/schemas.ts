import { HOSTNAME_MAX_LENGTH, isValidHostname } from "./hostname.ts";
import { isValidCidr, isValidIpAddress } from "../ip-address.ts";
import {
  isManagedIngressProtocolPort,
  type ManagedIngressFamily,
  type ManagedIngressPorts,
  type ManagedIngressProtocolPort,
  validateManagedIngressPorts,
} from "../managed/ingress-ports.ts";
import {
  isManagedBackupArtifactExtension,
  isManagedEngineCode,
  type ManagedBackupArtifactExtension,
  type ManagedEngineCode,
} from "../managed/types.ts";
import {
  getManagedReservedEnvKeys,
  isManagedImageAllowed,
  type ManagedDockerOptions,
  parseManagedDockerOptions,
} from "../managed/settings.ts";
import {
  ingressContainerNameFromService,
  isValidDockerResourceName,
  managedContainerName,
  managedHaContainerNameFromService,
} from "../naming.ts";
import {
  HA_PROMOTION_RULE_MUST_NOT,
  HA_PROMOTION_RULE_PREFER,
  type HaPromotionRule,
} from "../managed/ha-policy.ts";
import type { ServiceOptions } from "../service-options.ts";
import { isValidTimezone } from "../timezones.ts";
import {
  isValidWireguardAllowedIp,
  isValidWireguardEndpoint,
  isValidWireguardListenPort,
  isValidWireguardPublicKey,
} from "../fabric/wg.ts";
import { ENVELOPE_PREFIX_DAEMON } from "../../client/authn/data-encryption.ts";
import type { CommandType } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/;

/** Dotted-quad shape (octets validated separately). Daemon parity. */
const IPV4_SHAPE_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Must stay in sync with the daemon `server.ntp.set` validator. */
function isValidIpv4Literal(value: string): boolean {
  if (!IPV4_SHAPE_RE.test(value)) return false;
  const octets = value.split(".");
  for (const octet of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return false;
    const n = Number(octet);
    if (n > 255) return false;
  }
  return true;
}

/**
 * Conservative IPv6 literal check (RFC 4291 / RFC 5952 shapes).
 * Must stay in sync with the daemon `server.ntp.set` validator.
 */
function isValidIpv6Literal(value: string): boolean {
  if (!value.includes(":")) return false;
  if (value.includes("%")) return false;
  if (value.includes(":::")) return false;

  const sides = value.split("::");
  if (sides.length > 2) return false;

  const parseSide = (side: string): number | null => {
    if (side === "") return 0;
    const parts = side.split(":");
    let hextets = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        if (!isValidIpv4Literal(part)) return null;
        hextets += 2;
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      hextets += 1;
    }
    return hextets;
  };

  if (sides.length === 1) {
    const count = parseSide(sides[0]!);
    return count === 8;
  }

  const left = parseSide(sides[0]!);
  const right = parseSide(sides[1]!);
  if (left === null || right === null) return false;
  return left + right < 8;
}

/** Must stay in sync with the daemon `server.ntp.set` validator. */
export function isValidNtpServer(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > HOSTNAME_MAX_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  if (IPV4_SHAPE_RE.test(value)) return isValidIpv4Literal(value);
  if (value.includes(":")) return isValidIpv6Literal(value);
  if (isValidHostname(value)) return true;
  return false;
}

export type PingCommandPayload = Record<string, never>;

export type RebootCommandPayload = Record<string, never>;

export type HostnameSetCommandPayload = {
  hostname: string;
};

export function parsePingPayload(value: unknown): PingCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid ping payload");
  }
  return {};
}

export function parseRebootPayload(value: unknown): RebootCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid reboot payload");
  }
  return {};
}

export function parseHostnameSetPayload(
  value: unknown,
): HostnameSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid hostname set payload");
  }
  const hostname = value.hostname;
  if (
    !isString(hostname) || hostname.length === 0 || !isValidHostname(hostname)
  ) {
    throw new Error("Invalid hostname set payload");
  }
  return { hostname };
}

export type PingCommandResult = {
  apiAcceptedAt?: string;
  queuedAt?: string;
  consumerReceivedAt?: string;
  cellEnqueuedAt?: string;
  /** Instance-side WS send time from the cell outbox pump (`markSent`). */
  cellDispatchedAt?: string;
  daemonReceivedAt?: string;
  daemonRespondedAt?: string;
  resultRecordedAt?: string;
  daemonHostname?: string;
  daemonBuild?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
};

export type HostnameSetCommandResult = {
  observedHostname: string;
  summary?: string;
};

export type RebootCommandResult = {
  scheduled: boolean;
  summary?: string;
};

/** Must stay in sync with the daemon `server.timezone.set` shape. */
export type TimezoneSetCommandPayload = {
  timezone: string;
};

/** Must stay in sync with the daemon `server.timezone.set` shape. */
export type TimezoneSetCommandResult = {
  timezone: string;
  summary?: string;
};

/** Must stay in sync with the daemon `server.ntp.set` shape. */
export type NtpSetCommandPayload = {
  enabled?: boolean;
  servers?: string[];
  fallbackServers?: string[];
};

/** Must stay in sync with the daemon `server.ntp.set` shape. */
export type NtpSetCommandResult = {
  ntpEnabled?: boolean;
  ntpSynced?: boolean;
  ntpServers: string[];
  fallbackNtpServers?: string[];
  summary?: string;
};

/** Must stay in sync with the daemon `server.tls.trust.reconcile` shape. */
export type TlsTrustReconcileCommandPayload = {
  bundlePem: string;
  fingerprint: string;
  allowRemoval?: boolean;
};

/** Must stay in sync with the daemon `server.tls.trust.reconcile` shape. */
export type TlsTrustReconcileCommandResult = {
  applied: boolean;
  fingerprint: string;
};

export function parseTimezoneSetPayload(
  value: unknown,
): TimezoneSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid timezone set payload");
  }
  const timezone = value.timezone;
  if (
    !isString(timezone) || timezone.length === 0 || !isValidTimezone(timezone)
  ) {
    throw new Error("Invalid timezone set payload");
  }
  return { timezone };
}

export function parseTimezoneSetResult(
  value: unknown,
): TimezoneSetCommandResult {
  if (!isRecord(value)) {
    throw new Error("Invalid timezone set result");
  }
  const timezone = value.timezone;
  if (!isString(timezone) || timezone.length === 0) {
    throw new Error("Invalid timezone set result");
  }
  const result: TimezoneSetCommandResult = { timezone };
  if (isString(value.summary)) {
    result.summary = value.summary;
  }
  return result;
}

function parseOptionalNtpServerList(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of server hostnames or IPs`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must not be empty when provided`);
  }
  const servers: string[] = [];
  for (const entry of value) {
    if (!isValidNtpServer(entry)) {
      throw new Error(`Invalid NTP server in ${field}`);
    }
    servers.push(entry as string);
  }
  return servers;
}

export function parseNtpSetPayload(value: unknown): NtpSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid ntp set payload");
  }
  const payload: NtpSetCommandPayload = {};

  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new TypeError("enabled must be a boolean");
    }
    payload.enabled = value.enabled;
  }

  const servers = parseOptionalNtpServerList(value.servers, "servers");
  if (servers !== undefined) payload.servers = servers;

  const fallbackServers = parseOptionalNtpServerList(
    value.fallbackServers,
    "fallbackServers",
  );
  if (fallbackServers !== undefined) payload.fallbackServers = fallbackServers;

  if (
    payload.enabled === undefined &&
    payload.servers === undefined &&
    payload.fallbackServers === undefined
  ) {
    throw new Error(
      "ntp payload must include enabled, servers, and/or fallbackServers",
    );
  }

  return payload;
}

function parseRequiredNtpServerList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of server hostnames or IPs`);
  }
  const servers: string[] = [];
  for (const entry of value) {
    if (!isValidNtpServer(entry)) {
      throw new Error(`Invalid NTP server in ${field}`);
    }
    servers.push(entry as string);
  }
  return servers;
}

export function parseNtpSetResult(value: unknown): NtpSetCommandResult {
  if (!isRecord(value)) {
    throw new Error("Invalid ntp set result");
  }
  const result: NtpSetCommandResult = {
    ntpServers: parseRequiredNtpServerList(value.ntpServers, "ntpServers"),
  };
  if (typeof value.ntpEnabled === "boolean") {
    result.ntpEnabled = value.ntpEnabled;
  }
  if (typeof value.ntpSynced === "boolean") result.ntpSynced = value.ntpSynced;
  const fallback = parseOptionalNtpServerList(
    value.fallbackNtpServers,
    "fallbackNtpServers",
  );
  if (fallback !== undefined) result.fallbackNtpServers = fallback;
  if (isString(value.summary)) result.summary = value.summary;
  return result;
}

export function parseTlsTrustReconcilePayload(
  value: unknown,
): TlsTrustReconcileCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid tls trust reconcile payload");
  }
  const bundlePem = value.bundlePem;
  const fingerprint = value.fingerprint;
  if (!isString(bundlePem) || bundlePem.trim().length === 0) {
    throw new Error("bundlePem must be a non-empty PEM string");
  }
  if (!isString(fingerprint) || fingerprint.trim().length === 0) {
    throw new Error("fingerprint must be a non-empty string");
  }
  if (!bundlePem.includes("BEGIN CERTIFICATE")) {
    throw new Error("bundlePem must contain at least one certificate");
  }
  const payload: TlsTrustReconcileCommandPayload = {
    bundlePem,
    fingerprint,
  };
  if (value.allowRemoval !== undefined) {
    if (typeof value.allowRemoval !== "boolean") {
      throw new TypeError("allowRemoval must be a boolean");
    }
    payload.allowRemoval = value.allowRemoval;
  }
  return payload;
}

export function parseTlsTrustReconcileResult(
  value: unknown,
): TlsTrustReconcileCommandResult {
  if (!isRecord(value)) {
    throw new Error("Invalid tls trust reconcile result");
  }
  if (typeof value.applied !== "boolean") {
    throw new TypeError("applied must be a boolean");
  }
  const fingerprint = value.fingerprint;
  if (!isString(fingerprint) || fingerprint.trim().length === 0) {
    throw new Error("fingerprint must be a non-empty string");
  }
  return { applied: value.applied, fingerprint };
}

function parseDaemonBuild(value: unknown): PingCommandResult["daemonBuild"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const build: NonNullable<PingCommandResult["daemonBuild"]> = {};
  if (isString(value.commit)) build.commit = value.commit;
  if (isString(value.buildId)) build.buildId = value.buildId;
  if (isString(value.builtAt)) build.builtAt = value.builtAt;
  if (isString(value.channel)) build.channel = value.channel;
  return Object.keys(build).length > 0 ? build : undefined;
}

export function parsePingResult(value: unknown): PingCommandResult {
  if (!isRecord(value)) {
    return {};
  }
  const result: PingCommandResult = {};
  if (isString(value.apiAcceptedAt)) result.apiAcceptedAt = value.apiAcceptedAt;
  if (isString(value.queuedAt)) result.queuedAt = value.queuedAt;
  if (isString(value.consumerReceivedAt)) {
    result.consumerReceivedAt = value.consumerReceivedAt;
  }
  if (isString(value.cellEnqueuedAt)) {
    result.cellEnqueuedAt = value.cellEnqueuedAt;
  }
  if (isString(value.cellDispatchedAt)) {
    result.cellDispatchedAt = value.cellDispatchedAt;
  }
  if (isString(value.daemonReceivedAt)) {
    result.daemonReceivedAt = value.daemonReceivedAt;
  }
  if (isString(value.daemonRespondedAt)) {
    result.daemonRespondedAt = value.daemonRespondedAt;
  }
  if (isString(value.resultRecordedAt)) {
    result.resultRecordedAt = value.resultRecordedAt;
  }
  if (isString(value.daemonHostname)) {
    result.daemonHostname = value.daemonHostname;
  }
  const daemonBuild = parseDaemonBuild(value.daemonBuild);
  if (daemonBuild) result.daemonBuild = daemonBuild;
  return result;
}

export function parseHostnameSetResult(
  value: unknown,
): HostnameSetCommandResult {
  if (!isRecord(value)) {
    throw new Error("Invalid hostname set result");
  }
  const observedHostname = value.observedHostname;
  if (!isString(observedHostname) || observedHostname.length === 0) {
    throw new Error("Invalid hostname set result");
  }
  const result: HostnameSetCommandResult = { observedHostname };
  if (isString(value.summary)) {
    result.summary = value.summary;
  }
  return result;
}

export function parseRebootResult(value: unknown): RebootCommandResult {
  if (!isRecord(value)) {
    return { scheduled: false };
  }
  const result: RebootCommandResult = {
    scheduled: value.scheduled === true,
  };
  if (isString(value.summary)) {
    result.summary = value.summary;
  }
  return result;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Must stay in sync with the daemon `server.fabric.reconcile` shape. */
export type FabricReconcilePeerPathKind =
  | "direct_lan"
  | "direct_public"
  | "direct_nat"
  | "gateway";

/** Must stay in sync with the daemon `server.fabric.reconcile` shape. */
export type FabricReconcilePeerMaterial = {
  publicKey: string;
  endpoint?: string;
  allowedIPs: string[];
  /** Daemon-recipient sealed PSK (`tpdaemon.…`). */
  presharedKeyEnvelope?: string;
  keepalive?: number;
  pathKind?: FabricReconcilePeerPathKind;
  viaServerId?: string;
};

/** Must stay in sync with the daemon `server.fabric.reconcile` shape. */
export type FabricReconcileNetworkMaterial = {
  name: string;
  subnet: string;
  mtu?: number;
  gateway?: string;
};

/**
 * Must stay in sync with the daemon `server.fabric.reconcile` shape.
 * `{ enabled: false }` is a **tear down** (`tp0`, routed bridges, `TP-FORWARD`,
 * keys, state) — not a no-op.
 */
export type FabricReconcileCommandPayload =
  | { enabled: false }
  | {
    enabled: true;
    fabricId?: string;
    listenPort?: number;
    mtu?: number;
    address: string;
    prefix: string;
    peers: FabricReconcilePeerMaterial[];
    networks?: FabricReconcileNetworkMaterial[];
    gateway?: boolean;
  };

export type FabricPeerHealth = "healthy" | "stale" | "never";

const FABRIC_PEER_HEALTH = new Set<FabricPeerHealth>([
  "healthy",
  "stale",
  "never",
]);

export type FabricReconcileObservedPeer = {
  publicKey: string;
  lastHandshakeAt?: string;
  transferRx?: number;
  transferTx?: number;
  endpoint?: string;
  health?: FabricPeerHealth;
};

/**
 * Must stay in sync with the daemon `server.fabric.reconcile` shape.
 * Enable returns `publicKey`; `{ enabled: false }` teardown is summary-only.
 */
export type FabricReconcileCommandResult = {
  summary: string;
  publicKey?: string;
  skipped?: boolean;
  peers?: FabricReconcileObservedPeer[];
};

const FABRIC_DOCKER_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function parseFabricUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new TypeError(`Invalid fabric ${field}`);
  }
  return value;
}

const FABRIC_MTU_MIN = 1280;
const FABRIC_MTU_MAX = 9000;

function parseFabricKeepalive(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new TypeError("Invalid fabric peer keepalive");
  }
  return value;
}

function parseFabricMtu(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < FABRIC_MTU_MIN ||
    value > FABRIC_MTU_MAX
  ) {
    throw new TypeError(`Invalid fabric ${field}`);
  }
  return value;
}

const FABRIC_PEER_PATH_KINDS = new Set<FabricReconcilePeerPathKind>([
  "direct_lan",
  "direct_public",
  "direct_nat",
  "gateway",
]);

function parseFabricPeerPathKind(value: unknown): FabricReconcilePeerPathKind {
  if (
    typeof value !== "string" ||
    !FABRIC_PEER_PATH_KINDS.has(value as FabricReconcilePeerPathKind)
  ) {
    throw new TypeError("Invalid fabric peer pathKind");
  }
  return value as FabricReconcilePeerPathKind;
}

function parseFabricPeerEntry(value: unknown): FabricReconcilePeerMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid fabric peer entry");
  }
  const publicKey = value.publicKey;
  if (!isString(publicKey) || !isValidWireguardPublicKey(publicKey)) {
    throw new TypeError("Invalid fabric peer publicKey");
  }
  if (!Array.isArray(value.allowedIPs) || value.allowedIPs.length === 0) {
    throw new TypeError("Invalid fabric peer allowedIPs");
  }
  const allowedIPs: string[] = [];
  for (const entry of value.allowedIPs) {
    if (!isValidWireguardAllowedIp(entry)) {
      throw new TypeError("Invalid fabric peer allowedIPs");
    }
    allowedIPs.push((entry as string).trim());
  }
  const peer: FabricReconcilePeerMaterial = { publicKey, allowedIPs };
  if (value.endpoint !== undefined) {
    if (
      !isString(value.endpoint) || !isValidWireguardEndpoint(value.endpoint)
    ) {
      throw new TypeError("Invalid fabric peer endpoint");
    }
    peer.endpoint = value.endpoint;
  }
  if (value.presharedKeyEnvelope !== undefined) {
    if (
      !isString(value.presharedKeyEnvelope) ||
      !value.presharedKeyEnvelope.startsWith(ENVELOPE_PREFIX_DAEMON)
    ) {
      throw new TypeError("Invalid fabric peer presharedKeyEnvelope");
    }
    peer.presharedKeyEnvelope = value.presharedKeyEnvelope;
  }
  if (value.keepalive !== undefined) {
    peer.keepalive = parseFabricKeepalive(value.keepalive);
  }
  if (value.pathKind !== undefined) {
    peer.pathKind = parseFabricPeerPathKind(value.pathKind);
  }
  if (value.viaServerId !== undefined) {
    peer.viaServerId = parseFabricUuid(value.viaServerId, "peer viaServerId");
  }
  return peer;
}

function parseFabricNetworkEntry(
  value: unknown,
): FabricReconcileNetworkMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid fabric network entry");
  }
  const name = value.name;
  if (!isString(name) || !FABRIC_DOCKER_NETWORK_NAME_RE.test(name)) {
    throw new TypeError("Invalid fabric network name");
  }
  const subnet = value.subnet;
  if (!isString(subnet) || !isValidWireguardAllowedIp(subnet)) {
    throw new TypeError("Invalid fabric network subnet");
  }
  const network: FabricReconcileNetworkMaterial = {
    name,
    subnet: subnet.trim(),
  };
  if (value.mtu !== undefined) {
    network.mtu = parseFabricMtu(value.mtu, "network mtu");
  }
  if (value.gateway !== undefined) {
    if (!isString(value.gateway) || !isValidIpv4Literal(value.gateway)) {
      throw new TypeError("Invalid fabric network gateway");
    }
    network.gateway = value.gateway;
  }
  return network;
}

function parseEnabledFabricPayload(
  value: Record<string, unknown>,
): Extract<FabricReconcileCommandPayload, { enabled: true }> {
  const address = value.address;
  if (!isString(address) || !isValidWireguardAllowedIp(address)) {
    throw new TypeError("Invalid fabric address");
  }
  const prefix = value.prefix;
  if (!isString(prefix) || !isValidWireguardAllowedIp(prefix)) {
    throw new TypeError("Invalid fabric prefix");
  }
  if (!Array.isArray(value.peers)) {
    throw new TypeError("Invalid fabric peers");
  }
  const payload: Extract<FabricReconcileCommandPayload, { enabled: true }> = {
    enabled: true,
    address: address.trim(),
    prefix: prefix.trim(),
    peers: value.peers.map(parseFabricPeerEntry),
  };
  if (value.fabricId !== undefined) {
    payload.fabricId = parseFabricUuid(value.fabricId, "fabricId");
  }
  if (value.listenPort !== undefined) {
    if (!isValidWireguardListenPort(value.listenPort)) {
      throw new TypeError("Invalid fabric listenPort");
    }
    payload.listenPort = value.listenPort;
  }
  if (value.mtu !== undefined) {
    payload.mtu = parseFabricMtu(value.mtu, "mtu");
  }
  if (value.networks !== undefined) {
    if (!Array.isArray(value.networks)) {
      throw new TypeError("Invalid fabric networks");
    }
    payload.networks = value.networks.map(parseFabricNetworkEntry);
  }
  if (value.gateway !== undefined) {
    if (typeof value.gateway !== "boolean") {
      throw new TypeError("Invalid fabric gateway");
    }
    payload.gateway = value.gateway;
  }
  return payload;
}

export function parseFabricReconcilePayload(
  value: unknown,
): FabricReconcileCommandPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid fabric reconcile payload");
  }
  if (typeof value.enabled !== "boolean") {
    throw new TypeError("Invalid fabric enabled");
  }
  if (!value.enabled) {
    return { enabled: false };
  }
  return parseEnabledFabricPayload(value);
}

export function parseFabricReconcileResult(
  value: unknown,
): FabricReconcileCommandResult {
  if (!isRecord(value)) {
    throw new TypeError("Invalid fabric reconcile result");
  }
  const summary = value.summary;
  if (!isString(summary) || summary.length === 0) {
    throw new TypeError("Invalid fabric reconcile result summary");
  }
  const result: FabricReconcileCommandResult = { summary };
  if (value.skipped !== undefined) {
    if (typeof value.skipped !== "boolean") {
      throw new TypeError("Invalid fabric reconcile result skipped");
    }
    result.skipped = value.skipped;
  }
  if (value.publicKey !== undefined) {
    if (
      !isString(value.publicKey) || !isValidWireguardPublicKey(value.publicKey)
    ) {
      throw new TypeError("Invalid fabric reconcile result publicKey");
    }
    result.publicKey = value.publicKey;
  }
  if (value.peers !== undefined) {
    if (!Array.isArray(value.peers)) {
      throw new TypeError("Invalid fabric reconcile result peers");
    }
    result.peers = value.peers.map(parseFabricObservedPeer);
  }
  return result;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`Invalid fabric reconcile result ${field}`);
  }
  return value;
}

function parseFabricObservedPeer(value: unknown): FabricReconcileObservedPeer {
  if (!isRecord(value)) {
    throw new TypeError("Invalid fabric reconcile result peer");
  }
  const publicKey = value.publicKey;
  if (!isString(publicKey) || !isValidWireguardPublicKey(publicKey)) {
    throw new TypeError("Invalid fabric reconcile result peer publicKey");
  }
  const peer: FabricReconcileObservedPeer = { publicKey };
  if (value.lastHandshakeAt !== undefined) {
    if (
      !isString(value.lastHandshakeAt) || !isIsoTimestamp(value.lastHandshakeAt)
    ) {
      throw new TypeError(
        "Invalid fabric reconcile result peer lastHandshakeAt",
      );
    }
    peer.lastHandshakeAt = value.lastHandshakeAt;
  }
  if (value.transferRx !== undefined) {
    peer.transferRx = parseNonNegativeInteger(
      value.transferRx,
      "peer transferRx",
    );
  }
  if (value.transferTx !== undefined) {
    peer.transferTx = parseNonNegativeInteger(
      value.transferTx,
      "peer transferTx",
    );
  }
  if (value.endpoint !== undefined) {
    if (
      !isString(value.endpoint) || !isValidWireguardEndpoint(value.endpoint)
    ) {
      throw new TypeError("Invalid fabric reconcile result peer endpoint");
    }
    peer.endpoint = value.endpoint;
  }
  if (value.health !== undefined) {
    if (
      typeof value.health !== "string" ||
      !FABRIC_PEER_HEALTH.has(value.health as FabricPeerHealth)
    ) {
      throw new TypeError("Invalid fabric reconcile result peer health");
    }
    peer.health = value.health as FabricPeerHealth;
  }
  return peer;
}

export type EnvironmentDeployTlsMaterial = {
  tlsId: string;
  /** Public leaf + intermediate chain PEM. */
  certificatePem: string;
  /** Daemon-recipient sealed private key (`tpdaemon.…`). */
  privateKeyEnvelope: string;
};

export type EnvironmentDeployHostingProxy = {
  forceHttps?: boolean;
  gzip?: boolean;
  brotli?: boolean;
  stripPrefix?: string;
};

export type EnvironmentDeployVariableMaterial = {
  key: string;
  composeServiceName: string | null;
  forBuild: boolean;
  forRuntime: boolean;
  isLiteral: boolean;
  valueEnvelope: string;
};

export type EnvironmentDeployStorageMount = {
  serviceId?: string;
  composeServiceName?: string;
  destinationPath: string;
  subpath?: string;
  readOnly?: boolean;
};

export type EnvironmentDeployStorageMaterial = {
  storageId: string;
  locationId: string;
  kind: "volume" | "directory" | "file";
  name: string;
  provider: "docker" | "path";
  sourcePath?: string;
  /**
   * On-host Docker volume name. Required when `provider` is `docker`.
   */
  volumeName?: string;
  principalId?: string;
  serverId: string;
  contentEnvelope?: string;
  managed?: boolean;
  externalName?: string;
  mounts: EnvironmentDeployStorageMount[];
};

export type EnvironmentDeployPrincipalMaterial = {
  principalId: string;
  username: string;
  /** Optional operator override — omitted when the host allocates. */
  uid?: number;
  /** Optional operator override — omitted when the host allocates. */
  gid?: number;
  home?: string;
  /**
   * Absolute shell path (default `/usr/sbin/nologin`), applied by the daemon
   * via `useradd -s` / `usermod -s`.
   */
  shell?: string;
};

export type EnvironmentDeployServiceHook = {
  composeServiceName: string;
  preDeployCommand?: string;
  postDeployCommand?: string;
  buildDisableCache?: boolean;
};

export type EnvironmentDeployHostingPhp = {
  version?: string;
  memoryLimit?: string;
  maxExecutionTime?: number;
};

/**
 * Project principal that owns a traditional-web site tree on the host.
 * Daemon `ensureSystemPrincipals` creates the Linux user before apply;
 * document roots are `chown`ed to this user with the engine group for read.
 */
export type EnvironmentDeployTraditionalWebPrincipal = {
  principalId: string;
  username: string;
  /** Optional operator override — omitted when the host allocates. */
  uid?: number;
  /** Optional operator override — omitted when the host allocates. */
  gid?: number;
};

export type EnvironmentDeployTraditionalWebSite = {
  composeServiceName: string;
  engine: "apache" | "nginx" | "openlitespeed";
  /** Relative document-root segment under the site directory. */
  root: string;
  /** Loopback port hosting Caddy reverse-proxies to. */
  listenPort: number;
  /** Merged hosting web env (variables + options.web.env). */
  webEnv?: Record<string, string>;
  php?: EnvironmentDeployHostingPhp;
  /**
   * When set (from a project principal ↔ service steward), the site tree
   * is owned by this principal and Apache php-fpm workers run as that user.
   */
  principal?: EnvironmentDeployTraditionalWebPrincipal;
};

/**
 * Per-service Traefik ingress for tenant `tcp`/`udp` hostings.
 * `containerName` must equal `${serviceId}-in` (same rule as managed ingress).
 */
export type EnvironmentDeployIngressService = {
  serviceId: string;
  composeServiceName: string;
  containerName: string;
};

/** Role of one file in the deploy-time `docker compose -f` chain. */
export type EnvironmentDeployComposeFileRole =
  | "project"
  | "environment"
  | "platform"
  | "runtime";

/** Where the file content was produced; only `inline` is emitted today. */
export type EnvironmentDeployComposeFileSource = "inline" | "repository";

/**
 * One file in the ordered compose file chain the daemon should run with
 * `docker compose -f …`. Array order is exactly the `-f` order — never sort.
 */
export type EnvironmentDeployComposeFile = {
  filename: string;
  role: EnvironmentDeployComposeFileRole;
  source?: EnvironmentDeployComposeFileSource;
  /**
   * Repo-relative original location of this file when `source: 'repository'`.
   * Populated once repository-pinned compose files are supported; unused
   * today.
   */
  path?: string;
  content: string;
};

/** Basename-only compose filenames safe for host paths (no directories). */
export const COMPOSE_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export type EnvironmentDeploySecretPlanEntry = {
  key: string;
  composeServiceName: string;
  source: string;
  target: string;
  relativePath: string;
  forBuild: boolean;
  forRuntime: boolean;
};

const DEPLOY_COMPOSE_FILE_ROLES = new Set<EnvironmentDeployComposeFileRole>([
  "project",
  "environment",
  "platform",
  "runtime",
]);

const DEPLOY_COMPOSE_FILE_SOURCES = new Set<EnvironmentDeployComposeFileSource>(
  [
    "inline",
    "repository",
  ],
);

export type EnvironmentDeployFabricNetwork = {
  name: string;
  subnet: string;
  mtu?: number;
  gateway?: string;
};

export type EnvironmentDeployCommandPayload = {
  environmentId: string;
  projectId: string;
  organizationId: string;
  projectName: string;
  /**
   * Compiled runtime snapshot the daemon writes as
   * `{ filename: 'compose.yaml', role: 'runtime' }`. May be `services: {}`
   * when all sites are traditional-web.
   */
  composeFiles: EnvironmentDeployComposeFile[];
  /** Environment desired generation this command is applying. */
  generation?: number;
  /** SHA-256 hex of the compiled runtime YAML (before daemon overlay). */
  desiredHash?: string;
  /** Target server (command `serverId` is authoritative; echoed for `deployment.json`). */
  serverId?: string;
  /** Local replica counts keyed by logical compose service name. */
  replicaCounts?: Record<string, number>;
  /** Public hosting routes to wire through Traefik + hosting Caddy. */
  hostings: EnvironmentDeployHosting[];
  /**
   * Host-native web sites (nginx MVP). Compose services with
   * `x-turbopanel.serviceKind: traditional-web` are stripped from the
   * compiled runtime compose and listed here instead.
   */
  traditionalWebSites?: EnvironmentDeployTraditionalWebSite[];
  /**
   * Per-service Traefik projects for services that publish at least one
   * `tcp`/`udp` port. One entry per service (not per hosting) — that Traefik
   * hosts every `ports[]` for the service. HTTP hostings never appear here.
   */
  ingressServices?: EnvironmentDeployIngressService[];
  /**
   * Shared HTTP loopback Traefik identity (`turbopanel-ingress` / compose
   * service `traefik`). Present when this deploy routes HTTP hostnames.
   * `containerName` must equal `<serviceId>-in` (platform hosting-ingress
   * service, not the tenant Adminer/web service).
   */
  hostingIngress?: EnvironmentDeployIngressService;
  /** External Docker networks referenced in compose — ensured on the host before compose up. */
  dockerExternalNetworks?: string[];
  /**
   * Routed TurboFabric Docker bridges (`tpn_*`) this host participates in for
   * this environment's spanning networks. The daemon self-ensures these before
   * compose up so deploy does not race `server.fabric.reconcile`. Disjoint
   * from `dockerExternalNetworks` — never operator-registered.
   */
  fabricNetworks?: EnvironmentDeployFabricNetwork[];
  /**
   * Compose service names that must join the daemon's shared managed-ingress
   * network (`turbopanel-managed`) so a managed-database binding endpoint
   * (a ProxySQL container name) resolves. Platform-managed — never
   * operator-registered like `dockerExternalNetworks`.
   */
  managedNetworkServices?: string[];
  /**
   * When true, the daemon runs `docker compose build --no-cache --pull`
   * before `up` (cacheless redeploy).
   */
  noCache?: boolean;
  /** Unique TLS material referenced by `hostings[].tlsId` (deduped). */
  tlsMaterial?: EnvironmentDeployTlsMaterial[];
  variableMaterial?: EnvironmentDeployVariableMaterial[];
  /** Non-secret Compose project `.env` written next to compose.yaml. */
  envFile?: string;
  /** File-only secret mounts (paths/names, no plaintext). */
  secretPlan?: EnvironmentDeploySecretPlanEntry[];
  storageMaterial?: EnvironmentDeployStorageMaterial[];
  principalMaterial?: EnvironmentDeployPrincipalMaterial[];
  serviceHooks?: EnvironmentDeployServiceHook[];
  /**
   * Server-owner org effective ProxySQL client listener ports. When present,
   * the daemon also reserves these alongside platform defaults `15432` /
   * `13306` for tenant raw tcp/udp ingress.
   */
  listenerPorts?: ManagedIngressPorts;
};

export type EnvironmentDeployHostingPort = {
  /** Host/entrypoint port exposed by Traefik. */
  published: number;
  /** Container port the compose service listens on. */
  target: number;
};

export type EnvironmentDeployHostingWeb = {
  env?: Record<string, string>;
  php?: EnvironmentDeployHostingPhp;
};

export type EnvironmentDeployHosting = {
  hostingId: string;
  serviceId: string;
  composeServiceName: string;
  hostnames: string[];
  pathPrefix?: string;
  /** Container port Traefik should target (default 80). */
  targetPort?: number;
  /** Resolved org TLS id when pinned; null/omit = Caddy `tls internal` (self-signed). */
  tlsId?: string | null;
  proxy?: EnvironmentDeployHostingProxy;
  /**
   * Resolved Caddy `bind` address for this hosting (public pinned IP, datacenter
   * private IP, or loopback). Omitted when bind is public with no pin.
   */
  bindAddress?: string;
  /**
   * `http` (default/omitted) routes `hostnames` through Traefik + hosting Caddy.
   * `tcp` / `udp` publish `ports[]` straight through Traefik — no hostname/TLS
   * routing.
   */
  protocol?: "http" | "tcp" | "udp";
  /** Required (non-empty) when `protocol` is `tcp` or `udp`; ignored for `http`. */
  ports?: EnvironmentDeployHostingPort[];
  /** Merged hosting web env + PHP hints for traditional-web materialization. */
  web?: EnvironmentDeployHostingWeb;
};

export type EnvironmentDeployContainer = {
  /** Present when the compose service appears in `payload.hostings`. */
  serviceId?: string;
  composeServiceName: string;
  containerId: string;
  containerName: string;
  status: string;
  /**
   * Workload / ingress / platform role — required on the wire.
   * Must be `'service'`, `'ingress'`, or `'turbopanel'`.
   */
  role: "service" | "ingress" | "turbopanel";
};

export type EnvironmentDeployCommandResult = {
  projectName: string;
  summary?: string;
  services?: string[];
  containers?: EnvironmentDeployContainer[];
};

const MAX_ENVIRONMENT_DEPLOY_CONTAINERS = 100;

function requireDeployPayloadStrings(
  value: Record<string, unknown>,
): Pick<
  EnvironmentDeployCommandPayload,
  "environmentId" | "projectId" | "organizationId" | "projectName"
> {
  const { environmentId, projectId, organizationId, projectName } = value;
  if (
    !isString(environmentId) ||
    !isString(projectId) ||
    !isString(organizationId) ||
    !isString(projectName)
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  return { environmentId, projectId, organizationId, projectName };
}

function parseDeployHostingProxy(
  value: unknown,
): EnvironmentDeployHostingProxy | undefined {
  if (!isRecord(value)) return undefined;
  const proxy: EnvironmentDeployHostingProxy = {};
  if (typeof value.forceHttps === "boolean") {
    proxy.forceHttps = value.forceHttps;
  }
  if (typeof value.gzip === "boolean") proxy.gzip = value.gzip;
  if (typeof value.brotli === "boolean") proxy.brotli = value.brotli;
  if (isString(value.stripPrefix)) proxy.stripPrefix = value.stripPrefix;
  return Object.keys(proxy).length > 0 ? proxy : undefined;
}

const DEPLOY_HOSTING_PROTOCOLS = new Set(["http", "tcp", "udp"]);

function parseDeployHostingProtocol(
  value: unknown,
): EnvironmentDeployHosting["protocol"] | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || !DEPLOY_HOSTING_PROTOCOLS.has(value)) {
    throw new Error("Invalid environment.deploy payload");
  }
  return value as EnvironmentDeployHosting["protocol"];
}

function isValidDeployPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 &&
    value <= 65535;
}

function parseDeployHostingPortEntry(
  entry: unknown,
): EnvironmentDeployHostingPort {
  if (
    !isRecord(entry) || !isValidDeployPort(entry.published) ||
    !isValidDeployPort(entry.target)
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  return { published: entry.published, target: entry.target };
}

function parseDeployHostingPorts(
  value: unknown,
): EnvironmentDeployHostingPort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Invalid environment.deploy payload");
  }
  return value.map(parseDeployHostingPortEntry);
}

function parseDeployHostingPhp(
  value: unknown,
): EnvironmentDeployHostingPhp | undefined {
  if (!isRecord(value)) return undefined;
  const php: EnvironmentDeployHostingPhp = {};
  if (isString(value.version)) php.version = value.version;
  if (isString(value.memoryLimit)) php.memoryLimit = value.memoryLimit;
  if (
    typeof value.maxExecutionTime === "number" &&
    Number.isInteger(value.maxExecutionTime)
  ) {
    php.maxExecutionTime = value.maxExecutionTime;
  }
  return Object.keys(php).length > 0 ? php : undefined;
}

function parseDeployHostingWebEnv(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isString(raw)) continue;
    env[key] = raw;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function parseDeployHostingWeb(
  value: unknown,
): EnvironmentDeployHostingWeb | undefined {
  if (!isRecord(value)) return undefined;
  const web: EnvironmentDeployHostingWeb = {};
  const env = parseDeployHostingWebEnv(value.env);
  if (env) web.env = env;
  const php = parseDeployHostingPhp(value.php);
  if (php) web.php = php;
  return Object.keys(web).length > 0 ? web : undefined;
}

function applyOptionalDeployHostingFields(
  hosting: EnvironmentDeployHosting,
  entry: Record<string, unknown>,
): void {
  if (isString(entry.pathPrefix)) hosting.pathPrefix = entry.pathPrefix;
  if (
    typeof entry.targetPort === "number" && Number.isFinite(entry.targetPort)
  ) {
    hosting.targetPort = entry.targetPort;
  }
  if (entry.tlsId === null) {
    hosting.tlsId = null;
  } else if (isString(entry.tlsId)) {
    hosting.tlsId = entry.tlsId;
  }
  const proxy = parseDeployHostingProxy(entry.proxy);
  if (proxy) hosting.proxy = proxy;
  if (entry.bindAddress !== undefined) {
    if (!isString(entry.bindAddress) || entry.bindAddress.length === 0) {
      throw new Error("Invalid environment.deploy payload");
    }
    if (!isValidIpAddress(entry.bindAddress)) {
      throw new Error("Invalid environment.deploy payload");
    }
    hosting.bindAddress = entry.bindAddress;
  }
  const protocol = parseDeployHostingProtocol(entry.protocol);
  if (protocol) hosting.protocol = protocol;
  const ports = parseDeployHostingPorts(entry.ports);
  if (ports) hosting.ports = ports;
  const web = parseDeployHostingWeb(entry.web);
  if (web) hosting.web = web;
}

function parseDeployHostingEntry(entry: unknown): EnvironmentDeployHosting {
  if (!isRecord(entry)) throw new Error("Invalid environment.deploy payload");
  if (
    !isString(entry.hostingId) ||
    !isString(entry.serviceId) ||
    !isString(entry.composeServiceName)
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  if (!Array.isArray(entry.hostnames) || !entry.hostnames.every(isString)) {
    throw new Error("Invalid environment.deploy payload");
  }
  const hosting: EnvironmentDeployHosting = {
    hostingId: entry.hostingId,
    serviceId: entry.serviceId,
    composeServiceName: entry.composeServiceName,
    hostnames: entry.hostnames as string[],
  };
  applyOptionalDeployHostingFields(hosting, entry);
  return hosting;
}

function parseDeployHostings(value: unknown): EnvironmentDeployHosting[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid environment.deploy payload");
  }
  return value.map(parseDeployHostingEntry);
}

function parseDeployTlsMaterialEntry(
  entry: unknown,
): EnvironmentDeployTlsMaterial {
  if (!isRecord(entry)) throw new Error("Invalid environment.deploy payload");
  if (
    !isString(entry.tlsId) ||
    !isString(entry.certificatePem) ||
    !isString(entry.privateKeyEnvelope)
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  return {
    tlsId: entry.tlsId,
    certificatePem: entry.certificatePem,
    privateKeyEnvelope: entry.privateKeyEnvelope,
  };
}

function parseDeployTlsMaterial(
  value: unknown,
): EnvironmentDeployTlsMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(parseDeployTlsMaterialEntry);
}

function parseDeployVariableMaterialEntry(
  entry: unknown,
): EnvironmentDeployVariableMaterial {
  if (!isRecord(entry)) throw new Error("Invalid environment.deploy payload");
  if (!isString(entry.key) || !isString(entry.valueEnvelope)) {
    throw new Error("Invalid environment.deploy payload");
  }
  return {
    key: entry.key,
    composeServiceName: isString(entry.composeServiceName)
      ? entry.composeServiceName
      : null,
    forBuild: entry.forBuild === true,
    forRuntime: entry.forRuntime !== false,
    isLiteral: entry.isLiteral === true,
    valueEnvelope: entry.valueEnvelope,
  };
}

function parseDeployVariableMaterial(
  value: unknown,
): EnvironmentDeployVariableMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(parseDeployVariableMaterialEntry);
}

const SECRET_PLAN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DEPLOY_ENV_FILE_CHARS = 1_048_576;

function parseDeploySecretPlanEntry(
  entry: unknown,
): EnvironmentDeploySecretPlanEntry {
  if (!isRecord(entry)) {
    throw new TypeError("Invalid environment.deploy secretPlan entry");
  }
  if (
    !isString(entry.key) ||
    !isString(entry.composeServiceName) ||
    !isString(entry.source) ||
    !isString(entry.target) ||
    !isString(entry.relativePath)
  ) {
    throw new TypeError("Invalid environment.deploy secretPlan entry");
  }
  if (
    entry.relativePath.includes("/") ||
    entry.relativePath.includes("\\") ||
    entry.relativePath.includes("..") ||
    !SECRET_PLAN_NAME_RE.test(entry.relativePath)
  ) {
    throw new TypeError("Invalid environment.deploy secretPlan relativePath");
  }
  if (
    !SECRET_PLAN_NAME_RE.test(entry.source) ||
    !SECRET_PLAN_NAME_RE.test(entry.target)
  ) {
    throw new TypeError("Invalid environment.deploy secretPlan source/target");
  }
  return {
    key: entry.key,
    composeServiceName: entry.composeServiceName,
    source: entry.source,
    target: entry.target,
    relativePath: entry.relativePath,
    forBuild: entry.forBuild === true,
    forRuntime: entry.forRuntime !== false,
  };
}

export function parseDeploySecretPlan(
  value: unknown,
): EnvironmentDeploySecretPlanEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("secretPlan must be an array");
  }
  return value.map(parseDeploySecretPlanEntry);
}

function parseDeployEnvFile(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("envFile must be a string");
  }
  if (value.length > MAX_DEPLOY_ENV_FILE_CHARS) {
    throw new TypeError("envFile exceeds maximum length");
  }
  return value;
}

function parseDeployStorageMount(
  entry: unknown,
): EnvironmentDeployStorageMount {
  if (!isRecord(entry) || !isString(entry.destinationPath)) {
    throw new Error("Invalid environment.deploy payload");
  }
  const mount: EnvironmentDeployStorageMount = {
    destinationPath: entry.destinationPath,
  };
  if (isString(entry.serviceId)) mount.serviceId = entry.serviceId;
  if (isString(entry.composeServiceName)) {
    mount.composeServiceName = entry.composeServiceName;
  }
  if (isString(entry.subpath)) mount.subpath = entry.subpath;
  if (entry.readOnly === true) mount.readOnly = true;
  return mount;
}

function parseDeployStorageMaterialEntry(
  entry: unknown,
): EnvironmentDeployStorageMaterial {
  if (!isRecord(entry)) throw new Error("Invalid environment.deploy payload");
  if (
    !isString(entry.storageId) ||
    !isString(entry.locationId) ||
    !isString(entry.kind) ||
    !isString(entry.name) ||
    !isString(entry.provider) ||
    !isString(entry.serverId)
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  const kind = entry.kind as EnvironmentDeployStorageMaterial["kind"];
  const provider = entry
    .provider as EnvironmentDeployStorageMaterial["provider"];
  if (
    (kind !== "volume" && kind !== "directory" && kind !== "file") ||
    (provider !== "docker" && provider !== "path")
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  const material: EnvironmentDeployStorageMaterial = {
    storageId: entry.storageId,
    locationId: entry.locationId,
    kind,
    name: entry.name,
    provider,
    serverId: entry.serverId,
    mounts: Array.isArray(entry.mounts)
      ? entry.mounts.map(parseDeployStorageMount)
      : [],
  };
  if (provider === "docker") {
    if (!isString(entry.volumeName)) {
      throw new Error("Invalid environment.deploy payload");
    }
    material.volumeName = entry.volumeName;
  }
  if (isString(entry.sourcePath)) material.sourcePath = entry.sourcePath;
  if (isString(entry.principalId)) material.principalId = entry.principalId;
  if (isString(entry.contentEnvelope)) {
    material.contentEnvelope = entry.contentEnvelope;
  }
  if (entry.managed === true || entry.managed === false) {
    material.managed = entry.managed;
  }
  if (isString(entry.externalName)) material.externalName = entry.externalName;
  return material;
}

/**
 * Absolute path rules for principal `home` / `shell` — must stay in sync with
 * the daemon `isValidAbsolutePrincipalPath` in
 * `turbopaneld/src/instance/commands/contracts.ts`.
 */
function isValidAbsolutePrincipalPath(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (!value.startsWith("/")) return false;
  if (/\s/.test(value) || value.includes("\0") || value.includes("\n")) {
    return false;
  }
  if (value.split("/").includes("..")) return false;
  return true;
}

/** Absolute shell path charset — mirrors the daemon `PRINCIPAL_SHELL_RE`. */
const PRINCIPAL_SHELL_RE = /^\/[A-Za-z0-9._+/-]{0,254}$/;

function isValidPrincipalShellPath(value: string): boolean {
  if (!isValidAbsolutePrincipalPath(value)) return false;
  return PRINCIPAL_SHELL_RE.test(value);
}

/** Must stay in sync with the daemon `PRINCIPAL_USERNAME_RE` / max length. */
const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Cap so `<username>-grp` fits the Linux 32-char group-name limit. */
const MAX_PRINCIPAL_USERNAME_LENGTH = 28;

function isValidPrincipalUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PRINCIPAL_USERNAME_LENGTH &&
    PRINCIPAL_USERNAME_RE.test(value)
  );
}

/**
 * Optional principal uid/gid on the wire — mirrors the daemon's
 * `parseOptionalPrincipalId` / `parseTraditionalWebOptionalId`
 * (undefined OK; otherwise integer ≥ 0).
 */
function parseOptionalPrincipalId(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid environment.deploy payload: ${field}`);
  }
  return value;
}

function parseDeployPrincipalMaterialEntry(
  entry: unknown,
): EnvironmentDeployPrincipalMaterial {
  if (!isRecord(entry)) throw new Error("Invalid environment.deploy payload");
  if (
    !isString(entry.principalId) ||
    entry.principalId.length === 0 ||
    !isValidPrincipalUsername(entry.username)
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  const uid = parseOptionalPrincipalId(entry.uid, "uid");
  const gid = parseOptionalPrincipalId(entry.gid, "gid");
  const material: EnvironmentDeployPrincipalMaterial = {
    principalId: entry.principalId,
    username: entry.username,
    ...(uid !== undefined ? { uid } : {}),
    ...(gid !== undefined ? { gid } : {}),
  };
  if (entry.home !== undefined) {
    if (!isString(entry.home) || !isValidAbsolutePrincipalPath(entry.home)) {
      throw new Error("Invalid environment.deploy payload");
    }
    material.home = entry.home;
  }
  if (entry.shell !== undefined) {
    if (!isString(entry.shell) || !isValidPrincipalShellPath(entry.shell)) {
      throw new Error("Invalid environment.deploy payload");
    }
    material.shell = entry.shell;
  }
  return material;
}

function parseDeployPrincipalMaterial(
  value: unknown,
): EnvironmentDeployPrincipalMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(parseDeployPrincipalMaterialEntry);
}

function parseDeployStorageMaterial(
  value: unknown,
): EnvironmentDeployStorageMaterial[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(parseDeployStorageMaterialEntry);
}

function parseDeployServiceHookEntry(
  entry: unknown,
): EnvironmentDeployServiceHook {
  if (!isRecord(entry)) throw new Error("Invalid environment.deploy payload");
  if (!isString(entry.composeServiceName)) {
    throw new Error("Invalid environment.deploy payload");
  }
  const hook: EnvironmentDeployServiceHook = {
    composeServiceName: entry.composeServiceName,
  };
  if (isString(entry.preDeployCommand)) {
    hook.preDeployCommand = entry.preDeployCommand;
  }
  if (isString(entry.postDeployCommand)) {
    hook.postDeployCommand = entry.postDeployCommand;
  }
  if (entry.buildDisableCache === true) hook.buildDisableCache = true;
  return hook;
}

function parseDeployServiceHooks(
  value: unknown,
): EnvironmentDeployServiceHook[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(parseDeployServiceHookEntry);
}

const TRADITIONAL_WEB_ENGINES = new Set(["apache", "nginx", "openlitespeed"]);

function parseDeployTraditionalWebSiteEntry(
  entry: unknown,
): EnvironmentDeployTraditionalWebSite {
  if (!isRecord(entry)) {
    throw new Error("Invalid traditionalWebSites entry");
  }
  if (
    !isString(entry.composeServiceName) ||
    entry.composeServiceName.length === 0 ||
    !isString(entry.engine) ||
    !TRADITIONAL_WEB_ENGINES.has(entry.engine) ||
    !isString(entry.root) ||
    entry.root.length === 0 ||
    typeof entry.listenPort !== "number" ||
    !Number.isInteger(entry.listenPort) ||
    entry.listenPort < 1024 ||
    entry.listenPort > 65_535
  ) {
    throw new Error("Invalid traditionalWebSites entry");
  }
  const site: EnvironmentDeployTraditionalWebSite = {
    composeServiceName: entry.composeServiceName,
    engine: entry.engine as EnvironmentDeployTraditionalWebSite["engine"],
    root: entry.root,
    listenPort: entry.listenPort,
  };
  const webEnv = parseDeployHostingWebEnv(entry.webEnv);
  if (webEnv) site.webEnv = webEnv;
  const php = parseDeployHostingPhp(entry.php);
  if (php) site.php = php;
  const principal = parseDeployTraditionalWebPrincipal(entry.principal);
  if (principal) site.principal = principal;
  return site;
}

function parseDeployTraditionalWebPrincipal(
  value: unknown,
): EnvironmentDeployTraditionalWebPrincipal | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid traditionalWebSites.principal entry");
  }
  if (
    !isString(value.principalId) ||
    value.principalId.length === 0 ||
    !isValidPrincipalUsername(value.username)
  ) {
    throw new Error("Invalid traditionalWebSites.principal entry");
  }
  let uid: number | undefined;
  let gid: number | undefined;
  try {
    uid = parseOptionalPrincipalId(value.uid, "uid");
    gid = parseOptionalPrincipalId(value.gid, "gid");
  } catch {
    throw new Error("Invalid traditionalWebSites.principal entry");
  }
  return {
    principalId: value.principalId,
    username: value.username,
    ...(uid !== undefined ? { uid } : {}),
    ...(gid !== undefined ? { gid } : {}),
  };
}

function parseDeployTraditionalWebSites(
  value: unknown,
): EnvironmentDeployTraditionalWebSite[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("traditionalWebSites must be an array");
  }
  return value.map(parseDeployTraditionalWebSiteEntry);
}

const DOCKER_EXTERNAL_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function parseDeployDockerExternalNetworks(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("dockerExternalNetworks must be an array");
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new TypeError("dockerExternalNetworks must be an array of strings");
    }
    const trimmed = entry.trim();
    if (!DOCKER_EXTERNAL_NETWORK_NAME_RE.test(trimmed)) {
      throw new Error("Invalid dockerExternalNetworks entry");
    }
    names.push(trimmed);
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function parseDeployFabricNetworkEntry(
  value: unknown,
): EnvironmentDeployFabricNetwork {
  if (!isRecord(value)) {
    throw new TypeError("fabricNetworks must be an array of objects");
  }
  const name = value.name;
  if (!isString(name) || !DOCKER_EXTERNAL_NETWORK_NAME_RE.test(name.trim())) {
    throw new Error("Invalid fabricNetworks name");
  }
  const subnet = value.subnet;
  if (!isString(subnet) || !isValidCidr(subnet.trim())) {
    throw new Error("Invalid fabricNetworks subnet");
  }
  const network: EnvironmentDeployFabricNetwork = {
    name: name.trim(),
    subnet: subnet.trim(),
  };
  if (value.mtu !== undefined) {
    if (
      typeof value.mtu !== "number" ||
      !Number.isInteger(value.mtu) ||
      value.mtu < FABRIC_MTU_MIN ||
      value.mtu > FABRIC_MTU_MAX
    ) {
      throw new Error("Invalid fabricNetworks mtu");
    }
    network.mtu = value.mtu;
  }
  if (value.gateway !== undefined) {
    if (!isString(value.gateway) || !isValidIpAddress(value.gateway)) {
      throw new Error("Invalid fabricNetworks gateway");
    }
    network.gateway = value.gateway;
  }
  return network;
}

function parseDeployFabricNetworks(
  value: unknown,
): EnvironmentDeployFabricNetwork[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("fabricNetworks must be an array");
  }
  return value.map(parseDeployFabricNetworkEntry);
}

function parseDeployManagedNetworkServices(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("managedNetworkServices must be an array");
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isValidComposeServiceName(entry)) {
      throw new Error("Invalid managedNetworkServices entry");
    }
    names.push(entry);
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function parseDeployComposeFileEntry(
  entry: unknown,
): EnvironmentDeployComposeFile {
  if (!isRecord(entry)) {
    throw new Error("Invalid environment.deploy payload");
  }
  const { filename, role, content, source, path } = entry;
  if (
    !isString(filename) || !COMPOSE_FILE_NAME_RE.test(filename) ||
    filename.includes("..")
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  if (
    !isString(role) ||
    !DEPLOY_COMPOSE_FILE_ROLES.has(role as EnvironmentDeployComposeFileRole)
  ) {
    throw new Error("Invalid environment.deploy payload");
  }
  if (!isString(content) || content.length === 0) {
    throw new Error("Invalid environment.deploy payload");
  }
  const file: EnvironmentDeployComposeFile = {
    filename,
    role: role as EnvironmentDeployComposeFileRole,
    content,
  };
  if (source !== undefined) {
    if (
      !isString(source) ||
      !DEPLOY_COMPOSE_FILE_SOURCES.has(
        source as EnvironmentDeployComposeFileSource,
      )
    ) {
      throw new Error("Invalid environment.deploy payload");
    }
    file.source = source as EnvironmentDeployComposeFileSource;
  }
  if (path !== undefined) {
    if (
      !isString(path) || path.length === 0 || path.includes("..") ||
      path.startsWith("/")
    ) {
      throw new Error("Invalid environment.deploy payload");
    }
    file.path = path;
  }
  return file;
}

/**
 * Parse the ordered `composeFiles` array on `environment.deploy`.
 * Never sorts — order is the daemon `-f` order.
 */
export function parseDeployComposeFiles(
  value: unknown,
): EnvironmentDeployComposeFile[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Invalid environment.deploy payload");
  }
  const file = parseDeployComposeFileEntry(value[0]);
  if (file.role !== "runtime" || file.filename !== "compose.yaml") {
    throw new Error("Invalid environment.deploy payload");
  }
  return [file];
}

const DESIRED_HASH_RE = /^[0-9a-f]{64}$/;

function parseOptionalGeneration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Invalid environment.deploy payload");
  }
  return value;
}

function parseOptionalDesiredHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || !DESIRED_HASH_RE.test(value)) {
    throw new Error("Invalid environment.deploy payload");
  }
  return value;
}

function parseOptionalDeployServerId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || !UUID_RE.test(value)) {
    throw new Error("Invalid environment.deploy payload");
  }
  return value;
}

function parseOptionalDeployNoCache(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError("Invalid environment.deploy payload");
  }
  return value;
}

function omitUndefinedEntries<T extends Record<string, unknown>>(
  fields: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function parseReplicaCounts(
  value: unknown,
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid environment.deploy payload");
  }
  const out: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (
      name.length === 0 || typeof count !== "number" ||
      !Number.isInteger(count) || count < 1
    ) {
      throw new Error("Invalid environment.deploy payload");
    }
    out[name] = count;
  }
  return out;
}

function parseDeployContainerEntry(
  entry: unknown,
): EnvironmentDeployContainer | undefined {
  if (!isRecord(entry)) return undefined;
  if (
    !isString(entry.composeServiceName) ||
    !isString(entry.containerId) ||
    !isString(entry.containerName) ||
    !isString(entry.status)
  ) {
    return undefined;
  }
  // Role is required — omit or misspell drops the entry rather than defaulting
  // to 'service' (which would silently mis-classify ingress/turbopanel rows).
  if (
    entry.role !== "service" && entry.role !== "ingress" &&
    entry.role !== "turbopanel"
  ) {
    return undefined;
  }
  const container: EnvironmentDeployContainer = {
    composeServiceName: entry.composeServiceName,
    containerId: entry.containerId,
    containerName: entry.containerName,
    status: entry.status,
    role: entry.role,
  };
  if (isString(entry.serviceId)) container.serviceId = entry.serviceId;
  return container;
}

function parseDeployContainers(
  value: unknown,
): EnvironmentDeployContainer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const containers: EnvironmentDeployContainer[] = [];
  for (const entry of value) {
    const container = parseDeployContainerEntry(entry);
    if (!container) continue;
    containers.push(container);
    if (containers.length >= MAX_ENVIRONMENT_DEPLOY_CONTAINERS) break;
  }
  // Preserve an explicitly empty array so callers can distinguish
  // "authoritative empty report" from "containers field omitted".
  return containers;
}

function parseDeployIngressServiceEntry(
  entry: unknown,
): EnvironmentDeployIngressService {
  if (!isRecord(entry)) {
    throw new Error("Invalid environment.deploy ingressServices entry");
  }
  if (
    !isString(entry.serviceId) ||
    !UUID_RE.test(entry.serviceId) ||
    !isString(entry.composeServiceName) ||
    !isValidComposeServiceName(entry.composeServiceName) ||
    !isString(entry.containerName) ||
    !isValidDockerResourceName(entry.containerName)
  ) {
    throw new Error("Invalid environment.deploy ingressServices entry");
  }
  if (
    entry.containerName !== ingressContainerNameFromService(entry.serviceId)
  ) {
    throw new Error("Invalid environment.deploy ingressServices entry");
  }
  return {
    serviceId: entry.serviceId,
    composeServiceName: entry.composeServiceName,
    containerName: entry.containerName,
  };
}

function parseDeployIngressServices(
  value: unknown,
): EnvironmentDeployIngressService[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("ingressServices must be an array");
  }
  return value.map(parseDeployIngressServiceEntry);
}

/** Shared HTTP Traefik compose key — must match SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME. */
const SHARED_HTTP_TRAEFIK_COMPOSE_SERVICE_NAME = "traefik";

function parseDeployHostingIngress(
  value: unknown,
): EnvironmentDeployIngressService | undefined {
  if (value === undefined) return undefined;
  let entry: EnvironmentDeployIngressService;
  try {
    entry = parseDeployIngressServiceEntry(value);
  } catch (cause) {
    throw new Error("Invalid environment.deploy hostingIngress", { cause });
  }
  if (entry.composeServiceName !== SHARED_HTTP_TRAEFIK_COMPOSE_SERVICE_NAME) {
    throw new Error("Invalid environment.deploy hostingIngress");
  }
  return entry;
}

export function parseEnvironmentDeployPayload(
  value: unknown,
): EnvironmentDeployCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid environment.deploy payload");
  }
  const strings = requireDeployPayloadStrings(value);
  return {
    ...strings,
    composeFiles: parseDeployComposeFiles(value.composeFiles),
    hostings: parseDeployHostings(value.hostings),
    ...omitUndefinedEntries({
      traditionalWebSites: parseDeployTraditionalWebSites(
        value.traditionalWebSites,
      ),
      ingressServices: parseDeployIngressServices(value.ingressServices),
      hostingIngress: parseDeployHostingIngress(value.hostingIngress),
      dockerExternalNetworks: parseDeployDockerExternalNetworks(
        value.dockerExternalNetworks,
      ),
      fabricNetworks: parseDeployFabricNetworks(value.fabricNetworks),
      managedNetworkServices: parseDeployManagedNetworkServices(
        value.managedNetworkServices,
      ),
      noCache: parseOptionalDeployNoCache(value.noCache),
      tlsMaterial: parseDeployTlsMaterial(value.tlsMaterial),
      variableMaterial: parseDeployVariableMaterial(value.variableMaterial),
      envFile: parseDeployEnvFile(value.envFile),
      secretPlan: parseDeploySecretPlan(value.secretPlan),
      storageMaterial: parseDeployStorageMaterial(value.storageMaterial),
      principalMaterial: parseDeployPrincipalMaterial(value.principalMaterial),
      serviceHooks: parseDeployServiceHooks(value.serviceHooks),
      listenerPorts: value.listenerPorts === undefined
        ? undefined
        : parseManagedIngressListenerPorts(value.listenerPorts),
      generation: parseOptionalGeneration(value.generation),
      desiredHash: parseOptionalDesiredHash(value.desiredHash),
      serverId: parseOptionalDeployServerId(value.serverId),
      replicaCounts: parseReplicaCounts(value.replicaCounts),
    }),
  };
}

export function parseEnvironmentDeployResult(
  value: unknown,
): EnvironmentDeployCommandResult {
  if (!isRecord(value)) {
    return { projectName: "" };
  }
  const result: EnvironmentDeployCommandResult = {
    projectName: isString(value.projectName) ? value.projectName : "",
  };
  if (isString(value.summary)) result.summary = value.summary;
  if (Array.isArray(value.services) && value.services.every(isString)) {
    result.services = value.services as string[];
  }
  const containers = parseDeployContainers(value.containers);
  if (containers !== undefined) result.containers = containers;
  return result;
}

export type EnvironmentStopCommandPayload = {
  environmentId: string;
  projectId: string;
  projectName: string;
  /**
   * Service ids that had per-service tcp/udp Traefik projects — daemon tears
   * those down on stop. Omitted/empty when the environment had none.
   */
  ingressServices?: Array<{ serviceId: string }>;
  /**
   * Host-side compose-network reclaim (`tpn_*` Docker bridges). The instance
   * has already dropped the DB rows, so this is the only remaining copy of
   * those names for this host.
   */
  fabricNetworks?: string[];
};

export type EnvironmentStopCommandResult = {
  projectName: string;
  summary?: string;
  /** Authoritative report — stop always returns `[]` on success so Postgres clears pins. */
  containers?: EnvironmentDeployContainer[];
};

function parseStopIngressServices(
  value: unknown,
): Array<{ serviceId: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("ingressServices must be an array");
  }
  const out: Array<{ serviceId: string }> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) || !isString(entry.serviceId) ||
      !UUID_RE.test(entry.serviceId)
    ) {
      throw new Error("Invalid environment.stop ingressServices entry");
    }
    out.push({ serviceId: entry.serviceId });
  }
  return out;
}

function parseStopFabricNetworks(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("fabricNetworks must be an array");
  }
  const out: string[] = [];
  for (const entry of value) {
    if (
      !isString(entry) ||
      !entry.startsWith("tpn_") ||
      !FABRIC_DOCKER_NETWORK_NAME_RE.test(entry)
    ) {
      throw new Error("Invalid environment.stop fabricNetworks name");
    }
    out.push(entry);
  }
  return out;
}

export function parseEnvironmentStopPayload(
  value: unknown,
): EnvironmentStopCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid environment.stop payload");
  }
  const environmentId = value.environmentId;
  const projectId = value.projectId;
  const projectName = value.projectName;
  if (
    !isString(environmentId) ||
    !isString(projectId) ||
    !isString(projectName) ||
    environmentId.length === 0 ||
    projectId.length === 0 ||
    projectName.length === 0
  ) {
    throw new Error("Invalid environment.stop payload");
  }
  const ingressServices = parseStopIngressServices(value.ingressServices);
  const fabricNetworks = parseStopFabricNetworks(value.fabricNetworks);
  return {
    environmentId,
    projectId,
    projectName,
    ...(ingressServices !== undefined ? { ingressServices } : {}),
    ...(fabricNetworks !== undefined ? { fabricNetworks } : {}),
  };
}

export function parseEnvironmentStopResult(
  value: unknown,
): EnvironmentStopCommandResult {
  if (!isRecord(value)) {
    return { projectName: "" };
  }
  const result: EnvironmentStopCommandResult = {
    projectName: isString(value.projectName) ? value.projectName : "",
  };
  if (isString(value.summary)) result.summary = value.summary;
  const containers = parseDeployContainers(value.containers);
  if (containers !== undefined) result.containers = containers;
  return result;
}

export const ENVIRONMENT_LIFECYCLE_ACTIONS = new Set([
  "start",
  "stop",
  "restart",
]);

export type EnvironmentLifecycleAction = "start" | "stop" | "restart";

export type EnvironmentLifecycleCommandPayload = {
  environmentId: string;
  projectId: string;
  projectName: string;
  action: EnvironmentLifecycleAction;
};

export type EnvironmentLifecycleCommandResult = {
  projectName: string;
  summary?: string;
  /**
   * Authoritative `compose ps` report. Unlike stop, this carries real rows so
   * pins are updated rather than cleared. `undefined` means collection failed
   * — skip reconcile.
   */
  containers?: EnvironmentDeployContainer[];
};

export function parseEnvironmentLifecyclePayload(
  value: unknown,
): EnvironmentLifecycleCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid environment.lifecycle payload");
  }
  const environmentId = value.environmentId;
  const projectId = value.projectId;
  const projectName = value.projectName;
  const action = value.action;
  if (
    !isString(environmentId) ||
    !isString(projectId) ||
    !isString(projectName) ||
    environmentId.length === 0 ||
    projectId.length === 0 ||
    projectName.length === 0 ||
    !isString(action) ||
    !ENVIRONMENT_LIFECYCLE_ACTIONS.has(action)
  ) {
    throw new Error("Invalid environment.lifecycle payload");
  }
  return {
    environmentId,
    projectId,
    projectName,
    action: action as EnvironmentLifecycleAction,
  };
}

export function parseEnvironmentLifecycleResult(
  value: unknown,
): EnvironmentLifecycleCommandResult {
  if (!isRecord(value)) {
    return { projectName: "" };
  }
  const result: EnvironmentLifecycleCommandResult = {
    projectName: isString(value.projectName) ? value.projectName : "",
  };
  if (isString(value.summary)) result.summary = value.summary;
  const containers = parseDeployContainers(value.containers);
  if (containers !== undefined) result.containers = containers;
  return result;
}

/** Allowlisted system component keys — never a free-form wire string. */
export type SystemComponentKey =
  | "hosting-ingress"
  | "managed-ingress"
  | "managed-ha"
  | "database"
  | "queue"
  | "analytics";

export type SystemReconcileAction = "reconcile" | "restart" | "stop";

/**
 * Role per system component — never a free-form wire value.
 * Container naming is resolved separately via
 * {@link expectedSystemComponentContainerName} (`hosting-ingress` → `-in`,
 * `managed-ingress` → `-in`, `managed-ha` → `-ha`, self-host stack → bare serviceId).
 * Keep in parity with daemon `contracts.ts` system-reconcile component roles.
 */
export const SYSTEM_COMPONENT_ROLES: Record<
  SystemComponentKey,
  "service" | "ingress" | "turbopanel"
> = {
  "hosting-ingress": "ingress",
  "managed-ingress": "ingress",
  "managed-ha": "turbopanel",
  database: "turbopanel",
  queue: "turbopanel",
  analytics: "turbopanel",
};

/** Per-component Docker `container_name` for a system.reconcile entry. */
function expectedSystemComponentContainerName(
  component: SystemComponentKey,
  serviceId: string,
): string {
  switch (component) {
    case "hosting-ingress":
      return ingressContainerNameFromService(serviceId);
    case "managed-ingress":
      return ingressContainerNameFromService(serviceId);
    case "managed-ha":
      return managedHaContainerNameFromService(serviceId);
    case "database":
    case "queue":
    case "analytics":
      return serviceId;
  }
}

export type SystemReconcileComponent = {
  component: SystemComponentKey;
  serviceId: string;
  composeServiceName: string;
  containerName: string;
  role: "service" | "ingress" | "turbopanel";
  desired: "present" | "absent";
};

/**
 * Bounded reconcile payload. `environmentId` is owned by the instance —
 * the daemon result must never carry a competing environment id.
 */
export type SystemReconcileCommandPayload = {
  environmentId: string;
  action: SystemReconcileAction;
  components: SystemReconcileComponent[];
};

/**
 * Observed containers only. No `environmentId` — the consumer trusts only
 * the payload's environment id.
 */
export type SystemReconcileCommandResult = {
  summary?: string;
  containers?: EnvironmentDeployContainer[];
};

const SYSTEM_COMPONENT_KEYS = new Set<string>([
  "hosting-ingress",
  "managed-ingress",
  "managed-ha",
  "database",
  "queue",
  "analytics",
]);
const SYSTEM_RECONCILE_ACTIONS = new Set(["reconcile", "restart", "stop"]);
const SYSTEM_RECONCILE_DESIRED = new Set(["present", "absent"]);
/** Room for a later self-host phase without reopening the schema. */
const MAX_SYSTEM_RECONCILE_COMPONENTS = 8;

export function isSystemComponentKey(
  value: unknown,
): value is SystemComponentKey {
  return typeof value === "string" && SYSTEM_COMPONENT_KEYS.has(value);
}

function parseSystemReconcileComponent(
  value: unknown,
  seen: Set<string>,
): SystemReconcileComponent {
  if (!isRecord(value)) {
    throw new Error("Invalid system.reconcile payload");
  }
  const component = value.component;
  if (!isSystemComponentKey(component)) {
    throw new Error("Invalid system.reconcile payload");
  }
  if (seen.has(component)) {
    throw new Error("Invalid system.reconcile payload");
  }
  seen.add(component);

  const serviceId = value.serviceId;
  if (!isString(serviceId) || !UUID_RE.test(serviceId)) {
    throw new Error("Invalid system.reconcile payload");
  }
  const composeServiceName = value.composeServiceName;
  if (!isString(composeServiceName) || composeServiceName.length === 0) {
    throw new Error("Invalid system.reconcile payload");
  }
  const expectedRole = SYSTEM_COMPONENT_ROLES[component];
  const role = value.role;
  if (role !== expectedRole) {
    throw new Error("Invalid system.reconcile payload");
  }
  const containerName = value.containerName;
  const expectedContainerName = expectedSystemComponentContainerName(
    component,
    serviceId,
  );
  if (!isString(containerName) || containerName !== expectedContainerName) {
    throw new Error("Invalid system.reconcile payload");
  }
  const desired = value.desired;
  if (!isString(desired) || !SYSTEM_RECONCILE_DESIRED.has(desired)) {
    throw new Error("Invalid system.reconcile payload");
  }
  return {
    component,
    serviceId,
    composeServiceName,
    containerName,
    role: role as "service" | "ingress" | "turbopanel",
    desired: desired as "present" | "absent",
  };
}

export function parseSystemReconcilePayload(
  value: unknown,
): SystemReconcileCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid system.reconcile payload");
  }
  const environmentId = value.environmentId;
  if (
    !isString(environmentId) || environmentId.length === 0 ||
    !UUID_RE.test(environmentId)
  ) {
    throw new Error("Invalid system.reconcile payload");
  }

  let action: SystemReconcileAction = "reconcile";
  if (value.action !== undefined) {
    if (
      !isString(value.action) || !SYSTEM_RECONCILE_ACTIONS.has(value.action)
    ) {
      throw new Error("Invalid system.reconcile payload");
    }
    action = value.action as SystemReconcileAction;
  }

  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error("Invalid system.reconcile payload");
  }
  if (value.components.length > MAX_SYSTEM_RECONCILE_COMPONENTS) {
    throw new Error("Invalid system.reconcile payload");
  }

  const seen = new Set<string>();
  const components: SystemReconcileComponent[] = [];
  for (const entry of value.components) {
    components.push(parseSystemReconcileComponent(entry, seen));
  }

  return { environmentId, action, components };
}

export function parseSystemReconcileResult(
  value: unknown,
): SystemReconcileCommandResult {
  if (!isRecord(value)) {
    return {};
  }
  const result: SystemReconcileCommandResult = {};
  if (isString(value.summary)) result.summary = value.summary;
  const containers = parseDeployContainers(value.containers);
  if (containers !== undefined) result.containers = containers;
  return result;
}

/** Docker Compose project name charset (daemon `COMPOSE_PROJECT_RE` parity). */
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
const SAFE_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MAX_IDENTIFIER_LENGTH = 63;
const MAX_MANAGED_CONFIG_FILES = 32;
const MAX_MANAGED_CONFIG_CONTENTS_BYTES = 64 * 1024;
const MAX_MANAGED_VOLUMES = 16;
const MAX_MANAGED_CREDENTIALS = 32;
const MAX_MANAGED_DATABASES = 64;
const MAX_MANAGED_DROP_USERS = 32;
const MAX_MANAGED_IMAGE_LENGTH = 256;
const MAX_MANAGED_PEERS = 4;
const MANAGED_MEMBER_ROLES = new Set(["primary", "replica"]);
const MANAGED_PEER_TRANSPORTS = new Set([
  "local",
  "datacenter",
  "fabric",
  "public",
]);
const MANAGED_EXPOSURE_PROTOCOLS = new Set(["tcp", "udp", "http"]);
const MANAGED_CREDENTIAL_ROLES = new Set(["root", "user", "replication"]);
const MANAGED_REPLICATION_ROLES = new Set(["primary", "standby"]);
const MANAGED_REPLICATION_STATES = new Set([
  "streaming",
  "catchup",
  "stopped",
  "unknown",
  "needs_resync",
]);
const MAX_MANAGED_DESIRED_SLOTS = 8;
const MAX_MANAGED_PEER_ADDRESSES = 16;
const MANAGED_DATABASE_ACTIONS = new Set(["create", "drop"]);
const MANAGED_LIFECYCLE_ACTIONS = new Set(["start", "stop", "restart"]);
const MANAGED_CONFIG_MODES = new Set(["0640", "0600"]);
const DAEMON_ENVELOPE_PREFIX = ENVELOPE_PREFIX_DAEMON;

function isSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_IDENTIFIER_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

function isSafeUsername(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_USERNAME_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

function isComposeProjectName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    COMPOSE_PROJECT_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

/** Light OCI-ref charset check (mirrors managed/settings.ts syntax rules). */
function isValidManagedImageRef(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MANAGED_IMAGE_LENGTH) {
    return false;
  }
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return true;
}

function isValidPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 &&
    value <= 65_535;
}

function isLoopbackIpLiteral(value: string): boolean {
  if (value === "::1") return true;
  if (!isValidIpv4Literal(value)) return false;
  const first = Number(value.split(".")[0]);
  return first === 127;
}

function isIsoTimestamp(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/**
 * Relative paths the platform may materialize under managed state.
 * Keep in sync with generated engine specs (e.g. postgres `postgresql.conf`
 * + TLS material) and the daemon twin allowlist.
 */
const MANAGED_CONFIG_PATH_ALLOWLIST = new Set([
  "postgresql.conf",
  "pg_hba.conf",
  "my.cnf",
  "initdb/00-turbopanel.sql",
  "tls/server.crt",
  "tls/server.key",
]);

/** Relative-only allowlist for managed `configFiles[].path`. */
function isAllowedManagedConfigPath(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (value.includes("..")) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return MANAGED_CONFIG_PATH_ALLOWLIST.has(value);
}

function isAbsoluteContainerPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value.startsWith("/") &&
    !value.includes("..") &&
    !SHELL_METACHAR_RE.test(value)
  );
}

export type ManagedApplyConfigFile = {
  path: string;
  contents: string;
  mode: "0640" | "0600";
};

export type ManagedApplyVolume = {
  name: string;
  target: string;
};

export type ManagedApplyExposure = {
  enabled: boolean;
  protocol: "tcp" | "udp" | "http";
  bindAddress?: string;
};

export type ManagedApplyCredential = {
  principalId: string;
  username: string;
  role: "root" | "user" | "replication";
  databases: string[];
  privileges?: string[];
  /** Daemon-recipient sealed password (`tpdaemon.…`). */
  password: string;
};

export type ManagedApplyDatabaseOp = {
  name: string;
  action: "create" | "drop";
};

/** Mirror of `ManagedTlsMaterialRequest` — daemon generates key material on host. */
export type ManagedApplyTlsMaterial = {
  selfSigned: true;
  commonName: string;
  certPath: string;
  keyPath: string;
};

/**
 * Leaf signed by the Organization CA of the server-owner organization for
 * managed frontend (ProxySQL) TLS. `certificatePem` is that leaf; `caCertPem`
 * is the concatenated active+retired Organization CA trust bundle (not a lone
 * active PEM) — explicitly not the Platform CA / `instance-ca.pem`. Multi-PEM
 * is accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`. Private key is
 * daemon-recipient sealed (`tpdaemon.…`); cert + trust bundle are plain PEM.
 */
export type ManagedApplyOrgTlsMaterial = {
  certificatePem: string;
  privateKeyEnvelope: string;
  caCertPem: string;
};

export type ManagedApplyPeer = {
  memberId: string;
  role: "primary" | "replica";
  readEligible: boolean;
  address: string;
  /**
   * `public` is accepted on the wire this phase; daemon org-CA TLS
   * enforcement for a public listener is a later phase.
   */
  transport: "local" | "datacenter" | "fabric" | "public";
  /**
   * Reachable port: engine native for co-resident peers, allocated private-
   * listener port for remote peers.
   */
  port: number;
  /** Set when the peer is co-resident on the same Docker host/network. */
  containerName?: string;
};

/** Host publish for private replication / ProxySQL (never loopback). */
export type ManagedApplyPrivateListener = {
  address: string;
  port: number;
  /**
   * Reachability class of `address`. Optional for back-compat with daemons and
   * queued commands from before this field existed (omitted = not public).
   * `public` obliges the daemon to refuse the listener without org-CA TLS
   * material.
   */
  transport?: "local" | "datacenter" | "fabric" | "public";
};

export type ManagedApplyReplicationPrimary = {
  /** Leaf SAN for sslmode=verify-full. */
  host: string;
  /** Dialled IP when different from `host` (remote path). */
  hostaddr?: string;
  port: number;
};

/**
 * Direct engine→engine streaming replication block (never via ProxySQL).
 * Must stay in sync with the daemon `managed.apply` shape.
 */
export type ManagedApplyReplication = {
  role: "primary" | "standby";
  /** Replication principal login. */
  username: string;
  /** Physical slot on the primary for this standby (`tp_member_<ordinal>`). */
  slotName?: string;
  /** Slots the primary must keep; any other `tp_member_*` slot is dropped. */
  desiredSlots?: string[];
  /** Addresses allowed a `replication` pg_hba entry on the primary. */
  peerAddresses?: string[];
  /** Primary dial info for a standby member. */
  primary?: ManagedApplyReplicationPrimary;
};

/** Observed streaming/lag health projected onto managed cluster `node.metadata`. */
export type ManagedReplicationHealth = {
  state: string;
  lagBytes?: number;
  lagSeconds?: number;
  observedAt: string;
};

export type ManagedMemberObservedResult = {
  memberId: string;
  role: string;
  status: string;
  replication?: ManagedReplicationHealth;
};

export type ManagedApplyCommandPayload = {
  managedId: string;
  environmentId: string;
  engine: ManagedEngineCode;
  projectName: string;
  /** Compose `container_name` — `<service.id>-<memberOrdinal>` from pre-allocation. */
  containerName: string;
  image: string;
  containerPort: number;
  composeYaml: string;
  configFiles: ManagedApplyConfigFile[];
  volumes: ManagedApplyVolume[];
  resources?: NonNullable<ServiceOptions["resources"]>;
  dockerOptions?: ManagedDockerOptions;
  exposure: ManagedApplyExposure;
  /** Fan-out identity for this command's target member. */
  memberId: string;
  memberRole: "primary" | "replica";
  memberOrdinal: number;
  readEligible: boolean;
  /** Other cluster members reachable from this member's server. */
  peers: ManagedApplyPeer[];
  /** Private listener bind for multi-member clusters only. */
  privateListener?: ManagedApplyPrivateListener;
  /** Direct replication config when the cluster has more than one member. */
  replication?: ManagedApplyReplication;
  credentials: ManagedApplyCredential[];
  databases?: ManagedApplyDatabaseOp[];
  /** Transient usernames to drop after credentials are applied (never root). */
  dropUsers?: string[];
  /** When set, daemon generates a self-signed cert under managed state `tls/`. */
  tlsMaterial?: ManagedApplyTlsMaterial;
  /**
   * Organization CA leaf + Organization CA trust bundle for ProxySQL-facing
   * files. `caCertPem` is the concatenated active+retired Organization CA PEMs
   * of the server-owner organization — not the Platform CA / `instance-ca.pem`.
   * Multi-PEM is accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`.
   */
  orgTlsMaterial?: ManagedApplyOrgTlsMaterial;
};

export type ManagedApplyCommandResult = {
  host: string;
  port: number;
  containers?: EnvironmentDeployContainer[];
  appliedUsers?: string[];
  appliedDatabases?: string[];
  engineVersion?: string;
  summary?: string;
  member?: ManagedMemberObservedResult;
  /** @deprecated prefer `member.memberId` — accepted for transitional clients. */
  memberId?: string;
  /** @deprecated prefer `member.status`. */
  status?: string;
};

export type ManagedLifecycleCommandPayload = {
  managedId: string;
  action: "start" | "stop" | "restart";
  memberId?: string;
  /**
   * Optional engine code so the daemon resolves the correct runtime for
   * member health. Absent on in-flight commands from older releases
   * (defaults to postgres on the daemon).
   */
  engine?: ManagedEngineCode;
};

export type ManagedLifecycleCommandResult = {
  status: string;
  summary?: string;
  member?: ManagedMemberObservedResult;
};

export type ManagedDestroyCommandPayload = {
  managedId: string;
  removeVolumes: boolean;
  memberId?: string;
  /**
   * Instance-only marker (never read by the daemon) distinguishing an API
   * hard-delete request from a future "destroy runtime only" action. When
   * true, `applyManagedDestroySideEffect` deletes the `managed` row after a
   * successful destroy so `principal.managed_id` cascades. Stamped only on the
   * primary member's destroy command so the row is deleted exactly once.
   */
  deleteAfterDestroy?: boolean;
  /**
   * Instance-only marker: delete the `node` row only after destroy
   * succeeds. On failure/timeout the member stays visible (status `failed`).
   */
  deleteMemberAfterDestroy?: boolean;
};

export type ManagedDestroyCommandResult = {
  /** Daemon-observed managed status after destroy (e.g. `stopped`). */
  status: string;
  /** Always present — destroy returns `[]` so Postgres clears pins. */
  containers: EnvironmentDeployContainer[];
  summary?: string;
};

export type ManagedPromoteCommandPayload = {
  managedId: string;
  memberId: string;
  demoteMemberId?: string;
  /**
   * Optional engine code so the daemon resolves the correct promotion
   * runtime. Absent on in-flight commands from older releases (defaults to
   * postgres on the daemon).
   */
  engine?: ManagedEngineCode;
};

export type ManagedPromoteCommandResult = {
  status: string;
  role: string;
  summary?: string;
  promotedMemberId: string;
  demotedMemberId?: string;
  demoted: boolean;
  replication?: ManagedReplicationHealth;
};

/** Must stay in sync with the daemon `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcileBackend = {
  memberId: string;
  role: "primary" | "replica";
  readEligible: boolean;
  address: string;
  port: number;
  /**
   * `public` is accepted on the wire this phase; daemon org-CA TLS
   * enforcement for a public listener is a later phase.
   */
  transport: "local" | "datacenter" | "fabric" | "public";
};

/** Must stay in sync with the daemon `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcileUser = {
  username: string;
  role: "root" | "user";
  /** Daemon-recipient sealed password (`tpdaemon.…`) for ProxySQL frontend auth. */
  password: string;
  defaultDatabase?: string;
  /** Absent means `read-write`, so a skewed daemon keeps writer routing. */
  connectionRole?: ManagedConnectionRole;
};

/**
 * Which ProxySQL hostgroup a frontend login defaults to. `read-only` is the
 * opt-in read path — it never implies rewriting a `read-write` login's queries.
 */
export type ManagedConnectionRole = "read-write" | "read-only";

export const MANAGED_CONNECTION_ROLES: readonly ManagedConnectionRole[] = [
  "read-write",
  "read-only",
];

export const DEFAULT_MANAGED_CONNECTION_ROLE: ManagedConnectionRole =
  "read-write";

export function isManagedConnectionRole(
  value: unknown,
): value is ManagedConnectionRole {
  return value === "read-write" || value === "read-only";
}

/** Must stay in sync with the daemon `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcileCluster = {
  managedId: string;
  engine: ManagedEngineCode;
  /**
   * Organization-resolved client listener port. Platform defaults are
   * 15432 / 13306; legacy 5432/3306 stay accepted for daemon skew.
   */
  protocolPort: ManagedIngressProtocolPort;
  /**
   * Protocol module serving this cluster. Sent explicitly because a
   * configurable port no longer identifies a family.
   */
  family: ManagedIngressFamily;
  writerHostgroup: number;
  readerHostgroup: number;
  backends: ManagedIngressReconcileBackend[];
  users: ManagedIngressReconcileUser[];
  /** Opt-in `^SELECT` splitting for read-write logins; absent means off. */
  autoReadSplit?: boolean;
  /**
   * Refuse plaintext client sessions for every login of this cluster (effective
   * SSL mode `require` / `verify-ca` / `verify-full`). Absent means TLS stays
   * available but optional; backend TLS is unconditional either way.
   */
  requireTls?: boolean;
};

/** Must stay in sync with the daemon `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcileCommandPayload = {
  serverId: string;
  /**
   * Every host address the client listeners publish on. More than one entry
   * when an access scope resolves to distinct interfaces (datacenter private IP
   * plus TurboFabric `tp0`); empty/absent means no host publish at all.
   */
  bindAddresses?: string[];
  /**
   * Organization CA leaf + Organization CA trust bundle. `caCertPem` is the
   * concatenated active+retired Organization CA PEMs of the server-owner
   * organization — not the Platform CA / `instance-ca.pem`. Multi-PEM is
   * accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`. Omitted on
   * empty-cluster teardown so it does not need an Organization CA round trip.
   */
  orgTlsMaterial?: ManagedApplyOrgTlsMaterial;
  /**
   * Organization-resolved listener ports for both protocol modules. Absent
   * means the platform defaults (control-plane skew).
   */
  listenerPorts?: ManagedIngressPorts;
  clusters: ManagedIngressReconcileCluster[];
  segments?: Array<{ name: string; subnet: string }>;
  /**
   * ProxySQL system-component identity. Present on apply so remote hosts can
   * persist `<stateDir>/system/managed-ingress.json` without a prior
   * `system.reconcile`. Omitted on empty-cluster teardown.
   */
  identity?: {
    serviceId: string;
    composeServiceName: string;
    containerName: string;
  };
};

/** Must stay in sync with the daemon `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcileCommandResult = {
  summary: string;
  appliedUsers: string[];
  appliedBackends: string[];
  restarted: boolean;
  containers?: EnvironmentDeployContainer[];
};

export type ManagedHaReconcileDesired = "present" | "absent";

export type ManagedHaRaftPeer = {
  nodeId: string;
  address: string;
  raftPort: number;
  httpPort: number;
};

export type ManagedHaRaftConfig = {
  nodeId: string;
  httpPort: number;
  raftPort: number;
  advertiseAddress: string;
  peers: ManagedHaRaftPeer[];
};

export type ManagedHaClusterMember = {
  memberId: string;
  role: "primary" | "replica";
  replicaClass: "failover" | "read" | null;
  promotionRule: HaPromotionRule;
  host: string;
  port: number;
  containerName?: string;
};

export type ManagedHaCluster = {
  managedId: string;
  engine: ManagedEngineCode;
  clusterAlias: string;
  members: ManagedHaClusterMember[];
  replicationUsername: string;
  replicationPasswordEnvelope: string;
};

/** Must stay in sync with the daemon `managed.ha.reconcile` shape. */
export type ManagedHaReconcileCommandPayload = {
  serverId: string;
  desired: ManagedHaReconcileDesired;
  raft: ManagedHaRaftConfig | null;
  clusters: ManagedHaCluster[];
  identity: {
    serviceId: string;
    composeServiceName: string;
    containerName: string;
  };
  /**
   * Organization CA leaf + Organization CA trust bundle. `caCertPem` is the
   * concatenated active+retired Organization CA PEMs of the server-owner
   * organization — not the Platform CA / `instance-ca.pem`. Multi-PEM is
   * accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`.
   */
  orgTlsMaterial?: ManagedApplyOrgTlsMaterial;
};

export type ManagedHaReconcileCommandResult = {
  summary: string;
  registeredClusters: string[];
  restarted: boolean;
  containers?: EnvironmentDeployContainer[];
};

export type ManagedHaFailoverPhase = "drain" | "recover";

/** Must stay in sync with the daemon `managed.ha.failover` shape. */
export type ManagedHaFailoverCommandPayload = {
  managedId: string;
  sourceMemberId: string;
  targetMemberId: string;
  engine?: ManagedEngineCode;
  phase: ManagedHaFailoverPhase;
  sourceHost?: string;
  sourcePort?: number;
  targetHost?: string;
  targetPort?: number;
};

export type ManagedHaFailoverCommandResult = {
  summary: string;
  phase: ManagedHaFailoverPhase;
};

function parseManagedApplyConfigFiles(
  value: unknown,
): ManagedApplyConfigFile[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply configFiles");
  }
  if (value.length > MAX_MANAGED_CONFIG_FILES) {
    throw new Error("Invalid managed.apply configFiles: too many entries");
  }
  const files: ManagedApplyConfigFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error("Invalid managed.apply configFiles entry");
    }
    if (
      !isString(entry.path) ||
      !isAllowedManagedConfigPath(entry.path) ||
      !isString(entry.contents) ||
      entry.contents.length > MAX_MANAGED_CONFIG_CONTENTS_BYTES ||
      !isString(entry.mode) ||
      !MANAGED_CONFIG_MODES.has(entry.mode)
    ) {
      throw new Error("Invalid managed.apply configFiles entry");
    }
    files.push({
      path: entry.path,
      contents: entry.contents,
      mode: entry.mode as "0640" | "0600",
    });
  }
  return files;
}

function parseManagedApplyVolumes(value: unknown): ManagedApplyVolume[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply volumes");
  }
  if (value.length > MAX_MANAGED_VOLUMES) {
    throw new Error("Invalid managed.apply volumes: too many entries");
  }
  const volumes: ManagedApplyVolume[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error("Invalid managed.apply volumes entry");
    }
    if (
      !isString(entry.name) ||
      !isSafeIdentifier(entry.name) ||
      !isString(entry.target) ||
      !isAbsoluteContainerPath(entry.target)
    ) {
      throw new Error("Invalid managed.apply volumes entry");
    }
    volumes.push({ name: entry.name, target: entry.target });
  }
  return volumes;
}

function parseManagedApplyResources(
  value: unknown,
): NonNullable<ServiceOptions["resources"]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid managed.apply resources");
  }
  const resources: NonNullable<ServiceOptions["resources"]> = {};
  if (value.cpus !== undefined) {
    if (
      typeof value.cpus !== "number" || !Number.isFinite(value.cpus) ||
      value.cpus < 0
    ) {
      throw new Error("Invalid managed.apply resources.cpus");
    }
    resources.cpus = value.cpus;
  }
  if (value.memoryBytes !== undefined) {
    if (
      typeof value.memoryBytes !== "number" ||
      !Number.isInteger(value.memoryBytes) ||
      value.memoryBytes <= 0
    ) {
      throw new Error("Invalid managed.apply resources.memoryBytes");
    }
    resources.memoryBytes = value.memoryBytes;
  }
  if (value.memoryReservationBytes !== undefined) {
    if (
      typeof value.memoryReservationBytes !== "number" ||
      !Number.isInteger(value.memoryReservationBytes) ||
      value.memoryReservationBytes <= 0
    ) {
      throw new Error("Invalid managed.apply resources.memoryReservationBytes");
    }
    resources.memoryReservationBytes = value.memoryReservationBytes;
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}

function parseManagedApplyExposureBindAddress(value: unknown): string {
  if (
    !isString(value) ||
    value.length === 0 ||
    (!isValidIpv4Literal(value) && !isValidIpv6Literal(value))
  ) {
    throw new Error("Invalid managed.apply exposure.bindAddress");
  }
  return value;
}

function parseManagedApplyExposure(value: unknown): ManagedApplyExposure {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    throw new Error("Invalid managed.apply exposure");
  }
  if (
    !isString(value.protocol) || !MANAGED_EXPOSURE_PROTOCOLS.has(value.protocol)
  ) {
    throw new Error("Invalid managed.apply exposure.protocol");
  }
  const exposure: ManagedApplyExposure = {
    enabled: value.enabled,
    protocol: value.protocol as ManagedApplyExposure["protocol"],
  };
  if (value.bindAddress !== undefined) {
    exposure.bindAddress = parseManagedApplyExposureBindAddress(
      value.bindAddress,
    );
  }
  return exposure;
}

/** Compose YAML service-key charset (`service.compose_service_name`). */
function isValidComposeServiceName(value: string): boolean {
  return value.length > 0 && value.length <= 255 &&
    /^[A-Za-z0-9._-]+$/.test(value);
}

function parseManagedApplyPeers(value: unknown): ManagedApplyPeer[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply peers");
  }
  if (value.length > MAX_MANAGED_PEERS) {
    throw new Error("Invalid managed.apply peers: too many entries");
  }
  const peers: ManagedApplyPeer[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error("Invalid managed.apply peers entry");
    }
    if (
      !isString(entry.memberId) ||
      !UUID_RE.test(entry.memberId) ||
      !isString(entry.role) ||
      !MANAGED_MEMBER_ROLES.has(entry.role) ||
      typeof entry.readEligible !== "boolean" ||
      !isString(entry.address) ||
      (!isValidIpv4Literal(entry.address) &&
        !isValidIpv6Literal(entry.address) &&
        !isValidDockerResourceName(entry.address)) ||
      !isString(entry.transport) ||
      !MANAGED_PEER_TRANSPORTS.has(entry.transport) ||
      !isValidPortNumber(entry.port)
    ) {
      throw new Error("Invalid managed.apply peers entry");
    }
    const peer: ManagedApplyPeer = {
      memberId: entry.memberId,
      role: entry.role as ManagedApplyPeer["role"],
      readEligible: entry.readEligible,
      address: entry.address,
      transport: entry.transport as ManagedApplyPeer["transport"],
      port: entry.port,
    };
    if (entry.containerName !== undefined) {
      if (
        !isString(entry.containerName) ||
        !isValidDockerResourceName(entry.containerName)
      ) {
        throw new Error("Invalid managed.apply peers entry");
      }
      peer.containerName = entry.containerName;
    }
    peers.push(peer);
  }
  return peers;
}

function parseManagedApplyPrivateListener(
  value: unknown,
): ManagedApplyPrivateListener | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid managed.apply privateListener");
  }
  if (
    !isString(value.address) ||
    (!isValidIpv4Literal(value.address) &&
      !isValidIpv6Literal(value.address)) ||
    isLoopbackIpLiteral(value.address) ||
    !isValidPortNumber(value.port)
  ) {
    throw new Error("Invalid managed.apply privateListener");
  }
  const listener: ManagedApplyPrivateListener = {
    address: value.address,
    port: value.port,
  };
  if (value.transport !== undefined) {
    if (
      !isString(value.transport) ||
      !MANAGED_PEER_TRANSPORTS.has(value.transport)
    ) {
      throw new Error("Invalid managed.apply privateListener");
    }
    listener.transport = value
      .transport as ManagedApplyPrivateListener["transport"];
  }
  return listener;
}

function parseManagedApplyReplicationSlotName(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || !isSafeIdentifier(value)) {
    throw new Error("Invalid managed.apply replication.slotName");
  }
  return value;
}

function parseManagedApplyReplicationDesiredSlots(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply replication.desiredSlots");
  }
  if (value.length > MAX_MANAGED_DESIRED_SLOTS) {
    throw new Error("Invalid managed.apply replication.desiredSlots");
  }
  const slots: string[] = [];
  for (const slot of value) {
    if (!isString(slot) || !isSafeIdentifier(slot)) {
      throw new Error("Invalid managed.apply replication.desiredSlots");
    }
    slots.push(slot);
  }
  return slots;
}

function isValidManagedReplicationPeerAddress(
  address: unknown,
): address is string {
  return (
    isString(address) &&
    (isValidIpv4Literal(address) ||
      isValidIpv6Literal(address) ||
      isValidDockerResourceName(address))
  );
}

function parseManagedApplyReplicationPeerAddresses(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply replication.peerAddresses");
  }
  if (value.length > MAX_MANAGED_PEER_ADDRESSES) {
    throw new Error("Invalid managed.apply replication.peerAddresses");
  }
  const addresses: string[] = [];
  for (const address of value) {
    if (!isValidManagedReplicationPeerAddress(address)) {
      throw new Error("Invalid managed.apply replication.peerAddresses");
    }
    addresses.push(address);
  }
  return addresses;
}

function parseManagedApplyReplicationPrimaryHostaddr(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    !isString(value) ||
    (!isValidIpv4Literal(value) && !isValidIpv6Literal(value))
  ) {
    throw new Error("Invalid managed.apply replication.primary.hostaddr");
  }
  return value;
}

function parseManagedApplyReplicationPrimary(
  value: unknown,
): ManagedApplyReplicationPrimary | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid managed.apply replication.primary");
  }
  if (
    !isString(value.host) ||
    value.host.length === 0 ||
    value.host.length > HOSTNAME_MAX_LENGTH ||
    !isValidPortNumber(value.port)
  ) {
    throw new Error("Invalid managed.apply replication.primary");
  }
  const primary: ManagedApplyReplicationPrimary = {
    host: value.host,
    port: value.port,
  };
  const hostaddr = parseManagedApplyReplicationPrimaryHostaddr(value.hostaddr);
  if (hostaddr !== undefined) primary.hostaddr = hostaddr;
  return primary;
}

function assertManagedApplyReplicationRoleRequirements(
  replication: ManagedApplyReplication,
): void {
  if (
    replication.role === "standby" &&
    (replication.slotName === undefined || replication.primary === undefined)
  ) {
    throw new Error(
      "Invalid managed.apply replication: standby requires slotName and primary",
    );
  }
  if (
    replication.role === "primary" && replication.desiredSlots === undefined
  ) {
    throw new Error(
      "Invalid managed.apply replication: primary requires desiredSlots",
    );
  }
}

function parseManagedApplyReplication(
  value: unknown,
): ManagedApplyReplication | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid managed.apply replication");
  }
  if (
    !isString(value.role) ||
    !MANAGED_REPLICATION_ROLES.has(value.role) ||
    !isString(value.username) ||
    !isSafeUsername(value.username)
  ) {
    throw new Error("Invalid managed.apply replication");
  }

  const replication: ManagedApplyReplication = {
    role: value.role as ManagedApplyReplication["role"],
    username: value.username,
  };

  const slotName = parseManagedApplyReplicationSlotName(value.slotName);
  if (slotName !== undefined) replication.slotName = slotName;

  const desiredSlots = parseManagedApplyReplicationDesiredSlots(
    value.desiredSlots,
  );
  if (desiredSlots !== undefined) replication.desiredSlots = desiredSlots;

  const peerAddresses = parseManagedApplyReplicationPeerAddresses(
    value.peerAddresses,
  );
  if (peerAddresses !== undefined) replication.peerAddresses = peerAddresses;

  const primary = parseManagedApplyReplicationPrimary(value.primary);
  if (primary !== undefined) replication.primary = primary;

  assertManagedApplyReplicationRoleRequirements(replication);

  return replication;
}

export function parseManagedReplicationHealth(
  value: unknown,
): ManagedReplicationHealth | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (
    !isString(value.state) ||
    !MANAGED_REPLICATION_STATES.has(value.state) ||
    !isString(value.observedAt) ||
    !isIsoTimestamp(value.observedAt)
  ) {
    return undefined;
  }
  const health: ManagedReplicationHealth = {
    state: value.state,
    observedAt: value.observedAt,
  };
  if (
    typeof value.lagBytes === "number" &&
    Number.isFinite(value.lagBytes) &&
    value.lagBytes >= 0
  ) {
    health.lagBytes = value.lagBytes;
  }
  if (
    typeof value.lagSeconds === "number" &&
    Number.isFinite(value.lagSeconds) &&
    value.lagSeconds >= 0
  ) {
    health.lagSeconds = value.lagSeconds;
  }
  return health;
}

function parseManagedMemberObservedResult(
  value: unknown,
): ManagedMemberObservedResult | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (
    !isString(value.memberId) ||
    !UUID_RE.test(value.memberId) ||
    !isString(value.role) ||
    value.role.length === 0 ||
    !isString(value.status) ||
    value.status.length === 0
  ) {
    return undefined;
  }
  const member: ManagedMemberObservedResult = {
    memberId: value.memberId,
    role: value.role,
    status: value.status,
  };
  const replication = parseManagedReplicationHealth(value.replication);
  if (replication !== undefined) member.replication = replication;
  return member;
}

function parseManagedApplyCredentialDatabases(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply credentials entry");
  }
  const databases: string[] = [];
  for (const name of value) {
    if (!isString(name) || !isSafeIdentifier(name)) {
      throw new Error("Invalid managed.apply credentials.databases");
    }
    databases.push(name);
  }
  return databases;
}

function parseManagedApplyCredentialPrivileges(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply credentials.privileges");
  }
  if (!value.every(isString)) {
    throw new Error("Invalid managed.apply credentials.privileges");
  }
  return value as string[];
}

function parseManagedApplyCredentialEntry(
  entry: unknown,
): ManagedApplyCredential {
  if (!isRecord(entry)) {
    throw new Error("Invalid managed.apply credentials entry");
  }
  if (
    !isString(entry.principalId) ||
    entry.principalId.length === 0 ||
    !isString(entry.username) ||
    !isSafeUsername(entry.username) ||
    !isString(entry.role) ||
    !MANAGED_CREDENTIAL_ROLES.has(entry.role) ||
    !isString(entry.password) ||
    !entry.password.startsWith(DAEMON_ENVELOPE_PREFIX)
  ) {
    throw new Error("Invalid managed.apply credentials entry");
  }
  const credential: ManagedApplyCredential = {
    principalId: entry.principalId,
    username: entry.username,
    role: entry.role as ManagedApplyCredential["role"],
    databases: parseManagedApplyCredentialDatabases(entry.databases),
    password: entry.password,
  };
  const privileges = parseManagedApplyCredentialPrivileges(entry.privileges);
  if (privileges !== undefined) credential.privileges = privileges;
  return credential;
}

function parseManagedApplyCredentials(
  value: unknown,
): ManagedApplyCredential[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply credentials");
  }
  if (value.length === 0) {
    throw new Error("Invalid managed.apply credentials");
  }
  if (value.length > MAX_MANAGED_CREDENTIALS) {
    throw new Error("Invalid managed.apply credentials: too many entries");
  }
  return value.map(parseManagedApplyCredentialEntry);
}

function parseManagedApplyDatabases(
  value: unknown,
): ManagedApplyDatabaseOp[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply databases");
  }
  if (value.length > MAX_MANAGED_DATABASES) {
    throw new Error("Invalid managed.apply databases: too many entries");
  }
  const databases: ManagedApplyDatabaseOp[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isString(entry.name) ||
      !isSafeIdentifier(entry.name) ||
      !isString(entry.action) ||
      !MANAGED_DATABASE_ACTIONS.has(entry.action)
    ) {
      throw new Error("Invalid managed.apply databases entry");
    }
    databases.push({
      name: entry.name,
      action: entry.action as ManagedApplyDatabaseOp["action"],
    });
  }
  return databases;
}

function parseManagedApplyDropUsers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply dropUsers");
  }
  if (value.length > MAX_MANAGED_DROP_USERS) {
    throw new Error("Invalid managed.apply dropUsers: too many entries");
  }
  const dropUsers: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || !isSafeUsername(entry)) {
      throw new Error("Invalid managed.apply dropUsers entry");
    }
    dropUsers.push(entry);
  }
  return dropUsers;
}

function parseManagedApplyTlsMaterial(
  value: unknown,
): ManagedApplyTlsMaterial | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid managed.apply tlsMaterial");
  }
  if (
    value.selfSigned !== true ||
    !isString(value.commonName) ||
    !isValidHostname(value.commonName) ||
    !isString(value.certPath) ||
    !isAllowedManagedConfigPath(value.certPath) ||
    !isString(value.keyPath) ||
    !isAllowedManagedConfigPath(value.keyPath)
  ) {
    throw new Error("Invalid managed.apply tlsMaterial");
  }
  return {
    selfSigned: true,
    commonName: value.commonName,
    certPath: value.certPath,
    keyPath: value.keyPath,
  };
}

function parseManagedApplyOrgTlsMaterial(
  value: unknown,
): ManagedApplyOrgTlsMaterial | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid managed.apply orgTlsMaterial");
  }
  if (
    !isString(value.certificatePem) ||
    value.certificatePem.length === 0 ||
    !value.certificatePem.includes("BEGIN CERTIFICATE") ||
    !isString(value.privateKeyEnvelope) ||
    value.privateKeyEnvelope.length === 0 ||
    !isString(value.caCertPem) ||
    value.caCertPem.length === 0 ||
    !value.caCertPem.includes("BEGIN CERTIFICATE")
  ) {
    throw new Error("Invalid managed.apply orgTlsMaterial");
  }
  return {
    certificatePem: value.certificatePem,
    privateKeyEnvelope: value.privateKeyEnvelope,
    caCertPem: value.caCertPem,
  };
}

export function parseManagedApplyPayload(
  value: unknown,
): ManagedApplyCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.apply payload");
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.environmentId) ||
    value.environmentId.length === 0 ||
    !isString(value.engine) ||
    !isManagedEngineCode(value.engine) ||
    !isString(value.projectName) ||
    !isComposeProjectName(value.projectName) ||
    !isString(value.containerName) ||
    !isValidDockerResourceName(value.containerName) ||
    !isString(value.image) ||
    !isValidManagedImageRef(value.image) ||
    !isValidPortNumber(value.containerPort) ||
    !isString(value.composeYaml) ||
    value.composeYaml.length === 0 ||
    !isString(value.memberId) ||
    !UUID_RE.test(value.memberId) ||
    !isString(value.memberRole) ||
    !MANAGED_MEMBER_ROLES.has(value.memberRole) ||
    typeof value.memberOrdinal !== "number" ||
    !Number.isInteger(value.memberOrdinal) ||
    value.memberOrdinal < 1 ||
    typeof value.readEligible !== "boolean"
  ) {
    throw new Error("Invalid managed.apply payload");
  }

  // Mirrors the engine settings parser's image allowlist (see
  // `../managed/settings.ts`) so a payload that bypassed the settings save
  // path (a stale/replayed command, or a future direct-apply caller) cannot
  // smuggle an unsupported/EOL image past the daemon.
  if (!isManagedImageAllowed(value.engine, value.image)) {
    throw new Error("Invalid managed.apply payload");
  }

  // containerName must be `<uuid>-<memberOrdinal>` (managedContainerName shape).
  const ordinalSuffix = `-${value.memberOrdinal}`;
  if (!value.containerName.endsWith(ordinalSuffix)) {
    throw new Error("Invalid managed.apply payload");
  }
  const serviceIdPart = value.containerName.slice(0, -ordinalSuffix.length);
  try {
    if (
      managedContainerName(serviceIdPart, value.memberOrdinal) !==
        value.containerName
    ) {
      throw new Error("Invalid managed.apply payload");
    }
  } catch {
    throw new Error("Invalid managed.apply payload");
  }

  const dockerOptions = parseManagedDockerOptions(
    value.dockerOptions,
    getManagedReservedEnvKeys(value.engine),
  );
  if (dockerOptions === null) {
    throw new Error("Invalid managed.apply dockerOptions");
  }

  const resources = parseManagedApplyResources(value.resources);
  const databases = parseManagedApplyDatabases(value.databases);
  const dropUsers = parseManagedApplyDropUsers(value.dropUsers);
  const tlsMaterial = parseManagedApplyTlsMaterial(value.tlsMaterial);
  const orgTlsMaterial = parseManagedApplyOrgTlsMaterial(value.orgTlsMaterial);
  const exposure = parseManagedApplyExposure(value.exposure);
  const peers = parseManagedApplyPeers(value.peers);
  const privateListener = parseManagedApplyPrivateListener(
    value.privateListener,
  );
  const replication = parseManagedApplyReplication(value.replication);

  return {
    managedId: value.managedId,
    environmentId: value.environmentId,
    engine: value.engine,
    projectName: value.projectName,
    containerName: value.containerName,
    image: value.image,
    containerPort: value.containerPort,
    composeYaml: value.composeYaml,
    configFiles: parseManagedApplyConfigFiles(value.configFiles),
    volumes: parseManagedApplyVolumes(value.volumes),
    ...(resources === undefined ? {} : { resources }),
    ...(dockerOptions === undefined ? {} : { dockerOptions }),
    exposure,
    memberId: value.memberId,
    memberRole: value.memberRole as ManagedApplyCommandPayload["memberRole"],
    memberOrdinal: value.memberOrdinal,
    readEligible: value.readEligible,
    peers,
    ...(privateListener === undefined ? {} : { privateListener }),
    ...(replication === undefined ? {} : { replication }),
    credentials: parseManagedApplyCredentials(value.credentials),
    ...(databases === undefined ? {} : { databases }),
    ...(dropUsers === undefined ? {} : { dropUsers }),
    ...(tlsMaterial === undefined ? {} : { tlsMaterial }),
    ...(orgTlsMaterial === undefined ? {} : { orgTlsMaterial }),
  };
}

export function parseManagedApplyResult(
  value: unknown,
): ManagedApplyCommandResult {
  if (!isRecord(value)) {
    return { host: "", port: 0 };
  }
  const result: ManagedApplyCommandResult = {
    host: isString(value.host) ? value.host : "",
    port: isValidPortNumber(value.port) ? value.port : 0,
  };
  const containers = parseDeployContainers(value.containers);
  if (containers !== undefined) result.containers = containers;
  if (Array.isArray(value.appliedUsers) && value.appliedUsers.every(isString)) {
    result.appliedUsers = value.appliedUsers as string[];
  }
  if (
    Array.isArray(value.appliedDatabases) &&
    value.appliedDatabases.every(isString)
  ) {
    result.appliedDatabases = value.appliedDatabases as string[];
  }
  if (isString(value.engineVersion)) result.engineVersion = value.engineVersion;
  if (isString(value.summary)) result.summary = value.summary;
  const member = parseManagedMemberObservedResult(value.member);
  if (member !== undefined) result.member = member;
  if (isString(value.memberId) && UUID_RE.test(value.memberId)) {
    result.memberId = value.memberId; // NOSONAR typescript:S1874 — deprecated field populated intentionally for transitional clients
  }
  if (isString(value.status)) result.status = value.status; // NOSONAR typescript:S1874 — deprecated field populated intentionally for transitional clients
  return result;
}

export function parseManagedLifecyclePayload(
  value: unknown,
): ManagedLifecycleCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.lifecycle payload");
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.action) ||
    !MANAGED_LIFECYCLE_ACTIONS.has(value.action)
  ) {
    throw new Error("Invalid managed.lifecycle payload");
  }
  const payload: ManagedLifecycleCommandPayload = {
    managedId: value.managedId,
    action: value.action as ManagedLifecycleCommandPayload["action"],
  };
  if (value.memberId !== undefined) {
    if (!isString(value.memberId) || !UUID_RE.test(value.memberId)) {
      throw new Error("Invalid managed.lifecycle payload");
    }
    payload.memberId = value.memberId;
  }
  if (value.engine !== undefined) {
    if (!isString(value.engine) || !isManagedEngineCode(value.engine)) {
      throw new Error("Invalid managed.lifecycle payload");
    }
    payload.engine = value.engine;
  }
  return payload;
}

export function parseManagedLifecycleResult(
  value: unknown,
): ManagedLifecycleCommandResult {
  if (!isRecord(value)) {
    return { status: "" };
  }
  const result: ManagedLifecycleCommandResult = {
    status: isString(value.status) ? value.status : "",
  };
  if (isString(value.summary)) result.summary = value.summary;
  const member = parseManagedMemberObservedResult(value.member);
  if (member !== undefined) result.member = member;
  return result;
}

export function parseManagedDestroyPayload(
  value: unknown,
): ManagedDestroyCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.destroy payload");
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    typeof value.removeVolumes !== "boolean"
  ) {
    throw new Error("Invalid managed.destroy payload");
  }
  if (
    value.deleteAfterDestroy !== undefined &&
    typeof value.deleteAfterDestroy !== "boolean"
  ) {
    throw new Error("Invalid managed.destroy payload");
  }
  if (
    value.deleteMemberAfterDestroy !== undefined &&
    typeof value.deleteMemberAfterDestroy !== "boolean"
  ) {
    throw new Error("Invalid managed.destroy payload");
  }
  const payload: ManagedDestroyCommandPayload = {
    managedId: value.managedId,
    removeVolumes: value.removeVolumes,
  };
  if (typeof value.deleteAfterDestroy === "boolean") {
    payload.deleteAfterDestroy = value.deleteAfterDestroy;
  }
  if (typeof value.deleteMemberAfterDestroy === "boolean") {
    payload.deleteMemberAfterDestroy = value.deleteMemberAfterDestroy;
  }
  if (value.memberId !== undefined) {
    if (!isString(value.memberId) || !UUID_RE.test(value.memberId)) {
      throw new Error("Invalid managed.destroy payload");
    }
    payload.memberId = value.memberId;
  }
  return payload;
}

export function parseManagedDestroyResult(
  value: unknown,
): ManagedDestroyCommandResult {
  if (!isRecord(value)) {
    return { status: "", containers: [] };
  }
  const containers = parseDeployContainers(value.containers) ?? [];
  const result: ManagedDestroyCommandResult = {
    status: isString(value.status) ? value.status : "",
    containers,
  };
  if (isString(value.summary)) result.summary = value.summary;
  return result;
}

export function parseManagedPromotePayload(
  value: unknown,
): ManagedPromoteCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.promote payload");
  }
  if (
    !isString(value.managedId) ||
    !UUID_RE.test(value.managedId) ||
    !isString(value.memberId) ||
    !UUID_RE.test(value.memberId)
  ) {
    throw new Error("Invalid managed.promote payload");
  }
  const payload: ManagedPromoteCommandPayload = {
    managedId: value.managedId,
    memberId: value.memberId,
  };
  if (value.demoteMemberId !== undefined) {
    if (
      !isString(value.demoteMemberId) || !UUID_RE.test(value.demoteMemberId)
    ) {
      throw new Error("Invalid managed.promote payload");
    }
    payload.demoteMemberId = value.demoteMemberId;
  }
  if (value.engine !== undefined) {
    if (!isString(value.engine) || !isManagedEngineCode(value.engine)) {
      throw new Error("Invalid managed.promote payload");
    }
    payload.engine = value.engine;
  }
  return payload;
}

export function parseManagedPromoteResult(
  value: unknown,
): ManagedPromoteCommandResult {
  if (!isRecord(value)) {
    return { status: "", role: "", promotedMemberId: "", demoted: false };
  }
  const result: ManagedPromoteCommandResult = {
    status: isString(value.status) ? value.status : "",
    role: isString(value.role) ? value.role : "",
    promotedMemberId:
      isString(value.promotedMemberId) && UUID_RE.test(value.promotedMemberId)
        ? value.promotedMemberId
        : "",
    demoted: value.demoted === true,
  };
  if (isString(value.demotedMemberId) && UUID_RE.test(value.demotedMemberId)) {
    result.demotedMemberId = value.demotedMemberId;
  }
  if (isString(value.summary)) result.summary = value.summary;
  const replication = parseManagedReplicationHealth(value.replication);
  if (replication !== undefined) result.replication = replication;
  return result;
}

/** Mirrors the daemon `SAFE_MANAGED_ID_RE` (`turbopaneld/src/managed/paths.ts`) — backupId becomes a filename. */
const SAFE_BACKUP_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BACKUP_ID_LENGTH = 64;
const CHECKSUM_SHA256_RE = /^[a-f0-9]{64}$/;
const MANAGED_BACKUP_ACTIONS = new Set(["create", "delete"]);
const MANAGED_BACKUP_SCOPES = new Set(["database", "instance"]);
/** Bound on `managed.backup` payload `retentionKeep` — mirrors managed/settings.ts. */
const MAX_BACKUP_RETENTION_KEEP_BOUND = 100;
const MAX_PRUNED_BACKUP_IDS = 200;

function isSafeBackupId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_BACKUP_ID_LENGTH &&
    SAFE_BACKUP_ID_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

export type ManagedBackupCommandPayload = {
  managedId: string;
  engine: ManagedEngineCode;
  action: "create" | "delete";
  backupId: string;
  artifactExtension: ManagedBackupArtifactExtension;
  scope: "database" | "instance";
  database?: string;
  retentionKeep?: number;
};

export type ManagedBackupCommandResult = {
  backupId: string;
  deleted?: boolean;
  path?: string;
  sizeBytes?: number;
  checksum?: string;
  completedAt?: string;
  database?: string;
  pruned?: string[];
  summary?: string;
};

export type ManagedRestoreCommandPayload = {
  managedId: string;
  engine: ManagedEngineCode;
  backupId: string;
  artifactExtension: ManagedBackupArtifactExtension;
  database?: string;
  checksum: string;
  sizeBytes?: number;
};

export type ManagedRestoreCommandResult = {
  backupId: string;
  status?: string;
  restoredAt?: string;
  database?: string;
  summary?: string;
};

export function parseManagedBackupPayload(
  value: unknown,
): ManagedBackupCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.backup payload");
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.engine) ||
    !isManagedEngineCode(value.engine) ||
    !isString(value.action) ||
    !MANAGED_BACKUP_ACTIONS.has(value.action) ||
    !isString(value.backupId) ||
    !isSafeBackupId(value.backupId) ||
    !isString(value.artifactExtension) ||
    !isManagedBackupArtifactExtension(value.artifactExtension) ||
    !isString(value.scope) ||
    !MANAGED_BACKUP_SCOPES.has(value.scope)
  ) {
    throw new Error("Invalid managed.backup payload");
  }
  const payload: ManagedBackupCommandPayload = {
    managedId: value.managedId,
    engine: value.engine,
    action: value.action as ManagedBackupCommandPayload["action"],
    backupId: value.backupId,
    artifactExtension: value.artifactExtension,
    scope: value.scope as ManagedBackupCommandPayload["scope"],
  };
  if (value.database !== undefined) {
    if (!isString(value.database) || !isSafeIdentifier(value.database)) {
      throw new Error("Invalid managed.backup payload database");
    }
    payload.database = value.database;
  }
  if (payload.scope === "database" && payload.database === undefined) {
    throw new Error(
      "Invalid managed.backup payload: scope database requires database",
    );
  }
  if (value.retentionKeep !== undefined) {
    if (
      typeof value.retentionKeep !== "number" ||
      !Number.isInteger(value.retentionKeep) ||
      value.retentionKeep < 1 ||
      value.retentionKeep > MAX_BACKUP_RETENTION_KEEP_BOUND
    ) {
      throw new Error("Invalid managed.backup payload retentionKeep");
    }
    payload.retentionKeep = value.retentionKeep;
  }
  return payload;
}

/** Lenient result parser (like other managed results): missing → omitted. Never carries dump contents. */
export function parseManagedBackupResult(
  value: unknown,
): ManagedBackupCommandResult {
  if (
    !isRecord(value) || !isString(value.backupId) || value.backupId.length === 0
  ) {
    return { backupId: "" };
  }
  const result: ManagedBackupCommandResult = { backupId: value.backupId };
  if (typeof value.deleted === "boolean") result.deleted = value.deleted;
  if (isString(value.path)) result.path = value.path;
  if (
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    value.sizeBytes >= 0
  ) {
    result.sizeBytes = value.sizeBytes;
  }
  if (isString(value.checksum) && CHECKSUM_SHA256_RE.test(value.checksum)) {
    result.checksum = value.checksum;
  }
  if (isString(value.completedAt)) result.completedAt = value.completedAt;
  if (isString(value.database)) result.database = value.database;
  if (Array.isArray(value.pruned) && value.pruned.every(isString)) {
    result.pruned = (value.pruned as string[]).slice(0, MAX_PRUNED_BACKUP_IDS);
  }
  if (isString(value.summary)) result.summary = value.summary;
  return result;
}

export function parseManagedRestorePayload(
  value: unknown,
): ManagedRestoreCommandPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.restore payload");
  }
  if (
    !isString(value.managedId) ||
    value.managedId.length === 0 ||
    !isString(value.engine) ||
    !isManagedEngineCode(value.engine) ||
    !isString(value.backupId) ||
    !isSafeBackupId(value.backupId) ||
    !isString(value.artifactExtension) ||
    !isManagedBackupArtifactExtension(value.artifactExtension) ||
    !isString(value.checksum) ||
    !CHECKSUM_SHA256_RE.test(value.checksum)
  ) {
    throw new Error("Invalid managed.restore payload");
  }
  const payload: ManagedRestoreCommandPayload = {
    managedId: value.managedId,
    engine: value.engine,
    backupId: value.backupId,
    artifactExtension: value.artifactExtension,
    checksum: value.checksum,
  };
  if (value.database !== undefined) {
    if (!isString(value.database) || !isSafeIdentifier(value.database)) {
      throw new Error("Invalid managed.restore payload database");
    }
    payload.database = value.database;
  }
  if (value.sizeBytes !== undefined) {
    if (
      typeof value.sizeBytes !== "number" ||
      !Number.isInteger(value.sizeBytes) ||
      value.sizeBytes < 0
    ) {
      throw new Error("Invalid managed.restore payload sizeBytes");
    }
    payload.sizeBytes = value.sizeBytes;
  }
  return payload;
}

/** Lenient result parser. Never carries dump contents. */
export function parseManagedRestoreResult(
  value: unknown,
): ManagedRestoreCommandResult {
  if (
    !isRecord(value) || !isString(value.backupId) || value.backupId.length === 0
  ) {
    return { backupId: "" };
  }
  const result: ManagedRestoreCommandResult = { backupId: value.backupId };
  if (isString(value.status)) result.status = value.status;
  if (isString(value.restoredAt)) result.restoredAt = value.restoredAt;
  if (isString(value.database)) result.database = value.database;
  if (isString(value.summary)) result.summary = value.summary;
  return result;
}

function isValidHostgroupId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 &&
    value <= 65_535;
}

function parseManagedIngressReconcileBackend(
  value: unknown,
): ManagedIngressReconcileBackend {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile backend");
  }
  if (
    !isString(value.memberId) ||
    !UUID_RE.test(value.memberId) ||
    (value.role !== "primary" && value.role !== "replica") ||
    typeof value.readEligible !== "boolean" ||
    !isString(value.address) ||
    value.address.length === 0 ||
    !isValidPortNumber(value.port) ||
    !MANAGED_PEER_TRANSPORTS.has(value.transport as string)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile backend");
  }
  return {
    memberId: value.memberId,
    role: value.role,
    readEligible: value.readEligible,
    address: value.address,
    port: value.port,
    transport: value.transport as ManagedIngressReconcileBackend["transport"],
  };
}

function parseManagedIngressReconcileUser(
  value: unknown,
): ManagedIngressReconcileUser {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile user");
  }
  if (
    !isString(value.username) ||
    !isSafeUsername(value.username) ||
    (value.role !== "root" && value.role !== "user") ||
    !isString(value.password) ||
    !value.password.startsWith(DAEMON_ENVELOPE_PREFIX)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile user");
  }
  const user: ManagedIngressReconcileUser = {
    username: value.username,
    role: value.role,
    password: value.password,
  };
  if (value.defaultDatabase !== undefined) {
    if (
      !isString(value.defaultDatabase) ||
      !isSafeIdentifier(value.defaultDatabase)
    ) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile user defaultDatabase",
      );
    }
    user.defaultDatabase = value.defaultDatabase;
  }
  if (value.connectionRole !== undefined) {
    if (!isManagedConnectionRole(value.connectionRole)) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile user connectionRole",
      );
    }
    user.connectionRole = value.connectionRole;
  }
  return user;
}

function parseManagedIngressReconcileCluster(
  value: unknown,
): ManagedIngressReconcileCluster {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile cluster");
  }
  if (
    !isString(value.managedId) ||
    !SAFE_BACKUP_ID_RE.test(value.managedId) ||
    !isString(value.engine) ||
    !isManagedEngineCode(value.engine) ||
    !isManagedIngressProtocolPort(value.protocolPort) ||
    !isManagedIngressFamily(value.family) ||
    !isValidHostgroupId(value.writerHostgroup) ||
    !isValidHostgroupId(value.readerHostgroup) ||
    !Array.isArray(value.backends) ||
    !Array.isArray(value.users)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile cluster");
  }
  if (
    value.autoReadSplit !== undefined &&
    typeof value.autoReadSplit !== "boolean"
  ) {
    throw new TypeError(
      "Invalid managed.ingress.reconcile cluster autoReadSplit",
    );
  }
  if (value.requireTls !== undefined && typeof value.requireTls !== "boolean") {
    throw new TypeError("Invalid managed.ingress.reconcile cluster requireTls");
  }
  const cluster: ManagedIngressReconcileCluster = {
    managedId: value.managedId,
    engine: value.engine,
    protocolPort: value.protocolPort,
    family: value.family,
    writerHostgroup: value.writerHostgroup,
    readerHostgroup: value.readerHostgroup,
    backends: value.backends.map(parseManagedIngressReconcileBackend),
    users: value.users.map(parseManagedIngressReconcileUser),
  };
  if (value.autoReadSplit !== undefined) {
    cluster.autoReadSplit = value.autoReadSplit;
  }
  if (value.requireTls !== undefined) cluster.requireTls = value.requireTls;
  return cluster;
}

function isManagedIngressFamily(
  value: unknown,
): value is ManagedIngressFamily {
  return value === "pgsql" || value === "mysql";
}

function parseManagedIngressListenerPorts(value: unknown): ManagedIngressPorts {
  if (
    !isRecord(value) ||
    !isManagedIngressProtocolPort(value.postgres) ||
    !isManagedIngressProtocolPort(value.mysqlFamily)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile listenerPorts");
  }
  const ports: ManagedIngressPorts = {
    postgres: value.postgres,
    mysqlFamily: value.mysqlFamily,
  };
  // Both families are validated together: a colliding pair would let ProxySQL
  // bind one listener and leave the other protocol silently unreachable.
  if (!validateManagedIngressPorts(ports).ok) {
    throw new TypeError("Invalid managed.ingress.reconcile listenerPorts");
  }
  return ports;
}

function parseManagedIngressBindAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile bindAddresses");
  }
  const addresses: string[] = [];
  for (const entry of value) {
    const address = parseManagedIngressBindAddress(entry);
    if (!addresses.includes(address)) addresses.push(address);
  }
  return addresses;
}

function parseManagedIngressBindAddress(value: unknown): string {
  if (
    !isString(value) ||
    value.length === 0 ||
    (!isValidIpv4Literal(value) &&
      !isValidIpv6Literal(value) &&
      value !== "0.0.0.0" &&
      value !== "::" &&
      value !== "::0") // NOSONAR typescript:S1313 — IPv6 all-interfaces bind synonym (::0 == ::), not a reachable host
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile bindAddress");
  }
  return value;
}

function parseManagedIngressSegment(
  value: unknown,
): { name: string; subnet: string } {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile segment");
  }
  if (
    !isString(value.name) ||
    !value.name.startsWith("tpn_") ||
    !FABRIC_DOCKER_NETWORK_NAME_RE.test(value.name)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile segment name");
  }
  if (!isString(value.subnet) || !isValidCidr(value.subnet.trim())) {
    throw new TypeError("Invalid managed.ingress.reconcile segment subnet");
  }
  return { name: value.name, subnet: value.subnet.trim() };
}

function parseManagedIngressSegments(
  value: unknown,
): Array<{ name: string; subnet: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile segments");
  }
  const byName = new Map<string, { name: string; subnet: string }>();
  for (const entry of value) {
    const parsed = parseManagedIngressSegment(entry);
    byName.set(parsed.name, parsed);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseManagedIngressIdentity(
  value: unknown,
): NonNullable<ManagedIngressReconcileCommandPayload["identity"]> {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile identity");
  }
  if (
    !isString(value.serviceId) ||
    !UUID_RE.test(value.serviceId) ||
    value.composeServiceName !== "proxysql" ||
    !isString(value.containerName) ||
    value.containerName !==
      ingressContainerNameFromService(value.serviceId)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile identity");
  }
  return {
    serviceId: value.serviceId,
    composeServiceName: value.composeServiceName,
    containerName: value.containerName,
  };
}

/** Must stay in sync with the daemon `managed.ingress.reconcile` validator. */
export function parseManagedIngressReconcilePayload(
  value: unknown,
): ManagedIngressReconcileCommandPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile payload");
  }
  if (
    !isString(value.serverId) ||
    !UUID_RE.test(value.serverId) ||
    !Array.isArray(value.clusters)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile payload");
  }
  const orgTlsMaterial = parseManagedApplyOrgTlsMaterial(value.orgTlsMaterial);
  const payload: ManagedIngressReconcileCommandPayload = {
    serverId: value.serverId,
    clusters: value.clusters.map(parseManagedIngressReconcileCluster),
  };
  if (orgTlsMaterial !== undefined) {
    payload.orgTlsMaterial = orgTlsMaterial;
  }
  if (value.bindAddresses !== undefined) {
    payload.bindAddresses = parseManagedIngressBindAddresses(
      value.bindAddresses,
    );
  }
  if (value.listenerPorts !== undefined) {
    payload.listenerPorts = parseManagedIngressListenerPorts(
      value.listenerPorts,
    );
  }
  if (value.segments !== undefined) {
    payload.segments = parseManagedIngressSegments(value.segments);
  }
  if (value.identity !== undefined) {
    payload.identity = parseManagedIngressIdentity(value.identity);
  }
  return payload;
}

/** Must stay in sync with the daemon `managed.ingress.reconcile` result parser. */
export function parseManagedIngressReconcileResult(
  value: unknown,
): ManagedIngressReconcileCommandResult {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile result");
  }
  if (
    !isString(value.summary) ||
    !Array.isArray(value.appliedUsers) ||
    !value.appliedUsers.every((entry) =>
      isString(entry) && isSafeUsername(entry)
    ) ||
    !Array.isArray(value.appliedBackends) ||
    !value.appliedBackends.every((entry) =>
      isString(entry) && UUID_RE.test(entry)
    ) ||
    typeof value.restarted !== "boolean"
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile result");
  }
  const result: ManagedIngressReconcileCommandResult = {
    summary: value.summary,
    appliedUsers: value.appliedUsers as string[],
    appliedBackends: value.appliedBackends as string[],
    restarted: value.restarted,
  };
  if (value.containers !== undefined) {
    if (!Array.isArray(value.containers)) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile result containers",
      );
    }
    const parsedContainers = parseDeployContainers(value.containers);
    if (parsedContainers?.length !== value.containers.length) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile result containers",
      );
    }
    result.containers = parsedContainers;
  }
  return result;
}

const HA_PROMOTION_RULES = new Set<string>([
  HA_PROMOTION_RULE_PREFER,
  HA_PROMOTION_RULE_MUST_NOT,
]);
const HA_FAILOVER_PHASES = new Set<string>(["drain", "recover"]);
const MAX_HA_CLUSTERS = 64;
const MAX_HA_MEMBERS = 32;
const MAX_HA_PEERS = 32;

function parseManagedHaIdentity(
  value: unknown,
): ManagedHaReconcileCommandPayload["identity"] {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile identity");
  }
  if (
    !isString(value.serviceId) ||
    !UUID_RE.test(value.serviceId) ||
    !isString(value.composeServiceName) ||
    value.composeServiceName.length === 0 ||
    !isString(value.containerName) ||
    value.containerName !== managedHaContainerNameFromService(value.serviceId)
  ) {
    throw new TypeError("Invalid managed.ha.reconcile identity");
  }
  return {
    serviceId: value.serviceId,
    composeServiceName: value.composeServiceName,
    containerName: value.containerName,
  };
}

function parseManagedHaRaftPeer(value: unknown): ManagedHaRaftPeer {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile raft peer");
  }
  if (
    !isString(value.nodeId) ||
    !UUID_RE.test(value.nodeId) ||
    !isString(value.address) ||
    !isValidIpAddress(value.address) ||
    !isValidPortNumber(value.raftPort) ||
    !isValidPortNumber(value.httpPort)
  ) {
    throw new TypeError("Invalid managed.ha.reconcile raft peer");
  }
  return {
    nodeId: value.nodeId,
    address: value.address,
    raftPort: value.raftPort,
    httpPort: value.httpPort,
  };
}

function parseManagedHaRaftConfig(value: unknown): ManagedHaRaftConfig {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile raft");
  }
  if (
    !isString(value.nodeId) ||
    !UUID_RE.test(value.nodeId) ||
    !isValidPortNumber(value.httpPort) ||
    !isValidPortNumber(value.raftPort) ||
    !isString(value.advertiseAddress) ||
    !isValidIpAddress(value.advertiseAddress) ||
    !Array.isArray(value.peers) ||
    value.peers.length > MAX_HA_PEERS
  ) {
    throw new TypeError("Invalid managed.ha.reconcile raft");
  }
  return {
    nodeId: value.nodeId,
    httpPort: value.httpPort,
    raftPort: value.raftPort,
    advertiseAddress: value.advertiseAddress,
    peers: value.peers.map(parseManagedHaRaftPeer),
  };
}

function parseManagedHaClusterMember(value: unknown): ManagedHaClusterMember {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile cluster member");
  }
  if (
    !isString(value.memberId) ||
    !UUID_RE.test(value.memberId) ||
    (value.role !== "primary" && value.role !== "replica") ||
    (value.replicaClass !== "failover" &&
      value.replicaClass !== "read" &&
      value.replicaClass !== null) ||
    !HA_PROMOTION_RULES.has(value.promotionRule as string) ||
    !isString(value.host) ||
    value.host.length === 0 ||
    !isValidPortNumber(value.port)
  ) {
    throw new TypeError("Invalid managed.ha.reconcile cluster member");
  }
  const member: ManagedHaClusterMember = {
    memberId: value.memberId,
    role: value.role,
    replicaClass: value.replicaClass,
    promotionRule: value.promotionRule as HaPromotionRule,
    host: value.host,
    port: value.port,
  };
  if (value.containerName !== undefined) {
    if (
      !isString(value.containerName) ||
      !isValidDockerResourceName(value.containerName)
    ) {
      throw new TypeError("Invalid managed.ha.reconcile cluster member");
    }
    member.containerName = value.containerName;
  }
  return member;
}

function parseManagedHaCluster(value: unknown): ManagedHaCluster {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile cluster");
  }
  if (
    !isString(value.managedId) ||
    !SAFE_BACKUP_ID_RE.test(value.managedId) ||
    typeof value.engine !== "string" ||
    !isManagedEngineCode(value.engine) ||
    !isString(value.clusterAlias) ||
    value.clusterAlias.length === 0 ||
    value.clusterAlias.length > 128 ||
    !Array.isArray(value.members) ||
    value.members.length === 0 ||
    value.members.length > MAX_HA_MEMBERS ||
    !isString(value.replicationUsername) ||
    !isSafeUsername(value.replicationUsername) ||
    !isString(value.replicationPasswordEnvelope) ||
    !value.replicationPasswordEnvelope.startsWith(DAEMON_ENVELOPE_PREFIX)
  ) {
    throw new TypeError("Invalid managed.ha.reconcile cluster");
  }
  return {
    managedId: value.managedId,
    engine: value.engine,
    clusterAlias: value.clusterAlias,
    members: value.members.map(parseManagedHaClusterMember),
    replicationUsername: value.replicationUsername,
    replicationPasswordEnvelope: value.replicationPasswordEnvelope,
  };
}

/** Must stay in sync with the daemon `managed.ha.reconcile` validator. */
export function parseManagedHaReconcilePayload(
  value: unknown,
): ManagedHaReconcileCommandPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile payload");
  }
  if (
    !isString(value.serverId) ||
    !UUID_RE.test(value.serverId) ||
    (value.desired !== "present" && value.desired !== "absent") ||
    !Array.isArray(value.clusters) ||
    value.clusters.length > MAX_HA_CLUSTERS
  ) {
    throw new TypeError("Invalid managed.ha.reconcile payload");
  }
  const raft = value.raft === null
    ? null
    : parseManagedHaRaftConfig(value.raft);
  const orgTlsMaterial = parseManagedApplyOrgTlsMaterial(value.orgTlsMaterial);
  const payload: ManagedHaReconcileCommandPayload = {
    serverId: value.serverId,
    desired: value.desired,
    raft,
    clusters: value.clusters.map(parseManagedHaCluster),
    identity: parseManagedHaIdentity(value.identity),
  };
  if (orgTlsMaterial !== undefined) {
    payload.orgTlsMaterial = orgTlsMaterial;
  }
  return payload;
}

/** Must stay in sync with the daemon `managed.ha.reconcile` result parser. */
export function parseManagedHaReconcileResult(
  value: unknown,
): ManagedHaReconcileCommandResult {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile result");
  }
  if (
    !isString(value.summary) ||
    !Array.isArray(value.registeredClusters) ||
    !value.registeredClusters.every((entry) =>
      isString(entry) && SAFE_BACKUP_ID_RE.test(entry)
    ) ||
    typeof value.restarted !== "boolean"
  ) {
    throw new TypeError("Invalid managed.ha.reconcile result");
  }
  const result: ManagedHaReconcileCommandResult = {
    summary: value.summary,
    registeredClusters: value.registeredClusters as string[],
    restarted: value.restarted,
  };
  if (value.containers !== undefined) {
    if (!Array.isArray(value.containers)) {
      throw new TypeError("Invalid managed.ha.reconcile result containers");
    }
    const parsedContainers = parseDeployContainers(value.containers);
    if (parsedContainers?.length !== value.containers.length) {
      throw new TypeError("Invalid managed.ha.reconcile result containers");
    }
    result.containers = parsedContainers;
  }
  return result;
}

function parseOptionalManagedHaFailoverEngine(
  value: unknown,
): ManagedEngineCode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isManagedEngineCode(value)) {
    throw new TypeError("Invalid managed.ha.failover payload");
  }
  return value;
}

function parseOptionalManagedHaFailoverHost(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || value.length === 0) {
    throw new TypeError("Invalid managed.ha.failover payload");
  }
  return value;
}

function parseOptionalManagedHaFailoverPort(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;
  if (!isValidPortNumber(value)) {
    throw new TypeError("Invalid managed.ha.failover payload");
  }
  return value;
}

/** Must stay in sync with the daemon `managed.ha.failover` validator. */
export function parseManagedHaFailoverPayload(
  value: unknown,
): ManagedHaFailoverCommandPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.failover payload");
  }
  if (
    !isString(value.managedId) ||
    !SAFE_BACKUP_ID_RE.test(value.managedId) ||
    !isString(value.sourceMemberId) ||
    !UUID_RE.test(value.sourceMemberId) ||
    !isString(value.targetMemberId) ||
    !UUID_RE.test(value.targetMemberId) ||
    !HA_FAILOVER_PHASES.has(value.phase as string)
  ) {
    throw new TypeError("Invalid managed.ha.failover payload");
  }
  return {
    managedId: value.managedId,
    sourceMemberId: value.sourceMemberId,
    targetMemberId: value.targetMemberId,
    phase: value.phase as ManagedHaFailoverPhase,
    ...omitUndefinedEntries({
      engine: parseOptionalManagedHaFailoverEngine(value.engine),
      sourceHost: parseOptionalManagedHaFailoverHost(value.sourceHost),
      sourcePort: parseOptionalManagedHaFailoverPort(value.sourcePort),
      targetHost: parseOptionalManagedHaFailoverHost(value.targetHost),
      targetPort: parseOptionalManagedHaFailoverPort(value.targetPort),
    }),
  };
}

/** Must stay in sync with the daemon `managed.ha.failover` result parser. */
export function parseManagedHaFailoverResult(
  value: unknown,
): ManagedHaFailoverCommandResult {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.failover result");
  }
  if (
    !isString(value.summary) ||
    !HA_FAILOVER_PHASES.has(value.phase as string)
  ) {
    throw new TypeError("Invalid managed.ha.failover result");
  }
  return {
    summary: value.summary,
    phase: value.phase as ManagedHaFailoverPhase,
  };
}

export function parseCommandPayload(
  type: CommandType,
  value: unknown,
):
  | PingCommandPayload
  | HostnameSetCommandPayload
  | TimezoneSetCommandPayload
  | NtpSetCommandPayload
  | RebootCommandPayload
  | FabricReconcileCommandPayload
  | TlsTrustReconcileCommandPayload
  | EnvironmentDeployCommandPayload
  | EnvironmentLifecycleCommandPayload
  | EnvironmentStopCommandPayload
  | ManagedApplyCommandPayload
  | ManagedLifecycleCommandPayload
  | ManagedDestroyCommandPayload
  | ManagedBackupCommandPayload
  | ManagedRestoreCommandPayload
  | ManagedPromoteCommandPayload
  | ManagedIngressReconcileCommandPayload
  | ManagedHaReconcileCommandPayload
  | ManagedHaFailoverCommandPayload
  | SystemReconcileCommandPayload {
  switch (type) {
    case "daemon.ping":
      return parsePingPayload(value);
    case "server.hostname.set":
      return parseHostnameSetPayload(value);
    case "server.timezone.set":
      return parseTimezoneSetPayload(value);
    case "server.ntp.set":
      return parseNtpSetPayload(value);
    case "server.reboot":
      return parseRebootPayload(value);
    case "server.fabric.reconcile":
      return parseFabricReconcilePayload(value);
    case "server.tls.trust.reconcile":
      return parseTlsTrustReconcilePayload(value);
    case "environment.deploy":
      return parseEnvironmentDeployPayload(value);
    case "environment.lifecycle":
      return parseEnvironmentLifecyclePayload(value);
    case "environment.stop":
      return parseEnvironmentStopPayload(value);
    case "managed.apply":
      return parseManagedApplyPayload(value);
    case "managed.lifecycle":
      return parseManagedLifecyclePayload(value);
    case "managed.destroy":
      return parseManagedDestroyPayload(value);
    case "managed.backup":
      return parseManagedBackupPayload(value);
    case "managed.restore":
      return parseManagedRestorePayload(value);
    case "managed.promote":
      return parseManagedPromotePayload(value);
    case "managed.ingress.reconcile":
      return parseManagedIngressReconcilePayload(value);
    case "managed.ha.reconcile":
      return parseManagedHaReconcilePayload(value);
    case "managed.ha.failover":
      return parseManagedHaFailoverPayload(value);
    case "system.reconcile":
      return parseSystemReconcilePayload(value);
  }
}

export function parseCommandResult(
  type: CommandType,
  value: unknown,
):
  | PingCommandResult
  | HostnameSetCommandResult
  | TimezoneSetCommandResult
  | NtpSetCommandResult
  | RebootCommandResult
  | FabricReconcileCommandResult
  | TlsTrustReconcileCommandResult
  | EnvironmentDeployCommandResult
  | EnvironmentLifecycleCommandResult
  | EnvironmentStopCommandResult
  | ManagedApplyCommandResult
  | ManagedLifecycleCommandResult
  | ManagedDestroyCommandResult
  | ManagedBackupCommandResult
  | ManagedRestoreCommandResult
  | ManagedPromoteCommandResult
  | ManagedIngressReconcileCommandResult
  | ManagedHaReconcileCommandResult
  | ManagedHaFailoverCommandResult
  | SystemReconcileCommandResult {
  switch (type) {
    case "daemon.ping":
      return parsePingResult(value);
    case "server.hostname.set":
      return parseHostnameSetResult(value);
    case "server.timezone.set":
      return parseTimezoneSetResult(value);
    case "server.ntp.set":
      return parseNtpSetResult(value);
    case "server.reboot":
      return parseRebootResult(value);
    case "server.fabric.reconcile":
      return parseFabricReconcileResult(value);
    case "server.tls.trust.reconcile":
      return parseTlsTrustReconcileResult(value);
    case "environment.deploy":
      return parseEnvironmentDeployResult(value);
    case "environment.lifecycle":
      return parseEnvironmentLifecycleResult(value);
    case "environment.stop":
      return parseEnvironmentStopResult(value);
    case "managed.apply":
      return parseManagedApplyResult(value);
    case "managed.lifecycle":
      return parseManagedLifecycleResult(value);
    case "managed.destroy":
      return parseManagedDestroyResult(value);
    case "managed.backup":
      return parseManagedBackupResult(value);
    case "managed.restore":
      return parseManagedRestoreResult(value);
    case "managed.promote":
      return parseManagedPromoteResult(value);
    case "managed.ingress.reconcile":
      return parseManagedIngressReconcileResult(value);
    case "managed.ha.reconcile":
      return parseManagedHaReconcileResult(value);
    case "managed.ha.failover":
      return parseManagedHaFailoverResult(value);
    case "system.reconcile":
      return parseSystemReconcileResult(value);
  }
}
