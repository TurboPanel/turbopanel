/**
 * Dev-only trunk update target + rebuild preparer backed by the local daemon
 * checkout, so the normal client update UI works against local builds.
 *
 * Registered from `deno-dev.ts` when the instance host has a daemon source
 * checkout. Two seams are installed:
 *
 * - `setTrunkManifestProvider`: "update available" compares each daemon's
 *   running commit against the local overlay catalog (`dist/manifest.json`)
 *   instead of the public CDN. When the checkout changed since the overlay was
 *   built (fingerprint drift), a pending pseudo-target is reported so every
 *   remote daemon shows an available update.
 * - `setServerUpdatePreparer`: triggering an update first rebuilds the overlay
 *   (`deno task release:dev`) when it is stale, then the queued envelopes are
 *   released. Daemons install from this checkout's `dist/` via their
 *   `TURBOPANEL_DL_BASE` (served by the dev Caddyfile).
 *
 * Deno-only: shells out to `git` and the `deno` binary and reads the daemon
 * working tree — never imported by `deno.ts` or the Workers build.
 */
import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { getDaemonRepoPath } from "../daemon/version.ts";
import {
  setTrunkManifestProvider,
  type TrunkManifestTarget,
} from "../lib/update/manifest.ts";
import { setServerUpdatePreparer } from "../lib/update/prepare.ts";
import { logError, logInfo, logWarn } from "../logger.ts";

const LOG_COMPONENT = "dev-update-overlay";

/** Fingerprints are cheap (a few git forks) but polled; cache briefly. */
const DEV_TARGET_CACHE_MS = 5_000;

/** Overlay rebuild ceiling: three `deno compile` targets + packaging. */
const REBUILD_TIMEOUT_MS = 600_000;

export type CommandOutput = {
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export type DevOverlayHooks = {
  repoPath?: () => string;
  runGit?: (repo: string, args: string[]) => Promise<CommandOutput>;
  readManifestText?: (repo: string) => Promise<string>;
  runRebuild?: (
    repo: string,
  ) => Promise<{ success: boolean; code: number; output: string }>;
  now?: () => Date;
};

function defaultRunGit(repo: string, args: string[]): Promise<CommandOutput> {
  return new Deno.Command("git", {
    args: ["-C", repo, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
}

function defaultReadManifestText(repo: string): Promise<string> {
  return Deno.readTextFile(join(repo, "dist", "manifest.json"));
}

function resolveDenoBinary(): string {
  const execPath = Deno.execPath();
  const base = execPath.split("/").at(-1) ?? "";
  // A compiled instance binary must not re-exec itself as "deno"; fall back to
  // PATH (vendored deno), where a missing run permission fails the rebuild
  // cleanly instead.
  return base === "deno" ? execPath : "deno";
}

async function defaultRunRebuild(
  repo: string,
): Promise<{ success: boolean; code: number; output: string }> {
  const result = await new Deno.Command(resolveDenoBinary(), {
    args: ["task", "release:dev"],
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(REBUILD_TIMEOUT_MS),
  }).output();
  const decoder = new TextDecoder();
  return {
    success: result.success,
    code: result.code,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

async function gitOutput(
  runGit: NonNullable<DevOverlayHooks["runGit"]>,
  repo: string,
  args: string[],
): Promise<string> {
  const result = await runGit(repo, args);
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout);
}

/**
 * Content fingerprint of the daemon checkout. Must match the daemon repo's
 * `scripts/source-fingerprint.ts`, which stamps the same value into
 * `dist/manifest.json` (`source`) at overlay build time — keep in sync.
 *
 * Clean tree → the full lowercase HEAD sha. Dirty tree →
 * `<head>+dirty.<12 hex>` over `git diff HEAD` plus untracked-file blob hashes.
 */
export async function computeDaemonSourceFingerprint(
  repo: string,
  runGit: NonNullable<DevOverlayHooks["runGit"]> = defaultRunGit,
): Promise<string> {
  const head = (await gitOutput(runGit, repo, ["rev-parse", "HEAD"])).trim()
    .toLowerCase();
  const diff = await gitOutput(runGit, repo, ["diff", "HEAD"]);
  const untrackedRaw = (await gitOutput(runGit, repo, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ])).trim();
  const untracked = untrackedRaw ? untrackedRaw.split("\n") : [];

  let untrackedSection = "";
  if (untracked.length > 0) {
    const hashes =
      (await gitOutput(runGit, repo, ["hash-object", "--", ...untracked]))
        .trim()
        .split("\n");
    untrackedSection = untracked
      .map((path, i) => `${path}:${hashes[i] ?? ""}`)
      .join("\n");
  }

  if (diff.trim() === "" && untrackedSection === "") {
    return head;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${diff}\0${untrackedSection}`),
  );
  const dirtyHash = encodeHex(new Uint8Array(digest)).slice(0, 12);
  return `${head}+dirty.${dirtyHash}`;
}

export type DevOverlayIdentity = {
  commit: string;
  buildId: string;
  builtAt: string;
  source?: string;
};

/** Read the overlay catalog identity; null when absent or malformed. */
export async function readDevOverlayIdentity(
  repo: string,
  readManifestText: NonNullable<DevOverlayHooks["readManifestText"]> =
    defaultReadManifestText,
): Promise<DevOverlayIdentity | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readManifestText(repo));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { commit, buildId, builtAt, source } = raw as Record<string, unknown>;
  if (
    typeof commit !== "string" || !commit ||
    typeof buildId !== "string" || !buildId ||
    typeof builtAt !== "string" || !builtAt
  ) {
    return null;
  }
  return {
    commit,
    buildId,
    builtAt,
    ...(typeof source === "string" && source ? { source } : {}),
  };
}

let cachedTarget:
  | { value: TrunkManifestTarget | null; expiresAt: number }
  | null = null;
let inflightTarget: Promise<TrunkManifestTarget | null> | null = null;

export function resetDevOverlayCacheForTests(): void {
  cachedTarget = null;
  inflightTarget = null;
}

async function resolveDevTrunkManifestUncached(
  hooks: DevOverlayHooks,
): Promise<TrunkManifestTarget | null> {
  const repo = (hooks.repoPath ?? getDaemonRepoPath)();
  const manifestUrl = join(repo, "dist", "manifest.json");
  try {
    const fingerprint = await computeDaemonSourceFingerprint(
      repo,
      hooks.runGit ?? defaultRunGit,
    );
    const identity = await readDevOverlayIdentity(
      repo,
      hooks.readManifestText ?? defaultReadManifestText,
    );
    if (identity?.source === fingerprint) {
      return {
        commit: identity.commit,
        buildId: identity.buildId,
        builtAt: identity.builtAt,
        channel: "trunk",
        manifestUrl,
      };
    }
    // Overlay stale or never built: report the checkout fingerprint itself as
    // the target commit. It differs from every daemon's stamped `<sha>+<unix>`
    // build identity, so "update available" lights up fleet-wide; triggering
    // the update rebuilds the overlay first (ensureDevOverlayCurrent).
    return {
      commit: fingerprint,
      buildId: `dev-${fingerprint.slice(0, 7)}+pending`,
      builtAt: (hooks.now ?? (() => new Date()))().toISOString(),
      channel: "trunk",
      manifestUrl,
    };
  } catch (err) {
    logWarn(
      LOG_COMPONENT,
      `could not resolve dev overlay target for ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** Trunk target from the local daemon checkout; briefly cached + coalesced. */
export function resolveDevTrunkManifest(
  hooks: DevOverlayHooks = {},
): Promise<TrunkManifestTarget | null> {
  const now = Date.now();
  if (cachedTarget && now < cachedTarget.expiresAt) {
    return Promise.resolve(cachedTarget.value);
  }
  if (inflightTarget) return inflightTarget;

  inflightTarget = resolveDevTrunkManifestUncached(hooks)
    .then((value) => {
      cachedTarget = { value, expiresAt: Date.now() + DEV_TARGET_CACHE_MS };
      return value;
    })
    .finally(() => {
      inflightTarget = null;
    });
  return inflightTarget;
}

let inflightRebuild: Promise<void> | null = null;

/**
 * Rebuild the dev overlay when the checkout changed since the last build.
 * Single-flight: concurrent update triggers share one build. Rejects when the
 * build fails, which callers surface as a failed update result.
 */
export function ensureDevOverlayCurrent(
  hooks: DevOverlayHooks = {},
): Promise<void> {
  if (inflightRebuild) return inflightRebuild;

  inflightRebuild = (async () => {
    const repo = (hooks.repoPath ?? getDaemonRepoPath)();
    const fingerprint = await computeDaemonSourceFingerprint(
      repo,
      hooks.runGit ?? defaultRunGit,
    );
    const identity = await readDevOverlayIdentity(
      repo,
      hooks.readManifestText ?? defaultReadManifestText,
    );
    if (identity?.source === fingerprint) return;

    logInfo(
      LOG_COMPONENT,
      `rebuilding daemon overlay for source ${fingerprint}`,
    );
    const result = await (hooks.runRebuild ?? defaultRunRebuild)(repo);
    // The next status poll must see the fresh catalog, not the pending target.
    cachedTarget = null;
    if (!result.success) {
      const tail = result.output.trim().split("\n").slice(-15).join("\n");
      logError(
        LOG_COMPONENT,
        `daemon overlay rebuild exited ${result.code}:\n${tail}`,
      );
      throw new Error(
        `daemon overlay rebuild failed (deno task release:dev exited ${result.code})`,
      );
    }
    logInfo(LOG_COMPONENT, "daemon overlay rebuilt");
  })().finally(() => {
    inflightRebuild = null;
  });
  return inflightRebuild;
}

/**
 * Install the dev overlay seams when this host has a daemon source checkout.
 * Without one (managed install) the trunk target stays on the public CDN.
 */
export function registerDevUpdateOverlay(): boolean {
  const repo = getDaemonRepoPath();
  try {
    Deno.statSync(join(repo, "main.ts"));
  } catch {
    logInfo(
      LOG_COMPONENT,
      `no daemon checkout at ${repo}; trunk updates stay on the public CDN`,
    );
    return false;
  }
  setTrunkManifestProvider(() => resolveDevTrunkManifest());
  setServerUpdatePreparer(() => ensureDevOverlayCurrent());
  logInfo(
    LOG_COMPONENT,
    `trunk updates resolve from the local daemon overlay at ${repo}`,
  );
  return true;
}
