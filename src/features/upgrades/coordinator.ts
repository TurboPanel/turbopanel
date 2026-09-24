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
} from "../../contracts/cell-protocol.ts";
import type { UpdateChannel } from "../../contracts/update-channel.ts";
import {
  channelHasInstancePackage,
  pinnedManifestBlockers,
  resolveUpgradeTarget,
} from "./target-resolve.ts";
import {
  differsFromInstalled,
  isOnTarget,
  unitTarget,
  type UpgradeTarget,
} from "./target.ts";
import {
  type PlannedStep,
  planSingleServer,
  planUpgrade,
  stepSatisfiedByInstalled,
  type UpgradeRuntime,
} from "./planner.ts";
import {
  activeBatchIndex,
  capWorkersDispatch,
  controlPlaneStepFailed,
  earliestOpenPhase,
  finalRunStatus,
  finalRunStatusFromSummary,
  fleetCellProbeIds,
  isFleetGateSatisfied,
  type StepSummary,
  summarizeSteps,
  UPGRADE_TICK_STEP_BUDGET,
} from "./run.ts";
import { planStepAction, type StepAction } from "./transitions.ts";
import { shouldAutoStartRun } from "./schedule.ts";
import {
  type ClientUpdateBlock,
  clientUpdateBlock,
  controlPlaneBackupPath,
  controlPlaneRollbackCommand,
  daemonOnlyUpdateCommand,
  isProgressTerminal,
  isUpgradeRunId,
  MANAGED_UPGRADE_FEATURE,
  stepStatusForProgressStage,
} from "./decisions.ts";
import type {
  FleetProbe,
  FleetServerFact,
  UpgradeRunRow,
  UpgradeStepRow,
  UpgradeStore,
} from "./store.ts";
import type {
  UpgradePhase,
  UpgradeSource,
  UpgradeStepUnit,
} from "./vocabulary.ts";
import { UPGRADE_STEP_ACTIVE_STATUSES } from "./vocabulary.ts";
import type { UpgradeSettings } from "../settings/upgrade-settings.ts";

export type UpgradePreflight = {
  ok: true;
  canStart: boolean;
  checks: { id: string; label: string; passed: boolean; detail?: string }[];
  recoveryCommand: string;
  /** Reserved before start so a copied command names this attempt. */
  runId: string;
  backupPath: string;
  blockers: string[];
};

export type UpgradeCoordinator = {
  preflight(): Promise<UpgradePreflight>;
  start(input: {
    source: UpgradeSource;
    startedBy: string | null;
    serverId?: string;
    fleetServerIds?: readonly string[];
    /** The id preflight already showed. Reused so the copied command matches. */
    runId?: string;
  }): Promise<
    { ok: true; runId: string } | {
      ok: false;
      error: string;
      blockers?: string[];
    }
  >;
  tick(input?: { resolveManifests?: boolean }): Promise<void>;
  activeRun(): Promise<(UpgradeRunRow & { steps: UpgradeStepRow[] }) | null>;
  run(
    id: string,
  ): Promise<(UpgradeRunRow & { steps: UpgradeStepRow[] }) | null>;
  history(
    offset: number,
    limit: number,
  ): Promise<{ runs: UpgradeRunRow[]; total: number }>;
  servers(input: { offset: number; limit: number; status: string }): Promise<{
    servers: UpgradeStepRow[];
    total: number;
  }>;
  settings(): Promise<UpgradeSettings>;
  saveSettings(settings: UpgradeSettings): Promise<void>;
  cancel(runId: string): Promise<{ ok: boolean; error?: string }>;
  retry(stepId: string): Promise<{ ok: boolean; error?: string }>;
  noteDaemonCommit(serverId: string, commit: string, at: string): Promise<void>;
  noteProgress(input: {
    serverId: string;
    upgradeId?: string;
    unit: UpgradeStepUnit;
    stage: UpdateProgressStage;
    at: string;
    detail?: string;
    errorCode?: string;
    /** Wire id of the `update` / `instance-update` this report belongs to. */
    requestId: string;
  }): Promise<void>;
  noteOutcome(input: {
    serverId: string;
    upgradeId?: string;
    unit: UpgradeStepUnit;
    ok: boolean;
    at: string;
    error?: string;
    errorCode?: string;
    /** Wire id of the `update` / `instance-update` this report belongs to. */
    requestId: string;
  }): Promise<void>;
  updateGate(): Promise<ClientUpdateBlock>;
};

export type UpgradeCoordinatorDeps = {
  store: UpgradeStore;
  enqueue: (
    serverId: string,
    envelope: DaemonOutboundEnvelope,
  ) => Promise<unknown>;
  runtime: UpgradeRuntime;
  channel: UpdateChannel;
  development: boolean;
  now: () => string;
  colocatedServerId: string | null;
  instanceInstalled: { version: string; commit: string | null };
  resolveTarget?: () => Promise<UpgradeTarget>;
};

const ACTIVE = new Set<string>(UPGRADE_STEP_ACTIVE_STATUSES);

function newId(): string {
  return crypto.randomUUID();
}

function admitsFeature(fact: FleetServerFact | undefined): boolean {
  return fact?.features.includes(MANAGED_UPGRADE_FEATURE) === true;
}

export function createUpgradeCoordinator(
  deps: UpgradeCoordinatorDeps,
): UpgradeCoordinator {
  const resolveTarget = deps.resolveTarget ??
    (() => resolveUpgradeTarget(deps.channel));

  async function facts(): Promise<FleetServerFact[]> {
    return await deps.store.fleetFacts(deps.colocatedServerId);
  }

  async function withSteps(
    run: UpgradeRunRow | null,
  ): Promise<(UpgradeRunRow & { steps: UpgradeStepRow[] }) | null> {
    if (!run) return null;
    const steps = await deps.store.stepsFor(run.id);
    return { ...run, steps };
  }

  function rollbackCommand(upgradeId: string): string {
    return controlPlaneRollbackCommand(upgradeId);
  }

  async function buildPreflight(
    target: UpgradeTarget,
    fleet: FleetServerFact[],
    active: UpgradeRunRow | null,
  ): Promise<UpgradePreflight> {
    const checks: UpgradePreflight["checks"] = [];
    const blockers: string[] = [];
    const hasInstance = channelHasInstancePackage(deps.channel);
    const colocated = fleet.find((fact) => fact.colocated);
    checks.push({
      id: "channel",
      label: "Update channel",
      passed: true,
      detail: deps.channel,
    });
    const targetKnown = Boolean(target.daemon?.commit) ||
      (hasInstance && Boolean(target.instance?.commit));
    checks.push({
      id: "target",
      label: "Target build resolved",
      passed: targetKnown,
      detail: target.daemon?.commit ?? target.instance?.commit ?? undefined,
    });
    if (!targetKnown) {
      blockers.push("The channel target could not be resolved.");
    }
    checks.push({
      id: "active",
      label: "No upgrade is already running",
      passed: active === null,
    });
    if (active) blockers.push("An upgrade is already running.");
    const manifestGaps = pinnedManifestBlockers(deps.channel, target, {
      runtime: deps.runtime,
      hasColocated: Boolean(deps.colocatedServerId),
      fleetCount: fleet.filter((fact) => !fact.colocated).length,
    });
    for (const gap of manifestGaps) blockers.push(gap);
    if (deps.runtime === "deno" && !deps.development) {
      const connected = colocated?.connected === true;
      checks.push({
        id: "colocated",
        label: "Co-located daemon is connected",
        passed: connected,
      });
      if (!connected) blockers.push("The co-located daemon is not connected.");
      if (hasInstance) {
        const managed = admitsFeature(colocated);
        checks.push({
          id: "managed-upgrade-v1",
          label: "Co-located daemon can back up and roll back",
          passed: managed,
          detail: managed
            ? undefined
            : daemonOnlyUpdateCommand(target.daemon?.manifestUrl ?? null),
        });
        if (!managed) {
          blockers.push(
            "The co-located daemon does not advertise managed-upgrade-v1. Update only that daemon with a pinned manifest, then start again.",
          );
        }
      }
    }
    const runId = active?.id ?? await ensureReservedRunId(deps.store);
    return {
      ok: true,
      canStart: blockers.length === 0,
      checks,
      runId,
      backupPath: controlPlaneBackupPath(runId),
      recoveryCommand: admitsFeature(colocated) || !hasInstance
        ? rollbackCommand(runId)
        : daemonOnlyUpdateCommand(target.daemon?.manifestUrl ?? null),
      blockers,
    };
  }

  async function dispatchStep(
    run: UpgradeRunRow,
    step: UpgradeStepRow,
    fact: FleetServerFact | undefined,
  ): Promise<void> {
    const envelope = envelopeFor(run, step, fact);
    await deps.enqueue(step.serverId, envelope);
    step.status = "dispatched";
    step.attempts += 1;
    step.requestId = envelope.requestId;
    step.lastStageAt = deps.now();
    step.nextAttemptAt = null;
    await deps.store.saveStep(step);
  }

  function envelopeFor(
    run: UpgradeRunRow,
    step: UpgradeStepRow,
    fact: FleetServerFact | undefined,
  ): DaemonOutboundEnvelope {
    const at = deps.now();
    const managed = admitsFeature(fact);
    if (step.unit === "instance") {
      const pin = unitTarget(run.target, "instance");
      const ui = run.target.ui;
      return {
        kind: "instance-update",
        deliveryId: generateDeliveryId(),
        requestId: generateRequestId(),
        at,
        channel: deps.channel,
        upgradeId: run.id,
        ...(pin?.manifestUrl ? { manifestUrl: pin.manifestUrl } : {}),
        ...(ui?.manifestUrl ? { uiManifestUrl: ui.manifestUrl } : {}),
        ...(pin?.version ? { targetVersion: pin.version } : {}),
        ...(pin?.commit ? { targetCommit: pin.commit } : {}),
      };
    }
    const pin = unitTarget(run.target, "daemon");
    return {
      kind: "update",
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
    };
  }

  async function saveStepIfChanged(
    step: UpgradeStepRow,
    before: string,
  ): Promise<boolean> {
    if (stepPersistKey(step) === before) return false;
    await deps.store.saveStep(step);
    return true;
  }

  async function applyAction(
    run: UpgradeRunRow,
    step: UpgradeStepRow,
    action: StepAction,
    fact: FleetServerFact | undefined,
    queue: UpgradeStepRow[],
  ): Promise<boolean> {
    if (action.kind === "none") return false;
    const before = stepPersistKey(step);
    if (action.kind === "done") {
      step.status = "done";
      step.lastStageAt = deps.now();
      return await saveStepIfChanged(step, before);
    }
    if (action.kind === "wait_offline") {
      step.status = "waiting";
      return await saveStepIfChanged(step, before);
    }
    if (action.kind === "needs_attention") {
      step.status = "needs_attention";
      step.errorCode = action.errorCode;
      return await saveStepIfChanged(step, before);
    }
    if (action.kind === "retry") {
      step.status = "pending";
      step.nextAttemptAt = action.nextAttemptAt;
      return await saveStepIfChanged(step, before);
    }
    if (step.unit === "instance" && !admitsFeature(fact)) {
      step.status = "needs_attention";
      step.errorCode = "managed_upgrade_required";
      step.errorMessage = daemonOnlyUpdateCommand(
        unitTarget(run.target, "daemon")?.manifestUrl ?? null,
      );
      return await saveStepIfChanged(step, before);
    }
    queue.push(step);
    return false;
  }

  async function advance(
    run: UpgradeRunRow,
    steps: UpgradeStepRow[],
    fleet: FleetServerFact[],
  ): Promise<void> {
    const gateOpen = isFleetGateSatisfied({
      development: deps.development,
      runtime: deps.runtime,
      channelHasInstancePackage: channelHasInstancePackage(deps.channel),
      colocatedDaemonOnTarget: isOnTarget(
        installedOf(fleet.find((fact) => fact.colocated)),
        run.target.daemon,
      ),
      controlPlaneOnTarget: isOnTarget(
        {
          version: deps.instanceInstalled.version,
          commit: deps.instanceInstalled.commit,
        },
        run.target.instance,
      ),
    });
    const batch = activeBatchIndex(
      steps.map((step) => ({
        batchIndex: step.batchIndex,
        status: step.status,
      })),
    );
    const currentPhase = earliestOpenPhase(steps);
    const candidateIds = steps.filter((step) =>
      stepInCurrentWave(step, currentPhase, gateOpen, batch)
    ).map((step) => step.serverId);
    const probeIds = fleetCellProbeIds(deps.colocatedServerId, candidateIds);
    const fleetView = await overlayProbes(
      fleet,
      probeIds.length === 0
        ? new Map()
        : await deps.store.probeCandidates(probeIds),
    );
    const queue: UpgradeStepRow[] = [];
    for (const step of steps) {
      if (isTerminal(step.status)) continue;
      if (step.phase === "fleet" && !gateOpen) continue;
      if (currentPhase && step.phase !== currentPhase) continue;
      if (
        batch !== null && step.batchIndex !== batch && step.phase === "fleet"
      ) {
        continue;
      }
      const fact = fleetView.find((item) => item.serverId === step.serverId);
      const action = planStepAction(
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
        { now: deps.now() },
      );
      await applyAction(run, step, action, fact, queue);
    }
    const capped = capWorkersDispatch(deps.runtime, queue);
    for (const step of capped) {
      const fact = fleetView.find((item) => item.serverId === step.serverId);
      await dispatchStep(run, step, fact);
    }
    if (controlPlaneStepFailed(steps)) {
      run.status = "failed";
      run.error = "control_plane_failed";
      run.finishedAt = deps.now();
      run.counts = summarizeSteps(steps);
      await deps.store.saveRun(run);
      return;
    }
    if (steps.every((step) => isTerminal(step.status))) {
      run.status = finalRunStatus(steps);
      run.finishedAt = deps.now();
      run.counts = summarizeSteps(steps);
      run.phase = null;
      await deps.store.saveRun(run);
      return;
    }
    run.status = "running";
    run.phase = earliestOpenPhase(steps);
    run.counts = summarizeSteps(steps);
    await deps.store.saveRun(run);
  }

  async function advanceWindow(run: UpgradeRunRow): Promise<void> {
    const cursor = await deps.store.readTickCursor(run.id);
    const window = await deps.store.tickWindow(
      run.id,
      cursor,
      UPGRADE_TICK_STEP_BUDGET,
    );
    if (window.controlPlaneFailed) {
      run.status = "failed";
      run.error = "control_plane_failed";
      run.finishedAt = deps.now();
      run.counts = window.counts;
      run.phase = null;
      await deps.store.saveRun(run);
      await deps.store.writeTickCursor(run.id, null);
      return;
    }
    if (window.allTerminal) {
      run.status = finalRunStatusFromSummary(window.counts);
      run.finishedAt = deps.now();
      run.counts = window.counts;
      run.phase = null;
      await deps.store.saveRun(run);
      await deps.store.writeTickCursor(run.id, null);
      return;
    }
    const ids = window.steps.map((step) => step.serverId);
    if (
      deps.colocatedServerId &&
      !ids.includes(deps.colocatedServerId)
    ) {
      ids.push(deps.colocatedServerId);
    }
    const fleet = await deps.store.factsFor(ids, deps.colocatedServerId);
    const gateOpen = isFleetGateSatisfied({
      development: deps.development,
      runtime: deps.runtime,
      channelHasInstancePackage: channelHasInstancePackage(deps.channel),
      colocatedDaemonOnTarget: isOnTarget(
        installedOf(fleet.find((fact) => fact.colocated)),
        run.target.daemon,
      ),
      controlPlaneOnTarget: isOnTarget(
        {
          version: deps.instanceInstalled.version,
          commit: deps.instanceInstalled.commit,
        },
        run.target.instance,
      ),
    });
    const candidateIds = window.steps
      .filter((step) => !isTerminal(step.status))
      .filter((step) => step.phase !== "fleet" || gateOpen)
      .map((step) => step.serverId);
    const probeIds = fleetCellProbeIds(deps.colocatedServerId, candidateIds);
    const fleetView = await overlayProbes(
      fleet,
      probeIds.length === 0
        ? new Map()
        : await deps.store.probeCandidates(probeIds),
    );
    const queue: UpgradeStepRow[] = [];
    let dirty = false;
    for (const step of window.steps) {
      if (isTerminal(step.status)) continue;
      if (step.phase === "fleet" && !gateOpen) continue;
      const fact = fleetView.find((item) => item.serverId === step.serverId);
      const action = planStepAction(
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
        { now: deps.now() },
      );
      if (await applyAction(run, step, action, fact, queue)) dirty = true;
    }
    const capped = capWorkersDispatch(deps.runtime, queue);
    for (const step of capped) {
      const fact = fleetView.find((item) => item.serverId === step.serverId);
      await dispatchStep(run, step, fact);
      dirty = true;
    }
    const counts = dirty ? await deps.store.countSteps(run.id) : window.counts;
    const phase = window.phase;
    if (
      run.status !== "running" || run.phase !== phase ||
      !sameSummary(run.counts, counts)
    ) {
      run.status = "running";
      run.phase = phase;
      run.counts = counts;
      await deps.store.saveRun(run);
    }
    const last = window.steps[window.steps.length - 1];
    const wrapped = window.steps.length < UPGRADE_TICK_STEP_BUDGET;
    if (phase !== null && window.batchIndex !== null) {
      await deps.store.writeTickCursor(run.id, {
        phase,
        batchIndex: window.batchIndex,
        afterId: wrapped || !last ? null : last.id,
      });
    }
  }

  function currentCommit(
    step: UpgradeStepRow,
    fact: FleetServerFact | undefined,
  ): string | null {
    if (step.unit === "instance") return deps.instanceInstalled.commit;
    return fact?.commit ?? null;
  }

  return {
    preflight: async () => {
      const [target, fleet, active] = await Promise.all([
        resolveTarget(),
        facts(),
        deps.store.activeRun(),
      ]);
      return await buildPreflight(target, fleet, active);
    },
    start: async (input) => {
      const [target, fleet, active, settings] = await Promise.all([
        resolveTarget(),
        facts(),
        deps.store.activeRun(),
        deps.store.settings(),
      ]);
      const preflight = await buildPreflight(target, fleet, active);
      if (!preflight.canStart) {
        return {
          ok: false,
          error: preflight.blockers[0] ?? "preflight_failed",
          blockers: preflight.blockers,
        };
      }
      const plan = input.serverId
        ? planSingleServer(input.serverId)
        : planUpgrade({
          runtime: input.fleetServerIds ? "workers" : deps.runtime,
          channelHasInstancePackage: input.fleetServerIds
            ? false
            : channelHasInstancePackage(deps.channel),
          colocatedServerId: input.fleetServerIds
            ? null
            : deps.colocatedServerId,
          fleetServerIds: input.fleetServerIds ??
            fleet.filter((fact) => !fact.colocated).map((fact) =>
              fact.serverId
            ),
          batch: settings.batch,
        });
      const now = deps.now();
      const requested = input.runId?.trim() ?? "";
      const reserved = await deps.store.reservedRunId();
      const runId = isUpgradeRunId(requested)
        ? requested
        : (reserved ?? newId());
      const run: UpgradeRunRow = {
        id: runId,
        createdAt: now,
        source: input.source,
        channel: deps.channel,
        status: "pending",
        phase: earliestOpenPhase(
          plan.steps.map((step) => ({ phase: step.phase, status: "pending" })),
        ),
        startedBy: input.startedBy,
        startedByEmail: null,
        target,
        batchPolicy: settings.batch,
        counts: null,
        error: null,
        startedAt: now,
        finishedAt: null,
      };
      const steps = plan.steps.map((planned) =>
        stepFromPlan(run, planned, fleet, now, deps.instanceInstalled.commit)
      );
      run.phase = earliestOpenPhase(steps);
      const inserted = await deps.store.insertRun(run, steps);
      if (inserted === "active") {
        return { ok: false, error: "An upgrade is already running." };
      }
      await deps.store.clearReservedRunId();
      const stored = await deps.store.stepsFor(run.id);
      run.phase = earliestOpenPhase(stored);
      await advance(run, stored, fleet);
      return { ok: true, runId: run.id };
    },
    tick: async (input) => {
      if (input?.resolveManifests !== false) {
        const target = await resolveTarget();
        await deps.store.saveLatestBuild(target);
        const [settings, active] = await Promise.all([
          deps.store.settings(),
          deps.store.activeRun(),
        ]);
        const daemonCommit = target.daemon?.commit ?? null;
        const daemonDrift = daemonCommit
          ? await deps.store.anyDaemonBehind(daemonCommit)
          : false;
        const differs = daemonDrift || differsFromInstalled(
          {
            version: deps.instanceInstalled.version,
            commit: deps.instanceInstalled.commit,
          },
          target.instance,
        );
        if (
          shouldAutoStartRun({
            runtime: deps.runtime,
            settings,
            now: new Date(deps.now()),
            targetDiffers: differs,
            runActive: active !== null,
          })
        ) {
          await createUpgradeCoordinator(deps).start({
            source: "auto",
            startedBy: null,
          });
        }
      }
      const active = await deps.store.activeRun();
      if (!active) return;
      await advanceWindow(active);
    },
    activeRun: async () => withSteps(await deps.store.activeRun()),
    run: async (id) => withSteps(await deps.store.runById(id)),
    history: (offset, limit) => deps.store.history(offset, limit),
    servers: async ({ offset, limit, status }) => {
      const [target, active] = await Promise.all([
        deps.store.latestBuild(),
        deps.store.activeRun(),
      ]);
      const page = await deps.store.pageFleet({
        offset,
        limit,
        status,
        targetCommit: target?.daemon?.commit ?? null,
      }, deps.colocatedServerId);
      const steps = active ? await deps.store.stepsFor(active.id) : [];
      const onPage = new Set(page.facts.map((fact) => fact.serverId));
      const pageSteps = steps.filter((step) => onPage.has(step.serverId));
      return {
        total: page.total,
        servers: page.facts.map((fact) =>
          serverPageRow(fact, pageSteps, target)
        ),
      };
    },
    settings: () => deps.store.settings(),
    saveSettings: (settings) => deps.store.saveSettings(settings),
    cancel: async (runId) => {
      const run = await deps.store.runById(runId);
      if (!run) return { ok: false, error: "upgrade_run_not_found" };
      if (run.status !== "pending" && run.status !== "running") {
        return { ok: false, error: "upgrade_not_active" };
      }
      const steps = await deps.store.stepsFor(run.id);
      for (const step of steps) {
        if (isTerminal(step.status)) continue;
        step.status = "skipped";
        await deps.store.saveStep(step);
      }
      run.status = "cancelled";
      run.finishedAt = deps.now();
      run.counts = summarizeSteps(steps);
      await deps.store.saveRun(run);
      return { ok: true };
    },
    retry: async (stepId) => {
      const active = await deps.store.activeRun();
      if (!active) return { ok: false, error: "upgrade_not_active" };
      const steps = await deps.store.stepsFor(active.id);
      const step = steps.find((item) => item.id === stepId);
      if (!step) return { ok: false, error: "upgrade_step_not_found" };
      if (
        step.status !== "needs_attention" && step.status !== "failed" &&
        step.status !== "rolled_back"
      ) {
        return { ok: false, error: "upgrade_step_not_retryable" };
      }
      step.status = "pending";
      step.nextAttemptAt = null;
      step.errorCode = null;
      step.errorMessage = null;
      await deps.store.saveStep(step);
      const fleet = await facts();
      await advance(active, steps, fleet);
      return { ok: true };
    },
    noteDaemonCommit: async (serverId, commit, at) => {
      const active = await deps.store.activeRun();
      if (!active) return;
      const steps = await deps.store.stepsFor(active.id);
      const step = steps.find((item) =>
        item.serverId === serverId && item.unit === "daemon" &&
        item.toCommit === commit && !isTerminal(item.status)
      );
      if (!step) return;
      step.status = "done";
      step.lastStageAt = at;
      await deps.store.saveStep(step);
    },
    noteProgress: async (input) => {
      const step = await findOpenStep(
        deps.store,
        input.serverId,
        input.unit,
        input.upgradeId,
      );
      if (!step || !reportMatchesStep(step, input.requestId)) return;
      const status = stepStatusForProgressStage(input.stage);
      step.status = status;
      step.lastStageAt = input.at;
      if (input.errorCode) step.errorCode = input.errorCode;
      if (input.detail) {
        step.detail = {
          ...(typeof step.detail === "object" && step.detail !== null
            ? step.detail
            : {}),
          phase: step.phase,
          progressDetail: input.detail,
        };
        if (isProgressTerminal(status) && status !== "done") {
          step.errorMessage = input.detail;
        }
      }
      await deps.store.saveStep(step);
    },
    updateGate: async () => {
      const [target, fleet] = await Promise.all([resolveTarget(), facts()]);
      const open = isFleetGateSatisfied({
        development: deps.development,
        runtime: deps.runtime,
        channelHasInstancePackage: channelHasInstancePackage(deps.channel),
        colocatedDaemonOnTarget: isOnTarget(
          installedOf(fleet.find((fact) => fact.colocated)),
          target.daemon,
        ),
        controlPlaneOnTarget: isOnTarget(
          {
            version: deps.instanceInstalled.version,
            commit: deps.instanceInstalled.commit,
          },
          target.instance,
        ),
      });
      return clientUpdateBlock({
        runtime: deps.runtime,
        development: deps.development,
        targetCommitKnown: Boolean(target.daemon?.commit),
        gateOpen: open,
      });
    },
    noteOutcome: async (input) => {
      const step = await findOpenStep(
        deps.store,
        input.serverId,
        input.unit,
        input.upgradeId,
      );
      if (!step || !reportMatchesStep(step, input.requestId)) return;
      if (input.ok) {
        step.lastStageAt = input.at;
        if (step.unit === "instance") {
          step.status = "done";
        }
      } else if (input.errorCode === "rolled_back") {
        step.status = "rolled_back";
        step.errorCode = input.errorCode;
        step.errorMessage = input.error ?? null;
        step.lastStageAt = input.at;
      } else {
        step.status = "failed";
        step.errorCode = input.errorCode ?? "update_failed";
        step.errorMessage = input.error ?? null;
        step.lastStageAt = input.at;
      }
      await deps.store.saveStep(step);
    },
  };
}

async function ensureReservedRunId(store: UpgradeStore): Promise<string> {
  const existing = await store.reservedRunId();
  if (existing && isUpgradeRunId(existing)) return existing;
  const id = newId();
  await store.reserveRunId(id);
  return id;
}

function stepInCurrentWave(
  step: UpgradeStepRow,
  currentPhase: UpgradePhase | null,
  gateOpen: boolean,
  batch: number | null,
): boolean {
  if (isTerminal(step.status)) return false;
  if (step.phase === "fleet" && !gateOpen) return false;
  if (currentPhase && step.phase !== currentPhase) return false;
  if (batch !== null && step.batchIndex !== batch && step.phase === "fleet") {
    return false;
  }
  return true;
}

function overlayProbes(
  fleet: FleetServerFact[],
  probes: Map<string, FleetProbe>,
): FleetServerFact[] {
  if (probes.size === 0) return fleet;
  return fleet.map((fact) => {
    const probed = probes.get(fact.serverId);
    if (!probed) return fact;
    return {
      ...fact,
      connected: probed.connected,
      commit: probed.commit ?? fact.commit,
      version: probed.version ?? fact.version,
    };
  });
}

function installedOf(fact: FleetServerFact | undefined) {
  return { version: fact?.version ?? null, commit: fact?.commit ?? null };
}

function isTerminal(status: string): boolean {
  return status === "done" || status === "skipped" || status === "failed" ||
    status === "needs_attention";
}

function stepPersistKey(step: UpgradeStepRow): string {
  return [
    step.status,
    step.requestId ?? "",
    String(step.attempts),
    step.nextAttemptAt ?? "",
    step.lastStageAt ?? "",
    step.errorCode ?? "",
    step.errorMessage ?? "",
  ].join("\0");
}

function sameSummary(left: StepSummary | null, right: StepSummary): boolean {
  if (!left) return false;
  return left.total === right.total && left.done === right.done &&
    left.skipped === right.skipped && left.failed === right.failed &&
    left.needsAttention === right.needsAttention &&
    left.inProgress === right.inProgress;
}

/** Progress and outcome frames name one dispatch. A later attempt wins. */
function reportMatchesStep(step: UpgradeStepRow, requestId: string): boolean {
  return step.requestId !== null && step.requestId === requestId;
}

function stepFromPlan(
  run: UpgradeRunRow,
  planned: PlannedStep,
  fleet: FleetServerFact[],
  now: string,
  instanceCommit: string | null,
): UpgradeStepRow {
  const fact = fleet.find((item) => item.serverId === planned.serverId);
  const pin = unitTarget(run.target, planned.unit);
  const satisfied = stepSatisfiedByInstalled(planned, {
    daemonCommit: fact?.commit ?? null,
    instanceCommit: instanceCommit,
  }, run.target);
  return {
    id: newId(),
    upgradeId: run.id,
    serverId: planned.serverId,
    unit: planned.unit,
    phase: planned.phase,
    batchIndex: planned.batchIndex,
    status: satisfied ? "done" : "pending",
    requestId: null,
    attempts: 0,
    nextAttemptAt: null,
    fromVersion: fact?.version ?? null,
    toVersion: pin?.version ?? null,
    fromCommit: planned.unit === "instance" ? null : fact?.commit ?? null,
    toCommit: pin?.commit ?? null,
    lastStageAt: now,
    errorCode: null,
    errorMessage: null,
    detail: { phase: planned.phase },
  };
}

async function findOpenStep(
  store: UpgradeStore,
  serverId: string,
  unit: UpgradeStepUnit,
  upgradeId?: string,
): Promise<UpgradeStepRow | null> {
  const active = await store.activeRun();
  if (!active) return null;
  if (upgradeId && active.id !== upgradeId) return null;
  const steps = await store.stepsFor(active.id);
  return steps.find((step) =>
    step.serverId === serverId && step.unit === unit &&
    (ACTIVE.has(step.status) || step.status === "rolled_back")
  ) ?? null;
}

function serverPageRow(
  fact: FleetServerFact,
  steps: readonly UpgradeStepRow[],
  target: UpgradeTarget | null,
): UpgradeStepRow & {
  updateAvailable?: boolean;
  installedVersion?: string | null;
  installedCommit?: string | null;
  serverName?: string | null;
  hostname?: string | null;
  connected?: boolean;
} {
  const live = steps.find((step) =>
    step.serverId === fact.serverId && step.unit === "daemon"
  );
  const pin = target?.daemon ?? null;
  if (live) {
    return {
      ...live,
      serverName: fact.name,
      hostname: fact.hostname,
      connected: fact.connected,
      installedVersion: fact.version,
      installedCommit: fact.commit,
      updateAvailable: differsFromInstalled(installedOf(fact), pin),
    };
  }
  const onTarget = isOnTarget(installedOf(fact), pin);
  return {
    id: fact.serverId,
    upgradeId: "",
    serverId: fact.serverId,
    serverName: fact.name,
    hostname: fact.hostname,
    connected: fact.connected,
    unit: "daemon",
    phase: "fleet",
    batchIndex: 0,
    status: onTarget ? "done" : "pending",
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
  };
}
