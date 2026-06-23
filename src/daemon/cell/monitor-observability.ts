import { compatLogInfo } from "../../log-compat.ts";

export type MonitorCounterName =
  | "monitorMessagesAccepted"
  | "monitorFullSync"
  | "monitorDeltaHeartbeat"
  | "resourceTransitions"
  | "offlineTransitions"
  | "notificationCandidatesEmitted"
  | "notificationDeliveries"
  | "postgresProjectionsWritten";

const counters: Record<MonitorCounterName, number> = {
  monitorMessagesAccepted: 0,
  monitorFullSync: 0,
  monitorDeltaHeartbeat: 0,
  resourceTransitions: 0,
  offlineTransitions: 0,
  notificationCandidatesEmitted: 0,
  notificationDeliveries: 0,
  postgresProjectionsWritten: 0,
};

let lastLoggedAt = 0;
const LOG_INTERVAL_MS = 60_000;

export function incrementMonitorCounter(
  name: MonitorCounterName,
  amount = 1,
): void {
  counters[name] += amount;
  maybeLogCounters();
}

export function readMonitorCounters(): Readonly<
  Record<MonitorCounterName, number>
> {
  return { ...counters };
}

export function resetMonitorCountersForTests(): void {
  for (const key of Object.keys(counters) as MonitorCounterName[]) {
    counters[key] = 0;
  }
  lastLoggedAt = 0;
}

function maybeLogCounters(): void {
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) return;
  lastLoggedAt = now;
  compatLogInfo(
    "monitor-metrics",
    `counters accepted=${counters.monitorMessagesAccepted} fullSync=${counters.monitorFullSync} deltaHb=${counters.monitorDeltaHeartbeat} transitions=${counters.resourceTransitions} offline=${counters.offlineTransitions} candidates=${counters.notificationCandidatesEmitted} deliveries=${counters.notificationDeliveries} projections=${counters.postgresProjectionsWritten}`,
  );
}

export function logMonitorCountersNow(): void {
  lastLoggedAt = Date.now();
  compatLogInfo(
    "monitor-metrics",
    `snapshot accepted=${counters.monitorMessagesAccepted} fullSync=${counters.monitorFullSync} deltaHb=${counters.monitorDeltaHeartbeat} transitions=${counters.resourceTransitions} offline=${counters.offlineTransitions} candidates=${counters.notificationCandidatesEmitted} deliveries=${counters.notificationDeliveries} projections=${counters.postgresProjectionsWritten}`,
  );
}
