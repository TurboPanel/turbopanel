import type { Hono } from "hono";
import { dirname, fromFileUrl, join } from "@std/path";
import { DAEMON_API_PREFIX } from "../surfaces.ts";

/**
 * Informational daemon checkout commit for the co-located daemon repo on this host.
 *
 * This is the HEAD of the daemon repository checkout that lives alongside the
 * instance (`../turbopaneld`, override with `TURBOPANEL_DAEMON_REPO`). The REST
 * endpoint and brief cache support operator upgrades and dev-sync — connected
 * daemons do not auto-sync or self-update from this value.
 *
 * Deno-only: it shells out to `git` and reads the daemon working tree, so it is
 * registered from `deno-dev.ts` rather than the shared `createApp()` used by
 * Workers or the production `deno.ts` compile entry.
 */

const TURBOPANEL_ROOT = (() => {
  // This module lives at <root>/src/daemon/version.ts.
  const here = dirname(fromFileUrl(import.meta.url));
  return join(here, "..", "..");
})();

export function getDaemonRepoPath(): string {
  const override = Deno.env.get("TURBOPANEL_DAEMON_REPO")?.trim();
  if (override) return override;
  return join(TURBOPANEL_ROOT, "..", "turbopaneld");
}

export interface DaemonVersion {
  commit: string;
  branch: string;
}

const TTL_MS = 5_000;
let cache: { value: DaemonVersion; at: number } | null = null;

async function gitOutput(repo: string, args: string[]): Promise<string | null> {
  try {
    const command = new Deno.Command("git", {
      args: ["-C", repo, ...args],
      stdout: "piped",
      stderr: "null",
    });
    const { success, stdout } = await command.output();
    if (!success) return null;
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return null;
  }
}

/**
 * Read the daemon checkout's commit + branch.
 *
 * Cached briefly so the WS push interval and the REST endpoint don't fork `git`
 * on every call. Pass `force` to bypass the cache (used by the change watcher).
 */
export async function getDaemonCommit(force = false): Promise<DaemonVersion> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.value;

  const repo = getDaemonRepoPath();
  const commit = (await gitOutput(repo, ["rev-parse", "HEAD"])) ?? "unknown";
  const branch =
    (await gitOutput(repo, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "unknown";

  const value: DaemonVersion = { commit, branch };
  cache = { value, at: now };
  return value;
}

/** Read the instance repo's own HEAD (not cached). */
export async function getInstanceCommit(): Promise<DaemonVersion> {
  const commit = (await gitOutput(TURBOPANEL_ROOT, ["rev-parse", "HEAD"])) ??
    "unknown";
  const branch =
    (await gitOutput(TURBOPANEL_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
      "unknown";
  return { commit, branch };
}

export function registerVersionRoute(app: Hono): Hono {
  app.get(
    `${DAEMON_API_PREFIX}/version`,
    async (c) => c.json(await getDaemonCommit()),
  );
  return app;
}
