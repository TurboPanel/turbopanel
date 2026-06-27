import type { Db } from "../../db.ts";
import { server } from "../../lib/db/schema.ts";
import type { DaemonCellRegistry, PendingRequestRecord } from "./contracts.ts";
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
} from "./protocol.ts";

export type CommandResult = {
  id: string;
  daemonId: string;
  command: string;
  status: "pending" | "done";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  sentAt: string;
  finishedAt?: string;
};

function nowTs(): string {
  return new Date().toISOString();
}

export async function listFleetServerIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: server.id })
    .from(server);
  return rows.map((row) => row.id);
}

function requestToCommandResult(record: PendingRequestRecord): CommandResult {
  const result = record.result as {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  } | undefined;

  return {
    id: record.requestId,
    daemonId: record.serverId,
    command: record.command ?? "",
    status: record.status === "done" ? "done" : "pending",
    exitCode: result?.exitCode,
    stdout: result?.stdout,
    stderr: result?.stderr,
    sentAt: record.createdAt,
    finishedAt: record.finishedAt,
  };
}

export async function collectFleetCommands(
  registry: DaemonCellRegistry,
  serverIds: string[],
  limit: number,
): Promise<CommandResult[]> {
  const perServerLimit = Math.max(limit, 50);
  const allCommands: CommandResult[] = [];

  await Promise.all(
    serverIds.map(async (serverId) => {
      const records = await registry.getCell(serverId).listRequests(
        perServerLimit,
        { requestKind: "command" },
      );
      allCommands.push(...records.map(requestToCommandResult));
    }),
  );

  allCommands.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  return allCommands.slice(-limit);
}

function echoEnvelope(payload: unknown): DaemonOutboundEnvelope {
  return {
    kind: "echo",
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    at: nowTs(),
    payload,
  };
}

export async function enqueueEchoToServer(
  registry: DaemonCellRegistry,
  serverId: string,
  payload: unknown,
): Promise<void> {
  const envelope = echoEnvelope(payload);
  await registry.getCell(serverId).enqueue(envelope);
}

export async function broadcastEchoToFleet(
  registry: DaemonCellRegistry,
  onlineServerIds: string[],
  payload: unknown,
): Promise<number> {
  let sent = 0;
  await Promise.all(
    onlineServerIds.map(async (serverId) => {
      try {
        await enqueueEchoToServer(registry, serverId, payload);
        sent++;
      } catch {
        // Skip servers that fail to enqueue.
      }
    }),
  );

  return sent;
}
