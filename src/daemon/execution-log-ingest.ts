/**
 * Body parsing and ownership lookup for `POST /commands/:commandId/log`.
 *
 * Kept beside the route rather than inside it so the parsing rules stay
 * unit-testable without a Hono context or a live database, matching
 * `commands-routes-helpers.ts` on the client side.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db.ts";
import { command } from "../lib/db/schema.ts";
import {
  MAX_EXECUTION_LOG_CHUNK_BYTES,
} from "../lib/execution-logs/types.ts";
import { TERMINAL_COMMAND_STATUSES } from "../lib/commands/types.ts";

/**
 * Whole-request byte budget, read (and aborted) before JSON parsing. Sized as
 * the per-chunk cap plus base64 expansion (4/3) and JSON quoting overhead.
 */
export const MAX_EXECUTION_LOG_CHUNK_BODY_BYTES = 512 * 1024;

export type ExecutionLogChunkBodyResult =
  | { ok: true; seq: number; bytes: Uint8Array }
  | { ok: false; error: string };

/** Decode standard base64 without pulling a Deno-only std module into the Workers bundle. */
function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.codePointAt(index)!;
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Validate `{ seq, bytes }` where `bytes` is standard base64. */
export function parseExecutionLogChunkBody(
  body: unknown,
): ExecutionLogChunkBodyResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "invalid chunk" };
  }
  const record = body as { seq?: unknown; bytes?: unknown };
  if (!Number.isInteger(record.seq) || (record.seq as number) < 0) {
    return { ok: false, error: "seq must be a non-negative integer" };
  }
  if (typeof record.bytes !== "string") {
    return { ok: false, error: "bytes must be base64" };
  }
  const decoded = decodeBase64(record.bytes);
  if (!decoded) {
    return { ok: false, error: "bytes must be base64" };
  }
  if (decoded.byteLength > MAX_EXECUTION_LOG_CHUNK_BYTES) {
    return { ok: false, error: "chunk too large" };
  }
  return { ok: true, seq: record.seq as number, bytes: decoded };
}

export type ExecutionLogCommandTarget = {
  serverId: string;
  status: string;
  terminal: boolean;
};

/**
 * Minimal command lookup for the ingest route: who owns it, and whether it has
 * already reached a terminal status. Never selects the dispatch payload.
 */
export async function loadExecutionLogCommandTarget(
  db: Db,
  commandId: string,
): Promise<ExecutionLogCommandTarget | null> {
  const rows = await db
    .select({ serverId: command.serverId, status: command.status })
    .from(command)
    .where(eq(command.id, commandId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    serverId: row.serverId,
    status: row.status,
    terminal: TERMINAL_COMMAND_STATUSES.has(
      row.status as Parameters<typeof TERMINAL_COMMAND_STATUSES.has>[0],
    ),
  };
}
