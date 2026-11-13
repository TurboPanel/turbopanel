import type { ApplyVariablesResult } from './apply-variables.ts'

/**
 * One variable of one service as a person set it, for the deploy preview.
 * `name` is what the process or the build sees (`NODE_OPTIONS`), never the
 * service-prefixed key the compose file reads from the generated `.env`.
 */
export type ServiceVariableView = {
  name: string
  /** A variable scope, `binding`, or `unknown`. */
  source: string
  isSecret: boolean
  /** `null` for a secret: its value is never shown. */
  value: string | null
  forBuild: boolean
  forRuntime: boolean
}

/** Every variable one compose service uses while building or running. */
export type ServiceVariablesView = {
  composeServiceName: string
  variables: ServiceVariableView[]
}

type Draft = ServiceVariableView & { key: string }

function merge(drafts: Map<string, Draft>, next: Draft): void {
  const existing = drafts.get(next.key) ?? [...drafts.values()].find((d) => d.name === next.name)
  if (!existing) {
    drafts.set(next.key, next)
    return
  }
  existing.forBuild = existing.forBuild || next.forBuild
  existing.forRuntime = existing.forRuntime || next.forRuntime
}

/**
 * The per-service variable lists the preview shows, split by when each is used.
 * Runtime comes from the environment the service ends up with, build from the
 * non-secret build variables, and a build-only secret from the secret plan. A
 * variable used in both places is one entry with both flags set.
 */
export function buildServiceVariablesViews(
  applied: Pick<ApplyVariablesResult, 'runtimeAssignments' | 'buildAssignments' | 'secretPlan'>
): ServiceVariablesView[] {
  const services = new Set<string>([
    ...applied.runtimeAssignments.keys(),
    ...applied.buildAssignments.keys(),
    ...applied.secretPlan.map((entry) => entry.composeServiceName),
  ])
  const views: ServiceVariablesView[] = []
  for (const composeServiceName of [...services].sort((a, b) => a.localeCompare(b))) {
    const drafts = new Map<string, Draft>()
    for (const row of applied.runtimeAssignments.get(composeServiceName) ?? []) {
      merge(drafts, {
        key: row.key,
        name: row.name,
        source: row.source ?? 'unknown',
        isSecret: row.isSecret,
        value: row.isSecret ? null : row.value,
        forBuild: false,
        forRuntime: true,
      })
    }
    for (const row of applied.buildAssignments.get(composeServiceName) ?? []) {
      merge(drafts, {
        key: row.key,
        name: row.name,
        source: row.source ?? 'unknown',
        isSecret: false,
        value: row.value,
        forBuild: true,
        forRuntime: false,
      })
    }
    for (const entry of applied.secretPlan) {
      if (entry.composeServiceName !== composeServiceName || !entry.forBuild) {
        continue
      }
      merge(drafts, {
        key: entry.key,
        name: entry.key,
        source: 'unknown',
        isSecret: true,
        value: null,
        forBuild: true,
        forRuntime: entry.forRuntime,
      })
    }
    const variables = [...drafts.values()]
      .map(({ key: _key, ...view }) => view)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (variables.length > 0) views.push({ composeServiceName, variables })
  }
  return views
}
