/**
 * Which branch each environment follows — the one rule a push webhook needs.
 *
 * A repository is attached to an environment by compose: a service carries
 * `x-turbopanel.source.sourceId` in the project document and/or the
 * environment's own document. The branch it builds is the merged document's
 * `source.branch`, else the repository's default branch (the exact precedence
 * deploy-prepare uses — `deploy-sources.ts` `resolveBindingMaterial`). Because
 * the environment document overlays the project's, one project can have
 * `staging` track `staging` and `production` track `main` with no change to
 * the repository itself.
 *
 * Host-free: no database, no Hono. The caller supplies the two stored
 * `options` blobs and the repository's default branch.
 */

import {
  type ComposeServiceSourceExtension,
  readServiceTurbopanelExtension,
} from '../compose/index.ts'
import { mergeComposeLayers } from '../compose/layers.ts'
import { isComposeChainError, resolveComposeLayerChain } from '../compose/layer-chain.ts'
import { isComposeTaggedValue } from '../compose/tags.ts'

/** One service in an environment that builds from the repository in question. */
export type EnvironmentBranchBinding = {
  composeServiceName: string
  /** Branch that service builds, or `null` when neither the binding nor the repository names one. */
  branch: string | null
  /** `false` when the binding opted out with `x-turbopanel.source.deployOnPush: false`. */
  deployOnPush: boolean
}

/** `refs/heads/main` and `main` are the same branch; anything else is not a branch. */
export function normalizeBranchName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const name = trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed
  if (name.length === 0 || name.startsWith('refs/')) return null
  return name
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapTagged(value: unknown): unknown {
  return isComposeTaggedValue(value) ? unwrapTagged(value.value) : value
}

function bindingFor(
  composeServiceName: string,
  source: ComposeServiceSourceExtension,
  repositoryDefaultBranch: string | null
): EnvironmentBranchBinding {
  return {
    composeServiceName,
    branch: normalizeBranchName(source.branch) ?? normalizeBranchName(repositoryDefaultBranch),
    deployOnPush: source.deployOnPush !== false,
  }
}

/**
 * Every binding to `sourceId` in the environment's effective compose
 * (project layers, then environment layers), in stable service order.
 *
 * An unparseable stored document yields no bindings — the same documents the
 * deploy path refuses with `invalid_compose` — so a broken environment is
 * skipped by the webhook rather than guessed at.
 */
export function environmentBranchBindings(params: {
  projectOptions: unknown
  environmentOptions: unknown
  sourceId: string
  repositoryDefaultBranch: string | null
}): EnvironmentBranchBinding[] {
  const layers = resolveComposeLayerChain({
    projectOptions: params.projectOptions,
    environmentOptions: params.environmentOptions,
    environmentFilename: 'docker-compose.environment.yml',
  })
  if (isComposeChainError(layers)) return []

  const services = unwrapTagged(mergeComposeLayers(layers).data.services)
  if (!isPlainObject(services)) return []

  const out: EnvironmentBranchBinding[] = []
  for (const [name, raw] of Object.entries(services)) {
    const service = unwrapTagged(raw)
    if (!isPlainObject(service)) continue
    const source = readServiceTurbopanelExtension(service)?.source
    if (source?.sourceId !== params.sourceId) continue
    out.push(bindingFor(name, source, params.repositoryDefaultBranch))
  }
  return out.sort((a, b) => a.composeServiceName.localeCompare(b.composeServiceName))
}

/** What a push to `branch` means for one environment. */
export type EnvironmentPushDecision = 'deploy' | 'push_deploys_off' | 'branch_not_tracked'

/**
 * Should a push to `pushedBranch` deploy this environment?
 *
 * `deploy` when at least one binding to the repository builds that branch and
 * allows push deploys. `push_deploys_off` when the branch matches but every
 * matching binding opted out (so a log line can say why nothing happened).
 * `branch_not_tracked` otherwise — including the case where no binding names a
 * branch at all: deploy-prepare refuses such a binding (`source_ref_unresolved`),
 * so there is nothing a push could correctly build.
 */
export function decideEnvironmentPush(
  bindings: readonly EnvironmentBranchBinding[],
  pushedBranch: string
): EnvironmentPushDecision {
  const pushed = normalizeBranchName(pushedBranch)
  if (pushed === null) return 'branch_not_tracked'
  const matching = bindings.filter((binding) => binding.branch === pushed)
  if (matching.length === 0) return 'branch_not_tracked'
  return matching.some((binding) => binding.deployOnPush) ? 'deploy' : 'push_deploys_off'
}

/** Distinct branches an environment follows for this repository (for display and logs). */
export function trackedBranches(bindings: readonly EnvironmentBranchBinding[]): string[] {
  const names = new Set<string>()
  for (const binding of bindings) {
    if (binding.branch !== null) names.add(binding.branch)
  }
  return [...names].sort()
}
