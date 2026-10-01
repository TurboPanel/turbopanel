/**
 * Impure upgrade coordinator. Reads rows, calls the pure planner, writes
 * Postgres, and enqueues cell messages. Hello and progress handlers call the
 * note* methods and never enqueue.
 */
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
  type UpdateProgressStage,
} from '../../contracts/cell-protocol.ts'
import type { UpdateChannel } from '../../contracts/update-channel.ts'
import {
  channelHasInstancePackage,
  pinnedManifestBlockers,
  resolveUpgradeTarget,
} from './target-resolve.ts'
import {
  differsFromInstalled,
  isDowngrade,
  isOnTarget,
  unitTarget,
  type UpgradeTarget,
} from './target.ts'
import {
  type PlannedStep,
  planSingleServer,
  planUpgrade,
  stepSatisfiedByInstalled,
  type UpgradeRuntime,
} from './planner.ts'
import {
  activeBatchIndex,
  capWorkersDispatch,
  earliestOpenPhase,
  failedPlatformPhase,
  finalRunStatus,
  finalRunStatusFromSummary,
  fleetCellProbeIds,
  isFleetGateSatisfied,
  type PlatformPhase,
  platformFailureError,
  type StepSummary,
  summarizeSteps,
  UPGRADE_TICK_STEP_BUDGET,
} from './run.ts'
import {
  computeBackoffMs,
  planStepAction,
  type StepAction,
  UPGRADE_STEP_MAX_ATTEMPTS,
} from './transitions.ts'
import { shouldAutoStartRun } from './schedule.ts'
import {
  type ClientUpdateBlock,
  clientUpdateBlock,
  controlPlaneBackupPath,
  controlPlaneRollbackCommand,
  daemonOnlyUpdateCommand,
  isProgressTerminal,
  isUpgradeRunId,
  MANAGED_UPGRADE_FEATURE,
  readDispatchHistory,
  stepStatusForProgressStage,
  withInProgressRefused,
  withSupersededRequest,
} from './decisions.ts'
import type {
  FleetProbe,
  FleetServerFact,
  UpgradeRunRow,
  UpgradeStepRow,
  UpgradeStore,
  UpgradeTickWindow,
} from './store.ts'
import {
  UPGRADE_STEP_ACTIVE_STATUSES,
  type UpgradePhase,
  type UpgradeSource,
  type UpgradeStepErrorCode,
  type UpgradeStepStatus,
  type UpgradeStepUnit,
} from './vocabulary.ts'
import type { UpgradeSettings } from '../settings/upgrade-settings.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export type UpgradePreflight = {
  ok: true
  canStart: boolean
  checks: { id: string; label: string; passed: boolean; detail?: string }[]
  recoveryCommand: string
  /** Reserved before start so a copied command names this attempt. */
  runId: string
  backupPath: string
  blockers: string[]
}

export type UpgradeCoordinator = {
  preflight(): Promise<UpgradePreflight>
  start(input: {
    source: UpgradeSource
    startedBy: string | null
    serverId?: string
    fleetServerIds?: readonly string[]
    /** The id preflight already showed. Reused so the copied command matches. */
    runId?: string
  }): Promise<
    | { ok: true; runId: string }
    | {
        ok: false
        error: string
        blockers?: string[]
      }
  >
  tick(input?: { resolveManifests?: boolean }): Promise<void>
  activeRun(): Promise<(UpgradeRunRow & { steps: UpgradeStepRow[] }) | null>
  /**
   * The most recent finished run, with its steps, when it ended within
   * {@link UPGRADE_LAST_RUN_VISIBLE_MS}. A run leaves `activeRun` the moment it
   * fails; without this the console loses the failure and its reason.
   */
  lastRun(): Promise<(UpgradeRunRow & { steps: UpgradeStepRow[] }) | null>
  run(id: string): Promise<(UpgradeRunRow & { steps: UpgradeStepRow[] }) | null>
  history(offset: number, limit: number): Promise<{ runs: UpgradeRunRow[]; total: number }>
  servers(input: { offset: number; limit: number; status: string }): Promise<{
    servers: UpgradeStepRow[]
    total: number
  }>
  settings(): Promise<UpgradeSettings>
  saveSettings(settings: UpgradeSettings): Promise<void>
  cancel(runId: string): Promise<{ ok: boolean; error?: string }>
  retry(stepId: string): Promise<{ ok: boolean; error?: string }>
  noteDaemonCommit(serverId: string, commit: string, at: string): Promise<void>
  noteProgress(input: {
    serverId: string
    upgradeId?: string
    unit: UpgradeStepUnit
    stage: UpdateProgressStage
    at: string
    detail?: string
    errorCode?: string
    /** Wire id of the `update` / `instance-update` this report belongs to. */
    requestId: string
  }): Promise<void>
  noteOutcome(input: {
    serverId: string
    upgradeId?: string
    unit: UpgradeStepUnit
    ok: boolean
    at: string
    error?: string
    errorCode?: string
    /** Wire id of the `update` / `instance-update` this report belongs to. */
    requestId: string
  }): Promise<void>
  updateGate(): Promise<ClientUpdateBlock>
}

export type UpgradeCoordinatorDeps = {
  store: UpgradeStore
  enqueue: (serverId: string, envelope: DaemonOutboundEnvelope) => Promise<unknown>
  runtime: UpgradeRuntime
  channel: UpdateChannel
  development: boolean
  now: () => string
  colocatedServerId: string | null
  instanceInstalled: { version: string; commit: string | null }
  resolveTarget?: () => Promise<UpgradeTarget>
  /**
   * One line per maintenance tick describing what it decided (target, drift,
   * whether an automatic run started or why not). The tick caller rate-limits.
   */
  trace?: (decision: UpgradeTickDecision) => void
}

/** What one maintenance tick decided, for the operator log. */
export type UpgradeTickDecision = {
  channel: UpdateChannel
  targetDaemon: { version: string | null; commit: string | null } | null
  targetInstance: { version: string | null; commit: string | null } | null
  daemonDrift: boolean
  targetDiffers: boolean
  activeRun: { id: string; status: string; phase: string | null } | null
  autoStart:
    | { decision: 'not-attempted' }
    | { decision: 'started'; runId: string; steps: StepSummary }
    | { decision: 'refused'; error: string; blockers: string[] }
}

const ACTIVE = new Set<string>(UPGRADE_STEP_ACTIVE_STATUSES)

/** How long a finished run stays on the console's progress panel. */
export const UPGRADE_LAST_RUN_VISIBLE_MS = 24 * 60 * 60 * 1000

function newId(): string {
  return crypto.randomUUID()
}

function admitsFeature(fact: FleetServerFact | undefined): boolean {
  return fact?.features.includes(MANAGED_UPGRADE_FEATURE) === true
}

function checkManagedFeature(
  target: UpgradeTarget,
  colocated: FleetServerFact | undefined,
  checks: UpgradePreflight['checks'],
  blockers: string[],
  channel: string
): void {
  const managed = admitsFeature(colocated)
  checks.push({
    id: 'managed-upgrade-v1',
    label: 'Co-located daemon can back up and roll back',
    passed: managed,
    detail: managed
      ? undefined
      : daemonOnlyUpdateCommand(target.daemon?.manifestUrl ?? null, channel),
  })
  if (!managed) {
    blockers.push(
      'The co-located daemon does not advertise managed-upgrade-v1. Update only that daemon with a pinned manifest, then start again.'
    )
  }
}

/** One short, single-line reason for a failed delivery (never a stack). */
function dispatchErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 200 ? `${line.slice(0, 197)}...` : line || 'unknown error'
}

export function createUpgradeCoordinator(deps: UpgradeCoordinatorDeps): UpgradeCoordinator {
  const resolveTarget = deps.resolveTarget ?? (() => resolveUpgradeTarget(deps.channel))

  async function facts(): Promise<FleetServerFact[]> {
    return await deps.store.fleetFacts(deps.colocatedServerId)
  }

  async function withSteps(
    run: UpgradeRunRow | null
  ): Promise<(UpgradeRunRow & { steps: UpgradeStepRow[] }) | null> {
    if (!run) return null
    const steps = await deps.store.stepsFor(run.id)
    return { ...run, steps }
  }

  async function buildPreflight(
    target: UpgradeTarget,
    fleet: FleetServerFact[],
    active: UpgradeRunRow | null
  ): Promise<UpgradePreflight> {
    const checks: UpgradePreflight['checks'] = []
    const blockers: string[] = []
    const hasInstance = channelHasInstancePackage(deps.channel)
    const colocated = fleet.find((fact) => fact.colocated)
    checks.push({
      id: 'channel',
      label: 'Update channel',
      passed: true,
      detail: deps.channel,
    })
    const targetKnown =
      Boolean(target.daemon?.commit) || (hasInstance && Boolean(target.instance?.commit))
    checks.push({
      id: 'target',
      label: 'Target build resolved',
      passed: targetKnown,
      detail: target.daemon?.commit ?? target.instance?.commit ?? undefined,
    })
    if (!targetKnown) {
      blockers.push('The channel target could not be resolved.')
    }
    checks.push({
      id: 'active',
      label: 'No upgrade is already running',
      passed: active === null,
    })
    if (active) blockers.push('An upgrade is already running.')
    const manifestGaps = pinnedManifestBlockers(deps.channel, target, {
      runtime: deps.runtime,
      hasColocated: Boolean(deps.colocatedServerId),
      fleetCount: fleet.filter((fact) => !fact.colocated).length,
    })
    for (const gap of manifestGaps) blockers.push(gap)
    if (deps.runtime === 'deno' && !deps.development) {
      checkSelfHostedControlPlane(target, colocated, hasInstance, checks, blockers)
    }
    const runId = active?.id ?? (await ensureReservedRunId(deps.store))
    return {
      ok: true,
      canStart: blockers.length === 0,
      checks,
      runId,
      backupPath: controlPlaneBackupPath(runId),
      recoveryCommand:
        admitsFeature(colocated) || !hasInstance
          ? controlPlaneRollbackCommand(runId)
          : daemonOnlyUpdateCommand(target.daemon?.manifestUrl ?? null, deps.channel),
      blockers,
    }
  }

  /** The co-located host checks of a self-hosted run, appended in blocker order. */
  function checkSelfHostedControlPlane(
    target: UpgradeTarget,
    colocated: FleetServerFact | undefined,
    hasInstance: boolean,
    checks: UpgradePreflight['checks'],
    blockers: string[]
  ): void {
    const downgrades = downgradeBlockers(target, colocated, hasInstance)
    checks.push({
      id: 'no-downgrade',
      label: 'Target is not older than what is installed',
      passed: downgrades.length === 0,
    })
    blockers.push(...downgrades)
    const connected = colocated?.connected === true
    checks.push({
      id: 'colocated',
      label: 'Co-located daemon is connected',
      passed: connected,
    })
    if (!connected) blockers.push('The co-located daemon is not connected.')
    if (hasInstance) checkManagedFeature(target, colocated, checks, blockers, deps.channel)
  }

  function downgradeBlockers(
    target: UpgradeTarget,
    colocated: FleetServerFact | undefined,
    hasInstance: boolean
  ): string[] {
    const out: string[] = []
    const rollback =
      'Managed updates never go back to an older build; use the rollback command instead.'
    if (hasInstance && isDowngrade(deps.instanceInstalled.version, target.instance?.version)) {
      out.push(
        `The channel's control-plane build ${target.instance?.version} is older than the installed ${deps.instanceInstalled.version}. ${rollback}`
      )
    }
    if (
      colocated &&
      isDowngrade(colocated.version, target.daemon?.version, {
        installedBuiltAt: colocated.builtAt,
        targetBuiltAt: target.daemon?.builtAt,
      })
    ) {
      out.push(
        `The channel's daemon build ${target.daemon?.version} is older than the co-located daemon's ${colocated.version}. ${rollback}`
      )
    }
    return out
  }

  async function dispatchStep(
    run: UpgradeRunRow,
    step: UpgradeStepRow,
    fact: FleetServerFact | undefined
  ): Promise<void> {
    // Guard against a concurrent hello/progress report that already moved
    // this row past the status the tick read it as: a co-located daemon's
    // own restart mid-install can drop it "offline" and back within seconds,
    // and if its hello reporting the reached commit lands between this tick
    // reading the step and writing this dispatch, a blind write here would
    // clobber that report with a brand new, redundant install command —
    // looping the same step forever. Claim the row first; only enqueue the
    // command if that claim actually applied.
    const expectedStatus = step.status
    const envelope = envelopeFor(run, step, fact)
    step.detail = withSupersededRequest(step.detail, step.requestId)
    step.status = 'dispatched'
    step.attempts += 1
    step.requestId = envelope.requestId
    step.lastStageAt = deps.now()
    step.nextAttemptAt = null
    step.errorMessage = null
    const claimed = await deps.store.saveStep(step, expectedStatus)
    if (!claimed) return
    try {
      await deps.enqueue(step.serverId, envelope)
    } catch (error) {
      await recordDispatchFailure(step, error)
    }
  }

  /**
   * The command never reached the server's cell. Say so on the step instead of
   * leaving it `dispatched` until the 15-minute stall timeout: retry with the
   * usual backoff, and after the last allowed attempt hand it to an operator.
   * Never throws: one server's failed delivery must not stop the others.
   */
  async function recordDispatchFailure(step: UpgradeStepRow, error: unknown): Promise<void> {
    step.errorMessage = `The update command could not be delivered to the server: ${dispatchErrorText(error)}`
    step.lastStageAt = deps.now()
    if (step.attempts >= UPGRADE_STEP_MAX_ATTEMPTS) {
      step.status = 'needs_attention'
      step.errorCode = 'dispatch_failed' satisfies UpgradeStepErrorCode
    } else {
      step.status = 'pending'
      step.nextAttemptAt = new Date(
        Date.parse(deps.now()) + computeBackoffMs(step.attempts)
      ).toISOString()
    }
    await deps.store.saveStep(step, 'dispatched')
  }

  function envelopeFor(
    run: UpgradeRunRow,
    step: UpgradeStepRow,
    fact: FleetServerFact | undefined
  ): DaemonOutboundEnvelope {
    const at = deps.now()
    const managed = admitsFeature(fact)
    if (step.unit === 'instance') {
      const pin = unitTarget(run.target, 'instance')
      const ui = run.target.ui
      return {
        kind: 'instance-update',
        deliveryId: generateDeliveryId(),
        requestId: generateRequestId(),
        at,
        channel: deps.channel,
        upgradeId: run.id,
        ...(pin?.manifestUrl ? { manifestUrl: pin.manifestUrl } : {}),
        ...(ui?.manifestUrl ? { uiManifestUrl: ui.manifestUrl } : {}),
        ...(pin?.version ? { targetVersion: pin.version } : {}),
        ...(pin?.commit ? { targetCommit: pin.commit } : {}),
      }
    }
    const pin = unitTarget(run.target, 'daemon')
    return {
      kind: 'update',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at,
      channel: deps.channel,
      ...(managed
        ? {
            upgradeId: run.id,
            ...(pin?.manifestUrl ? { manifestUrl: pin.manifestUrl } : {}),
            ...(pin?.commit ? { targetCommit: pin.commit } : {}),
          }
        : {}),
    }
  }

  async function saveStepIfChanged(
    step: UpgradeStepRow,
    before: string,
    expectedStatus: UpgradeStepStatus
  ): Promise<boolean> {
    if (stepPersistKey(step) === before) return false
    return await deps.store.saveStep(step, expectedStatus)
  }

  async function applyAction(
    run: UpgradeRunRow,
    step: UpgradeStepRow,
    action: StepAction,
    fact: FleetServerFact | undefined,
    queue: UpgradeStepRow[]
  ): Promise<boolean> {
    if (action.kind === 'none') return false
    const before = stepPersistKey(step)
    // The status the tick read this step as, before this action mutates it —
    // the CAS guard on every write below, so a concurrent hello/progress
    // report (which can settle a step while a tick pass is still deciding
    // what to do with the copy it read earlier) always wins over this pass.
    const readStatus = step.status
    if (action.kind === 'done') {
      step.status = 'done'
      step.lastStageAt = deps.now()
      return await saveStepIfChanged(step, before, readStatus)
    }
    if (action.kind === 'wait_offline') {
      // The offline deadline counts from here, not from the row's age.
      if (step.status !== 'waiting') step.lastStageAt = deps.now()
      step.status = 'waiting'
      return await saveStepIfChanged(step, before, readStatus)
    }
    if (action.kind === 'needs_attention') {
      step.status = 'needs_attention'
      step.errorCode = action.errorCode
      return await saveStepIfChanged(step, before, readStatus)
    }
    if (action.kind === 'retry') {
      step.status = 'pending'
      step.nextAttemptAt = action.nextAttemptAt
      return await saveStepIfChanged(step, before, readStatus)
    }
    if (step.unit === 'instance' && !admitsFeature(fact)) {
      step.status = 'needs_attention'
      step.errorCode = 'managed_upgrade_required' satisfies UpgradeStepErrorCode
      step.errorMessage = daemonOnlyUpdateCommand(
        unitTarget(run.target, 'daemon')?.manifestUrl ?? null,
        deps.channel
      )
      return await saveStepIfChanged(step, before, readStatus)
    }
    queue.push(step)
    return false
  }

  /** Whether the fleet hard-gate is open for `target` given the co-located host and this control plane. */
  function fleetGateOpen(fleet: FleetServerFact[], target: UpgradeTarget): boolean {
    return isFleetGateSatisfied({
      development: deps.development,
      runtime: deps.runtime,
      channelHasInstancePackage: channelHasInstancePackage(deps.channel),
      colocatedDaemonOnTarget: isOnTarget(
        installedOf(fleet.find((fact) => fact.colocated)),
        target.daemon
      ),
      controlPlaneOnTarget: isOnTarget(
        {
          version: deps.instanceInstalled.version,
          commit: deps.instanceInstalled.commit,
        },
        target.instance
      ),
    })
  }

  /** The stored fleet facts with the live cell probe of the steps this pass may act on laid over them. */
  async function fleetViewFor(
    fleet: FleetServerFact[],
    candidateIds: readonly string[]
  ): Promise<FleetServerFact[]> {
    const probeIds = fleetCellProbeIds(deps.colocatedServerId, candidateIds)
    const probes =
      probeIds.length === 0
        ? new Map<string, FleetProbe>()
        : await deps.store.probeCandidates(probeIds)
    return overlayProbes(fleet, probes)
  }

  function stepActionFor(step: UpgradeStepRow, fact: FleetServerFact | undefined): StepAction {
    return planStepAction(
      {
        status: step.status,
        attempts: step.attempts,
        nextAttemptAt: step.nextAttemptAt,
        lastStageAt: step.lastStageAt,
        toCommit: step.toCommit,
      },
      {
        serverConnected: fact?.connected === true,
        currentCommit: currentCommit(step, fact),
      },
      { now: deps.now() }
    )
  }

  /**
   * Decide and apply each step's next action, then dispatch what was queued
   * (capped on Workers). True when any step was written or dispatched.
   */
  async function processSteps(
    run: UpgradeRunRow,
    steps: readonly UpgradeStepRow[],
    fleetView: readonly FleetServerFact[]
  ): Promise<boolean> {
    const queue: UpgradeStepRow[] = []
    let dirty = false
    await forEachSequential(steps, async (step) => {
      const fact = factOf(fleetView, step)
      if (await applyAction(run, step, stepActionFor(step, fact), fact, queue)) dirty = true
    })
    await forEachSequential(capWorkersDispatch(deps.runtime, queue), async (step) => {
      await dispatchStep(run, step, factOf(fleetView, step))
      dirty = true
    })
    return dirty
  }

  async function advance(
    run: UpgradeRunRow,
    steps: UpgradeStepRow[],
    fleet: FleetServerFact[]
  ): Promise<void> {
    const gateOpen = fleetGateOpen(fleet, run.target)
    const batch = activeBatchIndex(
      steps.map((step) => ({
        batchIndex: step.batchIndex,
        status: step.status,
      }))
    )
    const currentPhase = earliestOpenPhase(steps)
    const wave = steps.filter((step) => stepInCurrentWave(step, currentPhase, gateOpen, batch))
    const fleetView = await fleetViewFor(
      fleet,
      wave.map((step) => step.serverId)
    )
    await processSteps(run, wave, fleetView)
    const failedPhase = failedPlatformPhase(steps)
    if (failedPhase) {
      await failRun(run, failedPhase, summarizeSteps(steps))
      return
    }
    if (steps.every((step) => isTerminal(step.status))) {
      run.status = finalRunStatus(steps)
      run.finishedAt = deps.now()
      run.counts = summarizeSteps(steps)
      run.phase = null
      await deps.store.saveRun(run)
      return
    }
    run.status = 'running'
    run.phase = earliestOpenPhase(steps)
    run.counts = summarizeSteps(steps)
    await deps.store.saveRun(run)
  }

  /**
   * A failed co-located daemon or control plane ends the run: the fleet gate
   * needs both on target, so the fleet phase behind it could never open.
   */
  async function failRun(
    run: UpgradeRunRow,
    phase: PlatformPhase,
    counts: StepSummary
  ): Promise<void> {
    run.status = 'failed'
    run.error = platformFailureError(phase)
    run.finishedAt = deps.now()
    run.counts = counts
    run.phase = null
    await deps.store.saveRun(run)
  }

  async function finishRun(run: UpgradeRunRow, counts: StepSummary): Promise<void> {
    run.status = finalRunStatusFromSummary(counts)
    run.finishedAt = deps.now()
    run.counts = counts
    run.phase = null
    await deps.store.saveRun(run)
    await deps.store.writeTickCursor(run.id, null)
  }

  /** Facts for the window's servers, plus the co-located host the gate reads. */
  async function factsForWindow(window: UpgradeTickWindow): Promise<FleetServerFact[]> {
    const ids = window.steps.map((step) => step.serverId)
    if (deps.colocatedServerId && !ids.includes(deps.colocatedServerId)) {
      ids.push(deps.colocatedServerId)
    }
    return await deps.store.factsFor(ids, deps.colocatedServerId)
  }

  /** Persist the run's status, phase and counts only when the tick changed one of them. */
  async function saveRunIfChanged(
    run: UpgradeRunRow,
    phase: UpgradePhase | null,
    counts: StepSummary
  ): Promise<void> {
    if (run.status === 'running' && run.phase === phase && sameSummary(run.counts, counts)) return
    run.status = 'running'
    run.phase = phase
    run.counts = counts
    await deps.store.saveRun(run)
  }

  /** Remember where this window stopped; a short (wrapped) window starts the batch over next tick. */
  async function writeWindowCursor(run: UpgradeRunRow, window: UpgradeTickWindow): Promise<void> {
    const { phase, batchIndex } = window
    if (phase === null || batchIndex === null) return
    const last = window.steps.at(-1)
    const wrapped = window.steps.length < UPGRADE_TICK_STEP_BUDGET
    await deps.store.writeTickCursor(run.id, {
      phase,
      batchIndex,
      afterId: wrapped || !last ? null : last.id,
    })
  }

  async function advanceWindow(run: UpgradeRunRow): Promise<void> {
    const cursor = await deps.store.readTickCursor(run.id)
    const window = await deps.store.tickWindow(run.id, cursor, UPGRADE_TICK_STEP_BUDGET)
    if (window.failedPlatformPhase) {
      await failRun(run, window.failedPlatformPhase, window.counts)
      await deps.store.writeTickCursor(run.id, null)
      return
    }
    if (window.allTerminal) {
      await finishRun(run, window.counts)
      return
    }
    const fleet = await factsForWindow(window)
    const gateOpen = fleetGateOpen(fleet, run.target)
    const open = window.steps.filter((step) => isOpenInWindow(step, gateOpen))
    const fleetView = await fleetViewFor(
      fleet,
      open.map((step) => step.serverId)
    )
    const dirty = await processSteps(run, open, fleetView)
    const counts = dirty ? await deps.store.countSteps(run.id) : window.counts
    if (counts.total > 0 && counts.inProgress === 0) {
      // This tick settled the last open step (counts cover the whole run).
      await finishRun(run, counts)
      return
    }
    await saveRunIfChanged(run, window.phase, counts)
    await writeWindowCursor(run, window)
  }

  async function markInProgressRefused(step: UpgradeStepRow, at: string): Promise<void> {
    // An earlier dispatch of this step is still installing. It is the live
    // install now: keep the step in flight and let its own reports finish it.
    step.detail = withInProgressRefused(step.detail)
    step.lastStageAt = at
    await deps.store.saveStep(step)
  }

  function currentCommit(step: UpgradeStepRow, fact: FleetServerFact | undefined): string | null {
    if (step.unit === 'instance') return deps.instanceInstalled.commit
    return fact?.commit ?? null
  }

  return {
    preflight: async () => {
      const [target, fleet, active] = await Promise.all([
        resolveTarget(),
        facts(),
        deps.store.activeRun(),
      ])
      return await buildPreflight(target, fleet, active)
    },
    start: async (input) => {
      const [target, fleet, active, settings] = await Promise.all([
        resolveTarget(),
        facts(),
        deps.store.activeRun(),
        deps.store.settings(),
      ])
      const preflight = await buildPreflight(target, fleet, active)
      if (!preflight.canStart) {
        return {
          ok: false,
          error: preflight.blockers[0] ?? 'preflight_failed',
          blockers: preflight.blockers,
        }
      }
      const plan = input.serverId
        ? planSingleServer(input.serverId)
        : planUpgrade({
            runtime: input.fleetServerIds ? 'workers' : deps.runtime,
            channelHasInstancePackage: input.fleetServerIds
              ? false
              : channelHasInstancePackage(deps.channel),
            colocatedServerId: input.fleetServerIds ? null : deps.colocatedServerId,
            fleetServerIds:
              input.fleetServerIds ??
              fleet.filter((fact) => !fact.colocated).map((fact) => fact.serverId),
            batch: settings.batch,
          })
      const now = deps.now()
      const requested = input.runId?.trim() ?? ''
      const reserved = await deps.store.reservedRunId()
      const runId = isUpgradeRunId(requested) ? requested : (reserved ?? newId())
      const run: UpgradeRunRow = {
        id: runId,
        createdAt: now,
        source: input.source,
        channel: deps.channel,
        status: 'pending',
        phase: earliestOpenPhase(
          plan.steps.map((step) => ({ phase: step.phase, status: 'pending' }))
        ),
        startedBy: input.startedBy,
        startedByEmail: null,
        target,
        batchPolicy: settings.batch,
        counts: null,
        error: null,
        startedAt: now,
        finishedAt: null,
      }
      const steps = plan.steps.map((planned) =>
        stepFromPlan(run, planned, fleet, now, deps.instanceInstalled.commit)
      )
      run.phase = earliestOpenPhase(steps)
      const inserted = await deps.store.insertRun(run, steps)
      if (inserted === 'active') {
        return { ok: false, error: 'An upgrade is already running.' }
      }
      await deps.store.clearReservedRunId()
      const stored = await deps.store.stepsFor(run.id)
      run.phase = earliestOpenPhase(stored)
      await advance(run, stored, fleet)
      return { ok: true, runId: run.id }
    },
    tick: async (input) => {
      if (input?.resolveManifests !== false) {
        const target = await resolveTarget()
        await deps.store.saveLatestBuild(target)
        const [settings, active] = await Promise.all([
          deps.store.settings(),
          deps.store.activeRun(),
        ])
        const daemonCommit = target.daemon?.commit ?? null
        const daemonDrift = daemonCommit
          ? await deps.store.anyDaemonBehind(daemonCommit, target.daemon?.builtAt)
          : false
        const differs =
          daemonDrift ||
          differsFromInstalled(
            {
              version: deps.instanceInstalled.version,
              commit: deps.instanceInstalled.commit,
            },
            target.instance
          )
        let autoStart: UpgradeTickDecision['autoStart'] = { decision: 'not-attempted' }
        if (
          shouldAutoStartRun({
            runtime: deps.runtime,
            settings,
            now: new Date(deps.now()),
            targetDiffers: differs,
            runActive: active !== null,
          })
        ) {
          const started = await createUpgradeCoordinator({ ...deps, trace: undefined }).start({
            source: 'auto',
            startedBy: null,
          })
          autoStart = started.ok
            ? {
                decision: 'started',
                runId: started.runId,
                steps: await deps.store.countSteps(started.runId),
              }
            : {
                decision: 'refused',
                error: started.error,
                blockers: started.blockers ?? [],
              }
        }
        deps.trace?.({
          channel: deps.channel,
          targetDaemon: target.daemon
            ? { version: target.daemon.version, commit: target.daemon.commit }
            : null,
          targetInstance: target.instance
            ? { version: target.instance.version, commit: target.instance.commit }
            : null,
          daemonDrift,
          targetDiffers: differs,
          activeRun: active ? { id: active.id, status: active.status, phase: active.phase } : null,
          autoStart,
        })
      }
      const active = await deps.store.activeRun()
      if (!active) return
      await advanceWindow(active)
    },
    activeRun: async () => withSteps(await deps.store.activeRun()),
    lastRun: async () => {
      const { runs } = await deps.store.history(0, 1)
      const latest = runs[0]
      if (!latest?.finishedAt) return null
      const age = Date.parse(deps.now()) - Date.parse(latest.finishedAt)
      // NaN (an unparseable finish time) hides the run, as `!(age <= limit)` did.
      if (Number.isNaN(age) || age > UPGRADE_LAST_RUN_VISIBLE_MS) return null
      return await withSteps(latest)
    },
    run: async (id) => withSteps(await deps.store.runById(id)),
    history: (offset, limit) => deps.store.history(offset, limit),
    servers: async ({ offset, limit, status }) => {
      const [target, active] = await Promise.all([deps.store.latestBuild(), deps.store.activeRun()])
      const page = await deps.store.pageFleet(
        {
          offset,
          limit,
          status,
          targetCommit: target?.daemon?.commit ?? null,
        },
        deps.colocatedServerId
      )
      const steps = active ? await deps.store.stepsFor(active.id) : []
      const onPage = new Set(page.facts.map((fact) => fact.serverId))
      const pageSteps = steps.filter((step) => onPage.has(step.serverId))
      return {
        total: page.total,
        servers: page.facts.map((fact) => serverPageRow(fact, pageSteps, target)),
      }
    },
    settings: () => deps.store.settings(),
    saveSettings: (settings) => deps.store.saveSettings(settings),
    cancel: async (runId) => {
      const run = await deps.store.runById(runId)
      if (!run) return { ok: false, error: 'upgrade_run_not_found' }
      if (run.status !== 'pending' && run.status !== 'running') {
        return { ok: false, error: 'upgrade_not_active' }
      }
      const steps = await deps.store.stepsFor(run.id)
      await forEachSequential(steps, async (step) => {
        if (isTerminal(step.status)) return
        step.status = 'skipped'
        await deps.store.saveStep(step)
      })
      run.status = 'cancelled'
      run.finishedAt = deps.now()
      run.counts = summarizeSteps(steps)
      await deps.store.saveRun(run)
      return { ok: true }
    },
    retry: async (stepId) => {
      const active = await deps.store.activeRun()
      if (!active) return { ok: false, error: 'upgrade_not_active' }
      const steps = await deps.store.stepsFor(active.id)
      const step = steps.find((item) => item.id === stepId)
      if (!step) return { ok: false, error: 'upgrade_step_not_found' }
      if (
        step.status !== 'needs_attention' &&
        step.status !== 'failed' &&
        step.status !== 'rolled_back'
      ) {
        return { ok: false, error: 'upgrade_step_not_retryable' }
      }
      step.status = 'pending'
      step.nextAttemptAt = null
      step.errorCode = null
      step.errorMessage = null
      await deps.store.saveStep(step)
      const fleet = await facts()
      await advance(active, steps, fleet)
      return { ok: true }
    },
    noteDaemonCommit: async (serverId, commit, at) => {
      const active = await deps.store.activeRun()
      if (!active) return
      const steps = await deps.store.stepsFor(active.id)
      const step = steps.find(
        (item) =>
          item.serverId === serverId &&
          item.unit === 'daemon' &&
          item.toCommit === commit &&
          !isTerminal(item.status)
      )
      if (!step) return
      step.status = 'done'
      step.lastStageAt = at
      await deps.store.saveStep(step)
    },
    noteProgress: async (input) => {
      const step = await findOpenStep(deps.store, input.serverId, input.unit, input.upgradeId)
      if (!step) return
      const report = classifyReport(step, input.requestId)
      if (!report) return
      if (input.stage === 'failed' && input.errorCode === DISPATCH_IN_PROGRESS) {
        if (report === 'current') await markInProgressRefused(step, input.at)
        return
      }
      const failure = input.stage === 'failed' || input.stage === 'rolled-back'
      if (failure && !priorFailureApplies(step, report)) return
      const status = stepStatusForProgressStage(input.stage)
      step.status = status
      step.lastStageAt = input.at
      if (input.errorCode) step.errorCode = input.errorCode
      if (input.detail) recordProgressDetail(step, status, input.detail)
      await deps.store.saveStep(step)
    },
    updateGate: async () => {
      const [target, fleet] = await Promise.all([resolveTarget(), facts()])
      return clientUpdateBlock({
        runtime: deps.runtime,
        development: deps.development,
        targetCommitKnown: Boolean(target.daemon?.commit),
        gateOpen: fleetGateOpen(fleet, target),
      })
    },
    noteOutcome: async (input) => {
      const step = await findOpenStep(deps.store, input.serverId, input.unit, input.upgradeId)
      if (!step) return
      const report = classifyReport(step, input.requestId)
      if (!report) return
      if (!input.ok && input.errorCode === DISPATCH_IN_PROGRESS) {
        if (report === 'current') await markInProgressRefused(step, input.at)
        return
      }
      if (!input.ok && !priorFailureApplies(step, report)) return
      if (input.ok) {
        step.lastStageAt = input.at
        if (step.unit === 'instance') {
          step.status = 'done'
        }
      } else if (isRollbackOutcome(step, input.errorCode)) {
        // The daemon reports a rollback as a `rolled-back` progress stage and
        // then a failed result carrying the rollback's reason code; the
        // result must not turn that into an ordinary failure.
        step.status = 'rolled_back'
        step.errorCode = input.errorCode ?? step.errorCode ?? 'rolled_back'
        step.errorMessage = input.error ?? step.errorMessage ?? null
        step.lastStageAt = input.at
      } else {
        step.status = 'failed'
        step.errorCode = input.errorCode ?? 'update_failed'
        step.errorMessage = input.error ?? null
        step.lastStageAt = input.at
      }
      await deps.store.saveStep(step)
    },
  }
}

async function ensureReservedRunId(store: UpgradeStore): Promise<string> {
  const existing = await store.reservedRunId()
  if (existing && isUpgradeRunId(existing)) return existing
  const id = newId()
  await store.reserveRunId(id)
  return id
}

/** Fold a progress report's free-text detail into the step; a failed or rolled-back one is also its error message. */
function recordProgressDetail(
  step: UpgradeStepRow,
  status: UpgradeStepStatus,
  detail: string
): void {
  step.detail = {
    ...(typeof step.detail === 'object' && step.detail !== null ? step.detail : {}),
    phase: step.phase,
    progressDetail: detail,
  }
  if (isProgressTerminal(status) && status !== 'done') step.errorMessage = detail
}

/** A window step the tick may act on: still open, and not a fleet step behind a closed gate. */
function isOpenInWindow(step: UpgradeStepRow, gateOpen: boolean): boolean {
  return !isTerminal(step.status) && (step.phase !== 'fleet' || gateOpen)
}

function factOf(
  fleet: readonly FleetServerFact[],
  step: UpgradeStepRow
): FleetServerFact | undefined {
  return fleet.find((item) => item.serverId === step.serverId)
}

function stepInCurrentWave(
  step: UpgradeStepRow,
  currentPhase: UpgradePhase | null,
  gateOpen: boolean,
  batch: number | null
): boolean {
  if (isTerminal(step.status)) return false
  if (step.phase === 'fleet' && !gateOpen) return false
  if (currentPhase && step.phase !== currentPhase) return false
  if (batch !== null && step.batchIndex !== batch && step.phase === 'fleet') {
    return false
  }
  return true
}

function overlayProbes(
  fleet: FleetServerFact[],
  probes: Map<string, FleetProbe>
): FleetServerFact[] {
  if (probes.size === 0) return fleet
  return fleet.map((fact) => {
    const probed = probes.get(fact.serverId)
    if (!probed) return fact
    return {
      ...fact,
      connected: probed.connected,
      commit: probed.commit ?? fact.commit,
      version: probed.version ?? fact.version,
    }
  })
}

function installedOf(fact: FleetServerFact | undefined) {
  return { version: fact?.version ?? null, commit: fact?.commit ?? null }
}

function isTerminal(status: string): boolean {
  return (
    status === 'done' || status === 'skipped' || status === 'failed' || status === 'needs_attention'
  )
}

function stepPersistKey(step: UpgradeStepRow): string {
  return [
    step.status,
    step.requestId ?? '',
    String(step.attempts),
    step.nextAttemptAt ?? '',
    step.lastStageAt ?? '',
    step.errorCode ?? '',
    step.errorMessage ?? '',
  ].join('\0')
}

function sameSummary(left: StepSummary | null, right: StepSummary): boolean {
  if (!left) return false
  return (
    left.total === right.total &&
    left.done === right.done &&
    left.skipped === right.skipped &&
    left.failed === right.failed &&
    left.needsAttention === right.needsAttention &&
    left.inProgress === right.inProgress
  )
}

/**
 * The daemon's answer when an `update` / `instance-update` arrives while an
 * install of that unit is already running (turbopaneld `client.ts`).
 */
const DISPATCH_IN_PROGRESS = 'preflight_in_progress'

/**
 * Which dispatch of this step a progress or result frame belongs to: the
 * current one, an earlier one this step superseded (a stall retry), or none.
 */
function classifyReport(step: UpgradeStepRow, requestId: string): 'current' | 'prior' | null {
  if (step.requestId !== null && step.requestId === requestId) return 'current'
  const history = readDispatchHistory(step.detail)
  return history.priorRequestIds.includes(requestId) ? 'prior' : null
}

/**
 * A failure from an earlier dispatch counts only once the current dispatch
 * was refused as already in progress — then the earlier install is the live
 * one. While the newer dispatch is live, a late failure from an older one is
 * ignored.
 */
function priorFailureApplies(step: UpgradeStepRow, report: 'current' | 'prior'): boolean {
  if (report === 'current') return true
  return readDispatchHistory(step.detail).inProgressRefused
}

function isRollbackOutcome(step: UpgradeStepRow, errorCode: string | undefined): boolean {
  return (
    step.status === 'rolled_back' || errorCode === 'rolled_back' || errorCode === 'update_rollback'
  )
}

function initialStepStatus(satisfied: boolean, ahead: boolean): UpgradeStepRow['status'] {
  if (satisfied) return 'done'
  if (ahead) return 'skipped'
  return 'pending'
}

function stepFromPlan(
  run: UpgradeRunRow,
  planned: PlannedStep,
  fleet: FleetServerFact[],
  now: string,
  instanceCommit: string | null
): UpgradeStepRow {
  const fact = fleet.find((item) => item.serverId === planned.serverId)
  const pin = unitTarget(run.target, planned.unit)
  const satisfied = stepSatisfiedByInstalled(
    planned,
    {
      daemonCommit: fact?.commit ?? null,
      instanceCommit: instanceCommit,
    },
    run.target
  )
  // A daemon already newer than the target is left alone. The platform units
  // never get here older: preflight refuses that run outright.
  const ahead =
    !satisfied &&
    planned.unit === 'daemon' &&
    isDowngrade(fact?.version, pin?.version, {
      installedBuiltAt: fact?.builtAt,
      targetBuiltAt: pin?.builtAt,
    })
  return {
    id: newId(),
    upgradeId: run.id,
    serverId: planned.serverId,
    unit: planned.unit,
    phase: planned.phase,
    batchIndex: planned.batchIndex,
    status: initialStepStatus(satisfied, ahead),
    requestId: null,
    attempts: 0,
    nextAttemptAt: null,
    fromVersion: fact?.version ?? null,
    toVersion: pin?.version ?? null,
    fromCommit: planned.unit === 'instance' ? null : (fact?.commit ?? null),
    toCommit: pin?.commit ?? null,
    lastStageAt: now,
    errorCode: ahead ? ('downgrade_refused' satisfies UpgradeStepErrorCode) : null,
    errorMessage: ahead
      ? `Runs ${fact?.version}, newer than the target ${pin?.version}. Managed updates never downgrade a server.`
      : null,
    detail: { phase: planned.phase },
  }
}

async function findOpenStep(
  store: UpgradeStore,
  serverId: string,
  unit: UpgradeStepUnit,
  upgradeId?: string
): Promise<UpgradeStepRow | null> {
  const active = await store.activeRun()
  if (!active) return null
  if (upgradeId && active.id !== upgradeId) return null
  const steps = await store.stepsFor(active.id)
  return (
    steps.find(
      (step) =>
        step.serverId === serverId &&
        step.unit === unit &&
        (ACTIVE.has(step.status) || step.status === 'rolled_back')
    ) ?? null
  )
}

function serverPageRow(
  fact: FleetServerFact,
  steps: readonly UpgradeStepRow[],
  target: UpgradeTarget | null
): UpgradeStepRow & {
  updateAvailable?: boolean
  installedVersion?: string | null
  installedCommit?: string | null
  serverName?: string | null
  hostname?: string | null
  connected?: boolean
} {
  const live = steps.find((step) => step.serverId === fact.serverId && step.unit === 'daemon')
  const pin = target?.daemon ?? null
  if (live) {
    return {
      ...live,
      serverName: fact.name,
      hostname: fact.hostname,
      connected: fact.connected,
      installedVersion: fact.version,
      installedCommit: fact.commit,
      updateAvailable: differsFromInstalled(installedOf(fact), pin),
    }
  }
  const onTarget = isOnTarget(installedOf(fact), pin)
  return {
    id: fact.serverId,
    upgradeId: '',
    serverId: fact.serverId,
    serverName: fact.name,
    hostname: fact.hostname,
    connected: fact.connected,
    unit: 'daemon',
    phase: 'fleet',
    batchIndex: 0,
    status: onTarget ? 'done' : 'pending',
    requestId: null,
    attempts: 0,
    nextAttemptAt: null,
    fromVersion: fact.version,
    toVersion: pin?.version ?? null,
    fromCommit: fact.commit,
    toCommit: pin?.commit ?? null,
    lastStageAt: null,
    errorCode: null,
    errorMessage: null,
    detail: null,
    installedVersion: fact.version,
    installedCommit: fact.commit,
    updateAvailable: differsFromInstalled(installedOf(fact), pin),
  }
}
