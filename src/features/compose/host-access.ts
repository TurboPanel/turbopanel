/**
 * Host-level access by **value**: every place a Compose document can reach a
 * path on the daemon host outside the service's own directory.
 *
 * `./field-policy.ts` gates the keys that are dangerous whatever they say
 * (`privileged`, `use_api_socket`, …). `volumes` is not one of them — a bind
 * inside the service's directory (`./data:/data`) and a named volume are
 * ordinary, and most Compose files use both. What is host-level is a path that
 * resolves anywhere else: `/`, `/etc`, `/var/run/docker.sock`, `~`, `../..`.
 * Compose has more spellings for that than `volumes:`, so all of them are
 * checked here:
 *
 * - `services.<name>.volumes` — short (`src:dst[:mode]`) and long
 *   (`type: bind` / `npipe` / an unknown type) syntax;
 * - top-level `volumes.<name>.driver_opts` that make a local volume a bind
 *   (`o: bind`, `type: none`, a host-path `device`);
 * - top-level `configs.<name>.file` / `secrets.<name>.file`;
 * - `services.<name>.env_file` / `label_file`;
 * - `services.<name>.build` — `context`, `dockerfile`, `additional_contexts`,
 *   and the build-time host reach of `ssh`, `network: host`, `privileged`,
 *   `entitlements`;
 * - `services.<name>.extends.file` and top-level `include`.
 *
 * Fail closed: a path this module cannot resolve statically — an interpolated
 * `${VAR}`, a backslash, a value of the wrong type — is treated as outside.
 *
 * Pure and org-blind, like the rest of `src/features/compose/`: it only says
 * *what* is host-level. Whether this organization may deploy it is decided
 * where org and actor context exist (`validateComposeForDeploy`'s callers).
 */

import {
  GATED_SERVICE_FIELD_KEYS,
  HOST_LEVEL_OPT_IN_SENTENCE,
} from "./field-policy.ts";
import { resolveComposeTags } from "./tags.ts";

/** One host-level reach, at a Compose path, with the authored value. */
export type HostAccessFinding = {
  /** Dot path, `[i]` for sequence items — the same shape the linter reports. */
  path: string;
  /** YAML path segments, for resolving the node (and its line). */
  segments: Array<string | number>;
  message: string;
  /** The authored value at `path`, for the approval fingerprint. */
  value: unknown;
};

const DOCKER_SOCKET_PATHS = new Set([
  "/var/run/docker.sock",
  "/run/docker.sock",
]);

/** Long-syntax `volumes` types that never touch a host path. */
const SAFE_MOUNT_TYPES = new Set(["volume", "tmpfs", "image"]);

/** `driver_opts.type` values that mount remote storage, not a host path. */
const NETWORK_FS_TYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb",
  "smb3",
  "glusterfs",
  "ceph",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinPath(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? segment : `.${segment}`;
  }
  return out;
}

/**
 * Why a host path is outside the service's directory, or `null` when it is a
 * plain relative path that stays inside it.
 */
function outsideReason(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return "is empty, so it cannot be resolved";
  if (trimmed.includes("$")) {
    return "is interpolated, so where it points cannot be checked before deploy";
  }
  if (trimmed.includes("\\")) {
    return "contains a backslash, so where it points cannot be checked";
  }
  if (DOCKER_SOCKET_PATHS.has(trimmed.replace(/\/+$/, ""))) {
    return "is the Docker engine socket, which controls every container on the host";
  }
  if (trimmed.startsWith("/")) return "is an absolute path on the host";
  if (trimmed.startsWith("~")) return "is in a home directory on the host";
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "..")) {
    return "climbs out of the service's directory with `..`";
  }
  return null;
}

/** Whether a URL-shaped build context names a remote source, not a host path. */
function isRemoteContext(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    value.startsWith("git@") ||
    /^github\.com\//i.test(value);
}

class Collector {
  readonly findings: HostAccessFinding[] = [];

  add(
    segments: Array<string | number>,
    what: string,
    reason: string,
    value: unknown,
  ): void {
    this.findings.push({
      path: joinPath(segments),
      segments,
      message: `${what} ${reason} — ${HOST_LEVEL_OPT_IN_SENTENCE}`,
      value,
    });
  }

  /** A path field: flag it unless it is relative and stays inside. */
  path(segments: Array<string | number>, what: string, value: unknown): void {
    if (typeof value !== "string") {
      this.add(segments, what, "is not a plain path, so it cannot be checked", value);
      return;
    }
    const reason = outsideReason(value);
    if (reason) this.add(segments, `${what} \`${value}\``, reason, value);
  }
}

/** Short syntax: `[SOURCE:]TARGET[:MODE]`. Only the source can be a host path. */
function checkShortVolume(
  out: Collector,
  segments: Array<string | number>,
  spec: string,
): void {
  const trimmed = spec.trim();
  if (trimmed.includes("$")) {
    out.add(
      segments,
      `bind \`${spec}\``,
      "is interpolated, so where it points cannot be checked before deploy",
      spec,
    );
    return;
  }
  const colon = trimmed.indexOf(":");
  // No source: an anonymous volume.
  if (colon === -1) return;
  const source = trimmed.slice(0, colon);
  const isPath = source.startsWith("/") || source.startsWith(".") ||
    source.startsWith("~") || source.includes("\\");
  // Anything else is a named volume (Compose refuses a named volume with `/`).
  if (!isPath) return;
  const reason = outsideReason(source);
  if (reason) out.add(segments, `bind source \`${source}\``, reason, spec);
}

function checkLongVolume(
  out: Collector,
  segments: Array<string | number>,
  spec: Record<string, unknown>,
): void {
  const type = typeof spec.type === "string" ? spec.type : "volume";
  if (type === "bind") {
    out.path([...segments, "source"], "bind source", spec.source);
    return;
  }
  if (!SAFE_MOUNT_TYPES.has(type)) {
    out.add(
      [...segments, "type"],
      `mount type \`${type}\``,
      "reaches the host outside a named volume",
      spec,
    );
  }
}

function checkServiceVolumes(
  out: Collector,
  serviceSegments: string[],
  volumes: unknown,
): void {
  if (!Array.isArray(volumes)) return;
  volumes.forEach((spec, index) => {
    const segments = [...serviceSegments, "volumes", index];
    if (typeof spec === "string") checkShortVolume(out, segments, spec);
    else if (isRecord(spec)) checkLongVolume(out, segments, spec);
    else out.add(segments, "volume", "is not a volume Compose accepts", spec);
  });
}

/** `env_file` / `label_file`: a string, or a list of strings / `{ path }`. */
function checkFileList(
  out: Collector,
  segments: Array<string | number>,
  what: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    out.path(segments, what, value);
    return;
  }
  value.forEach((entry, index) => {
    const at = [...segments, index];
    if (isRecord(entry)) out.path([...at, "path"], what, entry.path);
    else out.path(at, what, entry);
  });
}

function checkBuild(
  out: Collector,
  serviceSegments: string[],
  build: unknown,
): void {
  const at = [...serviceSegments, "build"];
  if (build === undefined || build === null) return;
  if (typeof build === "string") {
    if (!isRemoteContext(build)) out.path(at, "build context", build);
    return;
  }
  if (!isRecord(build)) return;
  const context = build.context;
  if (typeof context === "string" && !isRemoteContext(context)) {
    out.path([...at, "context"], "build context", context);
  } else if (context !== undefined && typeof context !== "string") {
    out.path([...at, "context"], "build context", context);
  }
  if (build.dockerfile !== undefined) {
    out.path([...at, "dockerfile"], "Dockerfile", build.dockerfile);
  }
  if (isRecord(build.additional_contexts)) {
    for (const [name, value] of Object.entries(build.additional_contexts)) {
      if (
        typeof value === "string" &&
        (isRemoteContext(value) || value.startsWith("docker-image://") ||
          value.startsWith("service:"))
      ) continue;
      out.path(
        [...at, "additional_contexts", name],
        "additional build context",
        value,
      );
    }
  } else if (Array.isArray(build.additional_contexts)) {
    out.add(
      [...at, "additional_contexts"],
      "additional build contexts",
      "are a list, so the paths they name cannot be checked",
      build.additional_contexts,
    );
  }
  if (build.ssh !== undefined) {
    out.add(
      [...at, "ssh"],
      "build ssh",
      "forwards the host's SSH agent or keys into the build",
      build.ssh,
    );
  }
  if (build.network === "host") {
    out.add([...at, "network"], "build network `host`", "shares the host's network stack", build.network);
  }
  if (build.privileged === true) {
    out.add([...at, "privileged"], "privileged build", "runs with full host privileges", build.privileged);
  }
  if (build.entitlements !== undefined) {
    out.add(
      [...at, "entitlements"],
      "build entitlements",
      "grant the build host-level privileges",
      build.entitlements,
    );
  }
}

function checkExtends(
  out: Collector,
  serviceSegments: string[],
  value: unknown,
): void {
  if (isRecord(value) && value.file !== undefined) {
    out.path([...serviceSegments, "extends", "file"], "extends file", value.file);
  }
}

function checkTopLevelVolumes(out: Collector, volumes: unknown): void {
  if (!isRecord(volumes)) return;
  for (const [name, entry] of Object.entries(volumes)) {
    if (!isRecord(entry) || !isRecord(entry.driver_opts)) continue;
    const opts = entry.driver_opts;
    const at = ["volumes", name, "driver_opts"];
    const type = typeof opts.type === "string" ? opts.type.trim() : undefined;
    const o = typeof opts.o === "string" ? opts.o : "";
    const mountFlags = o.split(",").map((flag) => flag.trim());
    const bindFlag = mountFlags.includes("bind") || mountFlags.includes("rbind");
    const device = opts.device;
    if (bindFlag || type === "none" || type === "bind") {
      out.add(
        at,
        `volume \`${name}\``,
        "is a bind mount of a host path in disguise",
        opts,
      );
      continue;
    }
    if (
      typeof device === "string" && device.trim().startsWith("/") &&
      (type === undefined || !NETWORK_FS_TYPES.has(type))
    ) {
      out.add(
        [...at, "device"],
        `volume \`${name}\` device \`${device}\``,
        "mounts a host path",
        opts,
      );
    }
  }
}

function checkFileBacked(
  out: Collector,
  kind: "configs" | "secrets",
  value: unknown,
): void {
  if (!isRecord(value)) return;
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry) && entry.file !== undefined) {
      out.path([kind, name, "file"], `${kind === "configs" ? "config" : "secret"} file`, entry.file);
    }
  }
}

function checkInclude(out: Collector, include: unknown): void {
  if (include === undefined || include === null) return;
  const entries = Array.isArray(include) ? include : [include];
  entries.forEach((entry, index) => {
    const at: Array<string | number> = ["include", index];
    if (typeof entry === "string") {
      out.path(at, "included file", entry);
      return;
    }
    if (!isRecord(entry)) {
      out.add(at, "include", "is not a path, so it cannot be checked", entry);
      return;
    }
    const paths = Array.isArray(entry.path) ? entry.path : [entry.path];
    paths.forEach((path, pathIndex) =>
      out.path(
        Array.isArray(entry.path) ? [...at, "path", pathIndex] : [...at, "path"],
        "included file",
        path,
      )
    );
    if (entry.project_directory !== undefined) {
      out.path([...at, "project_directory"], "include project directory", entry.project_directory);
    }
    checkFileList(out, [...at, "env_file"], "include env_file", entry.env_file);
  });
}

/**
 * Every value-level host reach in a (merged or single-layer) Compose data
 * tree. Tag sentinels (`!reset` / `!override`) are resolved first, so a value
 * hidden inside an `!override` is judged like any other.
 */
export function collectHostAccessFindings(data: unknown): HostAccessFinding[] {
  const out = new Collector();
  const root = resolveComposeTags(data);
  if (!isRecord(root)) return out.findings;

  if (isRecord(root.services)) {
    for (const [name, body] of Object.entries(root.services)) {
      if (!isRecord(body)) continue;
      const at = ["services", name];
      checkServiceVolumes(out, at, body.volumes);
      checkFileList(out, [...at, "env_file"], "env_file", body.env_file);
      checkFileList(out, [...at, "label_file"], "label_file", body.label_file);
      checkBuild(out, at, body.build);
      checkExtends(out, at, body.extends);
    }
  }
  checkTopLevelVolumes(out, root.volumes);
  checkFileBacked(out, "configs", root.configs);
  checkFileBacked(out, "secrets", root.secrets);
  checkInclude(out, root.include);
  return out.findings;
}

/**
 * Every host-level path in a document — gated keys and value-level reaches —
 * as the issue list a refusal carries.
 */
export function hostAccessIssues(
  data: unknown,
): Array<{ path: string; message: string }> {
  const root = resolveComposeTags(data);
  const issues: Array<{ path: string; message: string }> = [];
  if (isRecord(root) && isRecord(root.services)) {
    for (const [name, body] of Object.entries(root.services)) {
      if (!isRecord(body)) continue;
      for (const key of GATED_SERVICE_FIELD_KEYS) {
        if (key in body) {
          issues.push({
            path: `services.${name}.${key}`,
            message: `${key} grants root-equivalent access to the shared daemon host`,
          });
        }
      }
    }
  }
  for (const finding of collectHostAccessFindings(root)) {
    issues.push({ path: finding.path, message: finding.message });
  }
  return issues;
}

/**
 * Everything host-level in a document — the gated keys *and* the value-level
 * reaches — as one canonical, order-independent string. Two documents with
 * the same host-level content produce the same string whatever else differs,
 * so an approval recorded against it survives an unrelated edit and is voided
 * by any change to what reaches the host.
 */
export function hostAccessCanonical(data: unknown): string {
  const root = resolveComposeTags(data);
  const entries: Array<[string, unknown]> = [];
  if (isRecord(root) && isRecord(root.services)) {
    for (const [name, body] of Object.entries(root.services)) {
      if (!isRecord(body)) continue;
      for (const key of GATED_SERVICE_FIELD_KEYS) {
        if (key in body) entries.push([`services.${name}.${key}`, body[key]]);
      }
    }
  }
  for (const finding of collectHostAccessFindings(root)) {
    entries.push([finding.path, finding.value]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? "" : JSON.stringify(entries, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

/** SHA-256 hex of {@link hostAccessCanonical}, or `null` when nothing is host-level. */
export async function hostAccessFingerprint(
  data: unknown,
): Promise<string | null> {
  const canonical = hostAccessCanonical(data);
  if (canonical === "") return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
