import type { ApplyVariablesResult } from './apply-variables.ts'
import { isBuildEnvNameAllowed } from './build-env.ts'

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
  /**
   * Only present (and `true`) for a variable a source build never receives,
   * because the host refuses its name (`PATH`, `LD_*`, a name no shell can carry).
   */
  droppedFromBuild?: true
}

/** Every variable one compose service uses while building or running. */
export type ServiceVariablesView = {
  composeServiceName: string
  variables: ServiceVariableView[]
}

type Lane = Map<string, ServiceVariableView>

function lanesEqual(a: ServiceVariableView, b: ServiceVariableView): boolean {
  return a.isSecret === b.isSecret && a.value === b.value
}

/**
 * Combine the two lanes by the name the process or the build sees. One name
 * whose two lanes hold the same value is one entry with both flags; a name that
 * means something different in each lane stays two entries, one per lane.
 */
function combine(runtime: Lane, build: Lane): ServiceVariableView[] {
  const out: ServiceVariableView[] = []
  for (const [name, run] of runtime) {
    const built = build.get(name)
    if (built && lanesEqual(run, built)) {
      out.push({
        ...run,
        forBuild: true,
        ...(built.droppedFromBuild ? { droppedFromBuild: true } : {}),
      })
    } else {
      out.push(run)
    }
  }
  for (const [name, built] of build) {
    const run = runtime.get(name)
    if (run && lanesEqual(run, built)) continue
    out.push(built)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || Number(a.forBuild) - Number(b.forBuild))
}

function runtimeLane(
  applied: Pick<ApplyVariablesResult, 'runtimeAssignments'>,
  service: string
): Lane {
  const lane: Lane = new Map()
  for (const row of applied.runtimeAssignments.get(service) ?? []) {
    // Last write wins, as it does for the process environment.
    lane.set(row.name, {
      name: row.name,
      source: row.source ?? 'unknown',
      isSecret: row.isSecret,
      value: row.isSecret ? null : row.value,
      forBuild: false,
      forRuntime: true,
    })
  }
  return lane
}

function buildLane(
  applied: Pick<ApplyVariablesResult, 'buildAssignments' | 'secretPlan'>,
  service: string,
  sourceBuilt: boolean
): Lane {
  const lane: Lane = new Map()
  for (const row of applied.buildAssignments.get(service) ?? []) {
    lane.set(row.name, {
      name: row.name,
      source: row.source ?? 'unknown',
      isSecret: false,
      value: row.value,
      forBuild: true,
      forRuntime: false,
      ...(sourceBuilt && !isBuildEnvNameAllowed(row.name)
        ? { droppedFromBuild: true as const }
        : {}),
    })
  }
  // A build secret is a file the build reads under its target name.
  for (const entry of applied.secretPlan) {
    if (entry.composeServiceName !== service || !entry.forBuild) continue
    lane.set(entry.target, {
      name: entry.target,
      source: 'unknown',
      isSecret: true,
      value: null,
      forBuild: true,
      forRuntime: false,
    })
  }
  return lane
}

/**
 * The per-service variable lists the preview shows, split by when each is used.
 * Runtime comes from the environment the service ends up with and build from the
 * build variables and build secrets, each by the name that lane sees, last write
 * winning. `sourceBuiltServices` are the services the host builds from a source
 * release: a build variable whose name the host refuses is flagged
 * `droppedFromBuild` there.
 */
export function buildServiceVariablesViews(
  applied: Pick<ApplyVariablesResult, 'runtimeAssignments' | 'buildAssignments' | 'secretPlan'>,
  sourceBuiltServices: ReadonlySet<string> = new Set()
): ServiceVariablesView[] {
  const services = new Set<string>([
    ...applied.runtimeAssignments.keys(),
    ...applied.buildAssignments.keys(),
    ...applied.secretPlan.map((entry) => entry.composeServiceName),
  ])
  const views: ServiceVariablesView[] = []
  for (const composeServiceName of [...services].sort((a, b) => a.localeCompare(b))) {
    const variables = combine(
      runtimeLane(applied, composeServiceName),
      buildLane(applied, composeServiceName, sourceBuiltServices.has(composeServiceName))
    )
    if (variables.length > 0) views.push({ composeServiceName, variables })
  }
  return views
}
