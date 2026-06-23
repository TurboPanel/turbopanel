import { compatLogInfo } from "../../log-compat.ts";
import type { Db } from "../../db.ts";
import type { DaemonCellRegistry, MonitorAlertRow } from "./contracts.ts";
import { incrementMonitorCounter } from "./monitor-observability.ts";
import { projectServerDaemon } from "./postgres-projection.ts";

export type NotificationDeliveryRecord = {
  serverId: string;
  resourceKey: string;
  status: string;
  openedAt: string;
  deliveredAt: string;
  recovery: boolean;
};

function sanitizeForLog(value: string): string {
  return value.replaceAll("\n", "_").slice(0, 200);
}

async function deliverAlert(
  alert: MonitorAlertRow,
  recovery: boolean,
): Promise<NotificationDeliveryRecord> {
  const deliveredAt = new Date().toISOString();
  const record: NotificationDeliveryRecord = {
    serverId: alert.serverId,
    resourceKey: alert.resourceKey,
    status: alert.status,
    openedAt: alert.openedAt,
    deliveredAt,
    recovery,
  };

  compatLogInfo(
    "monitor-notify",
    `deliver serverId=${sanitizeForLog(alert.serverId)} resource=${
      sanitizeForLog(alert.resourceKey)
    } status=${alert.status} recovery=${recovery}`,
  );
  incrementMonitorCounter("notificationDeliveries");
  return record;
}

/**
 * Drain cell notification candidates and perform control-plane delivery.
 * Recoveries resolve open alerts inside the cell; this drains newly opened/re-notified candidates.
 */
export async function drainAndDeliverNotifications(
  registry: DaemonCellRegistry,
  serverIds: string[],
): Promise<NotificationDeliveryRecord[]> {
  const deliveries: NotificationDeliveryRecord[] = [];

  await Promise.all(
    serverIds.map(async (serverId) => {
      const candidates = await registry
        .getCell(serverId)
        .drainNotificationCandidates(serverId);
      if (candidates.length === 0) return;

      incrementMonitorCounter(
        "notificationCandidatesEmitted",
        candidates.length,
      );

      for (const alert of candidates) {
        deliveries.push(await deliverAlert(alert, false));
      }
    }),
  );

  return deliveries;
}

export async function deliverMonitorAlerts(
  alerts: MonitorAlertRow[],
): Promise<NotificationDeliveryRecord[]> {
  if (alerts.length === 0) return [];
  incrementMonitorCounter("notificationCandidatesEmitted", alerts.length);
  return Promise.all(alerts.map((alert) => deliverAlert(alert, false)));
}

export async function runControlPlaneMaintenance(
  db: Db,
  registry: DaemonCellRegistry,
  extraServerIds: string[] = [],
): Promise<void> {
  const onlineIds = await registry.listOnlineServerIds();
  const serverIds = [...new Set([...onlineIds, ...extraServerIds])];
  if (serverIds.length === 0) return;

  await drainAndDeliverNotifications(registry, serverIds);

  await Promise.all(
    serverIds.map(async (serverId) => {
      const cell = registry.getCell(serverId);
      await projectServerDaemon(db, serverId, { kind: "summary_refresh" }, {
        cell,
      });
    }),
  );
}
