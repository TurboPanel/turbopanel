/**
 * Secrets-free resolution of the per-service **release trees**
 * (`<principalHome>/sites/<serviceId>`) an environment owns on its host.
 *
 * Generic on purpose: the tree is where the Git release engine publishes
 * (`releases/`, `current`, `shared/`) and where the native-runtime phase will
 * run from — it is not a site artifact. `environment.stop` is the
 * only command that reclaims it, and by the time the daemon runs the stop the
 * rows naming it may already be gone, so this is captured up front (the same
 * "capture everything stop needs while the rows still exist" rule
 * `teardown.ts` follows for hostings and compose segments).
 *
 * Shared by the explicit stop route (`deploy-routes.ts`) and delete teardown
 * (`teardown.ts`) so both reclaim the same set.
 *
 * **Two sources, unioned.** The current merged compose only describes services
 * that still declare `x-turbopanel.source`, so a service removed from the
 * compose (or one that simply lost its source binding) drops out of it
 * immediately — and its `<principalHome>/sites/<serviceId>` tree would never be
 * named by a later stop or delete. `deployment.options.siteReleases` is the
 * durable counterpart: each deploy records the trees it published for that
 * `(environment, server)`, and that record outlives the compose edit. A redeploy
 * reclaims removed trees on the host itself (the daemon diffs `deployment.json`
 * `releases[]` against the payload's `sourceMaterial[]`), so what this union adds
 * is the case with no redeploy in between: edit the compose, then stop or delete.
 */

import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db.ts";
import {
  deployment,
  environment,
  hosting,
  principal,
  project,
  service,
} from "../../lib/db/schema.ts";
import { readServiceSourceExtension } from "../../lib/compose/index.ts";
import { mergeProjectEnvironmentCompose } from "./deploy-prepare.ts";
import {
  loadPrincipalIdsByServiceIdForEnvironment,
  pickSolePrincipalId,
} from "../principals/tenancies.ts";

/** One release tree to reclaim: `<principalHomeRoot>/<username>/sites/<serviceId>`. */
export type EnvironmentSiteRelease = {
  serviceId: string;
  username: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compose service keys carrying `x-turbopanel.source`. */
function collectSourceComposeServiceNames(
  data: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();
  const services = data.services;
  if (!isPlainObject(services)) return names;
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw)) continue;
    if (!readServiceSourceExtension(raw)) continue;
    names.add(name);
  }
  return names;
}

/**
 * Release-tree directory segment for one service.
 *
 * Mirrors the daemon's `resolveReleaseServiceId`: the service UUID when a row
 * carries it on the wire (`hostings[]` / `ingressServices[]`, both of which are
 * built from `hosting` rows), else the compose service key — unique within the
 * environment and charset-safe, which is all the path segment needs.
 */
function releaseServiceIdFor(
  serviceId: string,
  composeServiceName: string,
  serviceIdsWithHosting: ReadonlySet<string>,
): string {
  return serviceIdsWithHosting.has(serviceId) ? serviceId : composeServiceName;
}

/**
 * Release trees the environment's **current** compose declares, one per service
 * that declares a source **and** has a single tenancy principal to publish
 * under.
 *
 * A service with no sole tenancy never got a release published (the daemon skips
 * those entries rather than guessing an owner), so there is nothing to reclaim.
 * Returns `[]` for an environment with no Git-backed services.
 *
 * This is what a deploy **records** into `deployment.options.siteReleases`;
 * reclaim reads the union (see {@link resolveEnvironmentSiteReleases}). Keeping
 * the recorded side current-only is what bounds it: once a removed service's
 * tree has actually been reclaimed by the next deploy, the next record no longer
 * names it.
 */
export async function resolveSourcedEnvironmentSiteReleases(
  db: Db,
  environmentId: string,
): Promise<EnvironmentSiteRelease[]> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      options: environment.options,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1);
  if (!envRow) return [];

  const [projectRow] = await db
    .select({ id: project.id, options: project.options })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1);
  if (!projectRow) return [];

  const merged = mergeProjectEnvironmentCompose(
    projectRow.options,
    envRow.options,
  );
  if (merged instanceof Response) return [];

  const sourceComposeNames = collectSourceComposeServiceNames(merged.data);
  if (sourceComposeNames.size === 0) return [];

  const serviceRows = await db
    .select({ id: service.id, composeServiceName: service.composeServiceName })
    .from(service)
    .where(eq(service.environmentId, environmentId));
  const matched = serviceRows.filter((row) =>
    sourceComposeNames.has(row.composeServiceName)
  );
  if (matched.length === 0) return [];

  const hostingRows = await db
    .select({ serviceId: hosting.serviceId })
    .from(hosting)
    .innerJoin(service, eq(hosting.serviceId, service.id))
    .where(eq(service.environmentId, environmentId));
  const serviceIdsWithHosting = new Set(
    hostingRows.map((row) => row.serviceId),
  );

  const principalIdsByServiceId =
    await loadPrincipalIdsByServiceIdForEnvironment(db, environmentId);
  const wanted = new Map<string, string>();
  for (const row of matched) {
    const sole = pickSolePrincipalId(principalIdsByServiceId.get(row.id) ?? []);
    if (sole.status !== "one") continue;
    wanted.set(row.id, sole.principalId);
  }
  if (wanted.size === 0) return [];

  const principalRows = await db
    .select({ id: principal.id, username: principal.username })
    .from(principal)
    .where(inArray(principal.id, [...new Set(wanted.values())]));
  const usernameById = new Map(
    principalRows.map((row) => [row.id, row.username]),
  );

  const out: EnvironmentSiteRelease[] = [];
  for (const row of matched) {
    const principalId = wanted.get(row.id);
    if (!principalId) continue;
    const username = usernameById.get(principalId);
    if (!username) continue;
    out.push({
      serviceId: releaseServiceIdFor(
        row.id,
        row.composeServiceName,
        serviceIdsWithHosting,
      ),
      username,
    });
  }
  return sortSiteReleases(out);
}

function sortSiteReleases(
  entries: EnvironmentSiteRelease[],
): EnvironmentSiteRelease[] {
  return entries.sort(
    (a, b) =>
      a.serviceId.localeCompare(b.serviceId) ||
      a.username.localeCompare(b.username),
  );
}

/** Same charset the daemon's `environment.stop` parser accepts before any path join. */
const SITE_RELEASE_SERVICE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;
const SITE_RELEASE_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,27}$/;

function parseRecordedSiteRelease(
  value: unknown,
): EnvironmentSiteRelease | null {
  if (!isPlainObject(value)) return null;
  const { serviceId, username } = value;
  if (
    typeof serviceId !== "string" || !SITE_RELEASE_SERVICE_ID_RE.test(serviceId)
  ) return null;
  if (
    typeof username !== "string" || !SITE_RELEASE_USERNAME_RE.test(username)
  ) return null;
  return { serviceId, username };
}

/**
 * Trees recorded by the deploys that actually published them.
 *
 * Read across every `deployment` row for the environment: a spanning deploy
 * writes one row per server, and reclaim is best-effort per entry anyway (a
 * `rm -rf` of a path that never existed on that host is a no-op), so naming a
 * tree on one server too many is cheaper than missing one.
 */
async function readRecordedEnvironmentSiteReleases(
  db: Db,
  environmentId: string,
): Promise<EnvironmentSiteRelease[]> {
  const rows = await db
    .select({ options: deployment.options })
    .from(deployment)
    .where(eq(deployment.environmentId, environmentId));

  const out: EnvironmentSiteRelease[] = [];
  for (const row of rows) {
    if (!isPlainObject(row.options)) continue;
    const recorded = row.options.siteReleases;
    if (!Array.isArray(recorded)) continue;
    for (const entry of recorded) {
      const parsed = parseRecordedSiteRelease(entry);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/**
 * Every release tree this environment may still own on its hosts: the ones its
 * current compose declares, plus the ones its last deploys recorded.
 *
 * The union is what `environment.stop` gets. Duplicates are collapsed, and the
 * daemon ignores a tree that is already gone, so an entry that has since been
 * reclaimed on the host costs one no-op `rm -rf`.
 */
export async function resolveEnvironmentSiteReleases(
  db: Db,
  environmentId: string,
): Promise<EnvironmentSiteRelease[]> {
  const sourced = await resolveSourcedEnvironmentSiteReleases(
    db,
    environmentId,
  );
  const recorded = await readRecordedEnvironmentSiteReleases(db, environmentId);

  const byKey = new Map<string, EnvironmentSiteRelease>();
  for (const entry of [...sourced, ...recorded]) {
    byKey.set(`${entry.username}\u0000${entry.serviceId}`, entry);
  }
  return sortSiteReleases([...byKey.values()]);
}
