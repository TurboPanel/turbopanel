/**
 * Resolve per-service `x-turbopanel.source` bindings into deploy
 * `sourceMaterial[]`.
 *
 * This is the instance half of the Git-backed release lane: it turns the
 * compose-declared repository binding into everything the daemon release engine
 * needs to check out, build, and promote a release — a secret-free clone
 * URL, the exact commit to build (with the subject and author the release
 * surface shows), a short-lived clone secret sealed to the target daemon
 * (`tpdaemon.…`), a `releaseId` (the on-host release directory name), and the
 * owning principal.
 *
 * **Release ids are deploy-scoped, not host-scoped.** Prepare runs once per
 * participating server, so the id comes from a {@link ReleaseIdAllocator} the
 * route creates before that fan-out — see its doc comment for why minting one
 * per host makes an environment release impossible to roll back.
 *
 * **Provider dispatch.** Which commit to build, and whether a secret is
 * minted for the clone, is the provider's answer — this module asks
 * {@link resolveGitProvider} rather than testing `row.provider` itself. That is
 * what keeps the two secret *lanes* below down to two:
 *
 * - **A minted secret** (GitHub installation token, GitLab OAuth access token):
 *   short-lived, sealed straight into the payload, never persisted.
 * - **No minted secret** (generic SSH, and a GitLab repository connected by deploy
 *   key): the repository's existing `secret.secret_envelope` is resealed for
 *   the daemon recipient.
 *
 * Either way the envelope is tagged with the auth shape the daemon must use:
 * `credentialKind: 'ssh_key'` for an `ssh://…` / `git@host:path` clone (the
 * daemon installs it as a temporary identity file), `'token'` for an HTTPS
 * clone (askpass). An HTTPS secret may additionally carry
 * `credentialUsername`, the basic-auth user the host must answer git's
 * `Username` prompt with — provider policy (GitLab's OAuth tokens authenticate
 * only as `oauth2`) expressed as opaque data, so this module and the daemon
 * both stay free of `if provider === …`. Neither ever lands in `cloneUrl` — the
 * wire parser rejects a URL carrying inline credentials on both sides.
 *
 * Preview mode resolves shape only: no provider round trip, no token minting,
 * no daemon sealing. A previewed entry carries the requested ref as its
 * `commitSha` placeholder so the operator still sees which services would
 * build, without spending a provider API call on every editor keystroke.
 */

import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { AppEnv } from "../../app.ts";
import type { Db } from "../../db.ts";
import {
  encryptSecretForDaemon,
  isDaemonSealedEnvelope,
  isSealedEnvelope,
  resealSecretForDaemon,
} from "../authn/data-encryption.ts";
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from "../../daemon/authn/server-identity-db.ts";
import {
  isGitProviderFailure,
  resolveGitProvider,
} from "../../lib/git/git-provider.ts";
import type { ResolvedSourceCommit } from "../../lib/git/git-provider.ts";
import { isSshCloneUrl } from "../../lib/git/clone-url.ts";
import { newCorrelationId } from "../../lib/commands/ids.ts";
import { definedFields } from "../../lib/optional-fields.ts";
import {
  type ComposeServiceSourceExtension,
  type NodePackageManager,
  readServiceTurbopanelExtension,
} from "../../lib/compose/index.ts";
import type {
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeploySource,
  EnvironmentDeploySourceBuild,
  EnvironmentDeploySourceCredentialKind,
  EnvironmentDeploySitePrincipal,
} from "../../lib/commands/schemas.ts";
import { secret, repository } from "../../lib/db/schema.ts";
import {
  loadPrincipalIdsByServiceIdForEnvironment,
  pickSolePrincipalId,
} from "../principals/tenancies.ts";

/** Prepare failures this stage can raise. Mirrors `DeployPrepareError` kinds. */
export type DeploySourcePrepareError =
  | { kind: "source_principal_ambiguous"; composeServiceName: string }
  | {
    kind: "source_ref_unresolved";
    composeServiceName: string;
    sourceId: string;
    ref: string;
    message: string;
  };

/**
 * "Serve release X of service Y again", instead of building whatever the
 * compose currently points at.
 *
 * `releaseByService` pins **every** Git-backed service in the environment,
 * not only the one being rolled back — the others to the release they are
 * already running. That is deliberate and load-bearing: `sourceMaterial[]` is
 * also what the daemon uses to decide which release trees are still in use
 * (`reclaimRemovedReleaseTrees`), which document root each site
 * site serves from, and what goes into `deployment.json`'s `releases[]`. A
 * payload carrying one entry would read on the host as "every other service
 * lost its repository" and reclaim their trees. Re-promoting a service onto the
 * release it already runs is an idempotent symlink swap with no build, so
 * pinning them costs nothing and keeps the payload a complete statement.
 *
 * A service with no succeeded release yet is simply absent — it has no tree on
 * the host to protect, and nothing to promote.
 */
export type DeployRollbackRequest = {
  /** The service the operator asked to roll back — used for messages only. */
  composeServiceName: string;
  /**
   * Compose service name → the already-published release it must end up on,
   * together with the commit metadata the control plane already recorded for
   * that release. Every entry is verified by the route before it reaches here.
   */
  releaseByService: Record<string, DeployRollbackReleasePin>;
};

/**
 * One pinned release in a rollback, with the commit it was built from.
 *
 * A rollback resolves no ref and clones nothing, so there is no commit to look
 * up — but the release row it writes must still name the *real* commit that is
 * about to go live, not the branch name. Carrying the recorded metadata forward
 * is what keeps `context.releases[]`, `deployment.json`, and the release list
 * from showing a rollback as "released `main`". The daemon independently reads
 * the same commit back out of the target release's own manifest, so the two
 * agree even for a release published before this metadata existed (where these
 * fields are simply absent and the branch placeholder remains the only answer
 * the control plane has).
 */
export type DeployRollbackReleasePin = {
  releaseId: string;
  /** Commit recorded for the pinned release; absent on pre-metadata releases. */
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
};

/**
 * One release id per compose service, shared by every server in a deploy.
 *
 * A deploy of one environment fans out to one `prepareDeployCompose()` call per
 * participating server, and each of those resolves `sourceMaterial[]`
 * independently. Minting the release id inside that per-host path would give
 * the *same* logical release a different id on every host: the release list
 * would show one row per server instead of one row per release, and a rollback
 * picking one of those ids would name a directory the other hosts never
 * published — failing in the daemon's `promoteExistingRelease()` missing-release
 * check halfway through the fan-out.
 *
 * So the id is allocated once, before the fan-out, and every server's prepare
 * reads the same value back. The allocator is keyed by compose service name
 * because that is what a release belongs to (`releases[].composeServiceName`);
 * a service scheduled onto three hosts publishes *one* release id onto all
 * three, which is exactly what makes an environment-wide rollback expressible.
 */
export type ReleaseIdAllocator = {
  /** Stable release id for one compose service, minted on first request. */
  allocate(composeServiceName: string): string;
};

/**
 * A fresh allocator for one deploy request. Create it in the route, before the
 * per-server prepare loop, and thread it through every `prepareDeployCompose()`
 * call in that fan-out — never one per server.
 */
export function createReleaseIdAllocator(): ReleaseIdAllocator {
  const byComposeServiceName = new Map<string, string>();
  return {
    allocate(composeServiceName: string): string {
      const existing = byComposeServiceName.get(composeServiceName);
      if (existing !== undefined) return existing;
      const allocated = newCorrelationId();
      byComposeServiceName.set(composeServiceName, allocated);
      return allocated;
    },
  };
}

export type DeploySourceResolveParams = {
  mode: "deploy" | "preview";
  organizationId: string;
  environmentId: string;
  serverId: string;
  /** Merged compose `services` mapping (pre-expansion). */
  services: Record<string, unknown>;
  serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>;
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[];
  /**
   * Webhook-supplied commit, when the trigger already knows the head SHA.
   *
   * `sourceId` names the single `repository` row the trigger fired for. The pinned
   * `commitSha` is applied to **that** binding only — every other binding in
   * the environment resolves from its own declared/default ref, because a push
   * to one repository says nothing about the others.
   */
  sourceSelection?: {
    ref: string | null;
    commitSha: string | null;
    sourceId?: string | null;
  };
  /**
   * Roll one service back to an already-published release instead of building.
   *
   * When set, this resolver produces exactly one entry — for that service, with
   * `rollbackToReleaseId` set — and performs **no** GitHub round trip, no token
   * minting, and no secret sealing: there is nothing to clone.
   */
  rollback?: DeployRollbackRequest;
  /**
   * Deploy-scoped release id allocator, shared by every server in the fan-out.
   *
   * Absent only on paths that resolve a single host in isolation (preview),
   * where a throwaway id is harmless. See {@link ReleaseIdAllocator}.
   */
  releaseIds?: ReleaseIdAllocator;
};

type SourceRow = {
  id: string;
  provider: string;
  repositoryUrl: string;
  defaultBranch: string | null;
  subdirectory: string | null;
  connectionId: string | null;
  secretId: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compose services carrying `x-turbopanel.source`, in stable key order. */
function collectSourceBindings(
  services: Record<string, unknown>,
): SourceBinding[] {
  const out: SourceBinding[] = [];
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw)) continue;
    const extension = readServiceTurbopanelExtension(raw);
    const binding = extension?.source;
    if (!binding) continue;
    out.push({
      composeServiceName: name,
      repository: binding,
      ...(extension.packageManager === undefined
        ? {}
        : { packageManager: extension.packageManager }),
    });
  }
  return out.sort((a, b) =>
    a.composeServiceName.localeCompare(b.composeServiceName)
  );
}

/**
 * Clone-URL and commit-metadata helpers moved to `src/lib/git/clone-url.ts`
 * when the second provider needed them too. Re-exported under their original
 * names: they are part of this module's tested surface, and every caller
 * already reaches for them here.
 */
export { isSshCloneUrl };
export {
  commitSubject,
  parseRepositoryOwnerRepo as parseGithubRepositoryPath,
} from "../../lib/git/clone-url.ts";

/**
 * Commit metadata the release surface renders, as resolved from the provider.
 * Defined with the provider interface in `src/lib/git/git-provider.ts` and
 * re-exported here for the readers that already import it from prepare.
 */
export type { ResolvedSourceCommit };

function toDeploySourcePrincipal(
  material: EnvironmentDeployPrincipalMaterial,
): EnvironmentDeploySitePrincipal {
  return {
    principalId: material.principalId,
    username: material.username,
    ...(material.uid === undefined ? {} : { uid: material.uid }),
    ...(material.gid === undefined ? {} : { gid: material.gid }),
  };
}

/**
 * Build plan for the release lane the binding selected.
 *
 * `x-turbopanel.source.buildKind` picks the backend and nothing else: `native`
 * (the default when omitted) is the checkout → build → promote directory
 * release, `railpack` is Railpack + BuildKit producing an OCI image. Every
 * other field flows through unchanged either way — Railpack's zero-config
 * detection is the default and the commands are advisory overrides it may or
 * may not honor, while `outputDirectory` simply has no meaning once the output
 * is an image (the daemon ignores it rather than failing, so switching modes
 * back and forth never strands a payload).
 *
 * `startCommand` rides along for the native runtime phase, which supervises a
 * `serviceKind: node` service from it (`nativeAppServices[]`). It is non-secret
 * and length-capped exactly like `buildCommand`, and services of every other
 * kind simply ignore it — the release engine itself never executes it.
 * `kind: 'static'` is still reserved for the site release phase.
 */
function resolveSourceBuild(
  binding: ComposeServiceSourceExtension,
  packageManager?: NodePackageManager,
): EnvironmentDeploySourceBuild {
  const build: EnvironmentDeploySourceBuild = {
    kind: binding.buildKind === "railpack" ? "railpack" : "native",
  };
  // The owning service's package-manager choice rides the build object so the
  // daemon can derive the right install command after checkout.
  if (packageManager) build.packageManager = packageManager;
  if (binding.buildCommand) build.buildCommand = binding.buildCommand;
  if (binding.startCommand) build.startCommand = binding.startCommand;
  if (binding.outputDirectory) build.outputDirectory = binding.outputDirectory;
  return build;
}

type DaemonRecipient = { serverId: string; keyId: string };

async function resolveDaemonRecipient(
  db: Db,
  serverId: string,
): Promise<DaemonRecipient | Response> {
  const daemonState = await getServerDaemonStateByServerId(db, serverId);
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return Response.json({
      error: "No encryption-capable daemon key on target server",
    }, { status: 422 });
  }
  return { serverId, keyId: daemonState.key.id };
}

/**
 * The selection's `commitSha`, but only for the repository that produced it.
 *
 * `undefined` for every other binding — including when the selection carries a
 * SHA with no `sourceId` (nothing identifies which repository it belongs to, so
 * nothing may be pinned to it).
 */
export function requestedCommitShaForSource(
  selection: DeploySourceResolveParams["sourceSelection"],
  sourceId: string,
): string | undefined {
  if (!selection?.commitSha) return undefined;
  if (!selection.sourceId || selection.sourceId !== sourceId) return undefined;
  return selection.commitSha;
}

/** One compose service and the `x-turbopanel.source` block bound to it. */
type SourceBinding = {
  composeServiceName: string;
  repository: ComposeServiceSourceExtension;
  /** The owning service's `x-turbopanel.packageManager`, when declared. */
  packageManager?: NodePackageManager;
};

/** Lookups every binding in one deploy resolves against, loaded once up front. */
type SourceResolutionContext = {
  sourceById: Map<string, SourceRow>;
  principalById: Map<string, EnvironmentDeployPrincipalMaterial>;
  principalIdsByServiceId: Awaited<
    ReturnType<typeof loadPrincipalIdsByServiceIdForEnvironment>
  >;
  serviceIdByComposeName: Map<string, string>;
  sealForDaemon: boolean;
  recipient?: DaemonRecipient;
};

/**
 * Nothing bound: a plain deploy simply has no Git-backed service, while a
 * rollback named one that carries no `x-turbopanel.source` to roll back.
 */
function noSourceBindingsResult(
  rollback: DeployRollbackRequest | undefined,
): EnvironmentDeploySource[] | DeploySourcePrepareError {
  if (!rollback) return [];
  return {
    kind: "source_ref_unresolved",
    composeServiceName: rollback.composeServiceName,
    sourceId: "",
    ref: "",
    message: "service has no x-turbopanel.source binding to roll back",
  };
}

/**
 * Ownership: identical lookup + sole-principal rule the site pin
 * uses; more than one tenancy is ambiguous ownership, not a guess.
 */
function resolveBindingPrincipal(
  composeServiceName: string,
  context: SourceResolutionContext,
): { material?: EnvironmentDeployPrincipalMaterial } | DeploySourcePrepareError {
  const serviceId = context.serviceIdByComposeName.get(composeServiceName);
  const assignedIds = serviceId
    ? (context.principalIdsByServiceId.get(serviceId) ?? [])
    : [];
  const sole = pickSolePrincipalId(assignedIds);
  if (sole.status === "ambiguous") {
    return { kind: "source_principal_ambiguous", composeServiceName };
  }
  if (sole.status !== "one") return {};
  return { material: context.principalById.get(sole.principalId) };
}

/**
 * Commit (and, off the rollback lane, the sealed clone secret) for one
 * binding.
 *
 * A rollback reuses what was recorded when the pinned release was first
 * published instead of re-resolving — there is nothing to resolve against, the
 * ref has moved on since. `ref` remains the fallback only for releases
 * published before commit metadata was recorded.
 */
function resolveBindingCommit(
  c: Context<AppEnv>,
  db: Db,
  args: {
    composeServiceName: string;
    row: SourceRow;
    ref: string;
    context: SourceResolutionContext;
    rollbackPin: DeployRollbackReleasePin | undefined;
    pinnedCommitSha: string | undefined;
  },
): Promise<Awaited<ReturnType<typeof resolveSourceCommitAndCredential>>> {
  const { rollbackPin } = args;
  if (rollbackPin) {
    return Promise.resolve(definedFields({
      commitSha: rollbackPin.commitSha ?? args.ref,
      commitMessage: rollbackPin.commitMessage,
      commitAuthor: rollbackPin.commitAuthor,
    }));
  }
  return resolveSourceCommitAndCredential(c, db, definedFields({
    composeServiceName: args.composeServiceName,
    row: args.row,
    ref: args.ref,
    sealForDaemon: args.context.sealForDaemon,
    recipient: args.context.recipient,
    requestedCommitSha: args.pinnedCommitSha,
  }));
}

/** One binding → one wire entry, or the reason it cannot be resolved. */
async function resolveBindingMaterial(
  c: Context<AppEnv>,
  db: Db,
  params: DeploySourceResolveParams,
  context: SourceResolutionContext,
  binding: SourceBinding,
): Promise<EnvironmentDeploySource | DeploySourcePrepareError | Response> {
  const composeServiceName = binding.composeServiceName;
  const row = context.sourceById.get(binding.repository.sourceId);
  if (!row) {
    return {
      kind: "source_ref_unresolved",
      composeServiceName,
      sourceId: binding.repository.sourceId,
      ref: binding.repository.branch ?? "",
      message: "repository not found in this organization",
    };
  }

  const ref = binding.repository.branch ?? row.defaultBranch ?? null;
  if (!ref) {
    return {
      kind: "source_ref_unresolved",
      composeServiceName,
      sourceId: row.id,
      ref: "",
      message: "no branch on the compose binding and no repository default branch",
    };
  }

  const owner = resolveBindingPrincipal(composeServiceName, context);
  if ("kind" in owner) return owner;

  // Rollback: the release tree already exists on the host, so there is no
  // commit to resolve and no secret to mint. `ref` still travels because
  // the wire contract requires it and the daemon ignores it on this branch;
  // `commitSha` carries the metadata the pinned release recorded, so the row
  // this deploy writes names the commit going live rather than a branch name.
  // See `EnvironmentDeploySource.rollbackToReleaseId`.
  const rollbackPin = params.rollback?.releaseByService[composeServiceName];
  const resolved = await resolveBindingCommit(c, db, {
    composeServiceName,
    row,
    ref,
    context,
    rollbackPin,
    // The webhook path resolves one push event into one `DeploySourceSelection`.
    // Only the binding that names *that* repository may be pinned to its SHA —
    // forwarding it to every binding would deploy the triggering commit into
    // unrelated repositories (or fail the whole deploy on a SHA they do not
    // contain).
    pinnedCommitSha: requestedCommitShaForSource(params.sourceSelection, row.id),
  });
  if (resolved instanceof Response) return resolved;
  if ("kind" in resolved) return resolved;

  const rollbackReleaseId = rollbackPin?.releaseId;
  return definedFields({
    sourceId: row.id,
    composeServiceName,
    // The row's provider travels verbatim: the wire parser bounds it to the
    // same set the `source_provider_check` constraint does, so narrowing it
    // here would only be able to *lose* information.
    provider: row.provider as EnvironmentDeploySource["provider"],
    cloneUrl: row.repositoryUrl,
    ref,
    commitSha: resolved.commitSha,
    commitMessage: resolved.commitMessage,
    commitAuthor: resolved.commitAuthor,
    // One release id per service per deploy: a deploy may promote a release
    // for only some of its services, so `deployment.generation` is not it.
    // It is allocated *once for the whole fan-out* (see
    // {@link ReleaseIdAllocator}) so a service scheduled onto several servers
    // publishes one release the operator can roll back environment-wide,
    // rather than one indistinguishable release per host.
    // A rollback allocates none — it re-lives the release it pins, so both
    // ids are that release and the host addresses the tree that exists.
    releaseId: rollbackReleaseId ??
      params.releaseIds?.allocate(composeServiceName) ??
      newCorrelationId(),
    rollbackToReleaseId: rollbackReleaseId,
    build: resolveSourceBuild(binding.repository, binding.packageManager),
    subdirectory: binding.repository.subdirectory ?? row.subdirectory ?? undefined,
    credential: resolved.credential,
    credentialKind: resolved.credentialKind,
    credentialUsername: resolved.credentialUsername,
    principal: owner.material
      ? toDeploySourcePrincipal(owner.material)
      : undefined,
  });
}

/** Load every lookup the per-binding pass needs, in one round of queries. */
async function loadSourceResolutionContext(
  db: Db,
  params: DeploySourceResolveParams,
  bindings: readonly SourceBinding[],
): Promise<SourceResolutionContext | Response> {
  const sourceIds = [...new Set(bindings.map((b) => b.repository.sourceId))];
  const sourceRows = await db
    .select({
      id: repository.id,
      provider: repository.provider,
      repositoryUrl: repository.repositoryUrl,
      defaultBranch: repository.defaultBranch,
      subdirectory: repository.subdirectory,
      connectionId: repository.connectionId,
      secretId: repository.secretId,
    })
    .from(repository)
    .where(
      and(
        eq(repository.organizationId, params.organizationId),
        inArray(repository.id, sourceIds),
      ),
    );

  const serviceIdByComposeName = new Map<string, string>();
  for (const row of params.serviceRows) {
    serviceIdByComposeName.set(row.composeServiceName, row.id);
  }

  // A rollback clones nothing, so it seals nothing — and must not fail on a
  // server whose daemon key is momentarily unusable when no secret is
  // going to travel anyway.
  const sealForDaemon = params.mode === "deploy" && params.rollback === undefined;
  const recipient = sealForDaemon
    ? await resolveDaemonRecipient(db, params.serverId)
    : undefined;
  if (recipient instanceof Response) return recipient;

  return definedFields({
    sourceById: new Map<string, SourceRow>(
      sourceRows.map((row) => [row.id, row satisfies SourceRow]),
    ),
    principalById: new Map(
      params.principalMaterial.map((entry) => [entry.principalId, entry]),
    ),
    principalIdsByServiceId: await loadPrincipalIdsByServiceIdForEnvironment(
      db,
      params.environmentId,
    ),
    serviceIdByComposeName,
    sealForDaemon,
    recipient,
  });
}

export async function resolveDeploySourceMaterial(
  c: Context<AppEnv>,
  db: Db,
  params: DeploySourceResolveParams,
): Promise<EnvironmentDeploySource[] | DeploySourcePrepareError | Response> {
  const allBindings = collectSourceBindings(params.services);
  const rollback = params.rollback;
  // A rollback promotes releases that already exist, so only services the
  // caller pinned participate — see `DeployRollbackRequest` for why that set is
  // every Git-backed service with a release, not just the one being undone.
  const bindings = rollback
    ? allBindings.filter((binding) =>
      binding.composeServiceName in rollback.releaseByService
    )
    : allBindings;
  if (bindings.length === 0) return noSourceBindingsResult(rollback);

  const context = await loadSourceResolutionContext(db, params, bindings);
  if (context instanceof Response) return context;

  const out: EnvironmentDeploySource[] = [];
  for (const binding of bindings) {
    const entry = await resolveBindingMaterial(c, db, params, context, binding);
    if (entry instanceof Response) return entry;
    if ("kind" in entry) return entry;
    out.push(entry);
  }
  return out;
}

type CommitAndCredentialParams = {
  composeServiceName: string;
  row: SourceRow;
  ref: string;
  sealForDaemon: boolean;
  recipient?: DaemonRecipient;
  requestedCommitSha?: string;
};

/**
 * Resolve the commit to build and the sealed clone secret for one repository.
 *
 * The provider answers the first half and *may* answer the second: a hosted
 * provider mints a short-lived token, which is sealed to the target daemon
 * here; a deploy-key repository mints nothing, and its stored `secret` row is
 * resealed instead. Those are the only two lanes, and which one a repository takes
 * is settled at write time by `assertProviderAuthShape`, not guessed here.
 *
 * Generic SSH (and a GitLab deploy-key repository) has no remote SHA resolution
 * yet — the ref passes through as `commitSha` and the daemon resolves it on
 * clone. A follow-up phase adds `git ls-remote` resolution so the control plane
 * pins the exact commit for those too.
 */
async function resolveSourceCommitAndCredential(
  c: Context<AppEnv>,
  db: Db,
  params: CommitAndCredentialParams,
): Promise<
  | (ResolvedSourceCommit & {
    credential?: string;
    credentialKind?: EnvironmentDeploySourceCredentialKind;
    credentialUsername?: string;
  })
  | DeploySourcePrepareError
  | Response
> {
  const { row, ref } = params;
  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  const secretsConfig = c.get("secretsConfig");

  const prepared = await resolveGitProvider(row.provider).prepareClone(
    { db, dataEncryptionSecrets },
    {
      row,
      ref,
      needsCredential: params.sealForDaemon,
      ...(params.requestedCommitSha === undefined
        ? {}
        : { requestedCommitSha: params.requestedCommitSha }),
    },
  );
  if (isGitProviderFailure(prepared)) {
    // A provider-side refusal names the binding that could not be resolved, so
    // the operator sees which service is stuck rather than a bare 500.
    return {
      kind: "source_ref_unresolved",
      composeServiceName: params.composeServiceName,
      sourceId: row.id,
      ref,
      message: prepared.failure,
    };
  }

  const commit = prepared.commit;
  // Preview resolves shape only: nothing is sealed, so nothing needs a
  // recipient or an encryption key.
  if (!params.sealForDaemon) return commit;

  // Lane 1 — the provider minted a secret for this one clone. Seal it
  // straight into the payload; it is never written anywhere.
  if (prepared.minted) {
    if (!secretsConfig || !params.recipient) {
      return Response.json({
        error: "Encryption unavailable — no encryption key configured",
      }, { status: 503 });
    }
    return {
      ...commit,
      credentialKind: prepared.minted.kind,
      // The provider owns the username half of an HTTPS secret (GitLab's
      // OAuth tokens authenticate only as `oauth2`); it rides the payload as
      // data so nothing downstream has to know which provider minted this.
      ...(prepared.minted.username === undefined
        ? {}
        : { credentialUsername: prepared.minted.username }),
      credential: await encryptSecretForDaemon(
        secretsConfig,
        params.recipient,
        prepared.minted.secret,
      ),
    };
  }

  // Lane 2 — the repository clones with the deploy key it already points at.
  // A repository with no secret at all clones anonymously (a public
  // repository), which is a valid, if unusual, configuration.
  if (!row.secretId) return commit;
  if (!dataEncryptionSecrets || !secretsConfig || !params.recipient) {
    return Response.json({
      error: "Encryption unavailable — no encryption key configured",
    }, { status: 503 });
  }
  const [credentialRow] = await db
    .select({ secretEnvelope: secret.secretEnvelope })
    .from(secret)
    .where(eq(secret.id, row.secretId))
    .limit(1);
  if (!credentialRow) return commit;
  // An SSH clone URL means the stored secret is a deploy key, and the
  // daemon has to install it as an identity file — `GIT_ASKPASS` answers
  // password prompts, never publickey auth. Say so on the wire rather than
  // leaving the daemon to guess from the URL.
  const credentialKind: EnvironmentDeploySourceCredentialKind =
    isSshCloneUrl(row.repositoryUrl) ? "ssh_key" : "token";
  const envelope = credentialRow.secretEnvelope;
  if (isDaemonSealedEnvelope(envelope)) {
    return { ...commit, credential: envelope, credentialKind };
  }
  if (!isSealedEnvelope(envelope)) {
    return {
      ...commit,
      credentialKind,
      credential: await encryptSecretForDaemon(
        secretsConfig,
        params.recipient,
        envelope,
      ),
    };
  }
  return {
    ...commit,
    credentialKind,
    credential: await resealSecretForDaemon(
      secretsConfig,
      dataEncryptionSecrets,
      params.recipient,
      envelope,
    ),
  };
}
