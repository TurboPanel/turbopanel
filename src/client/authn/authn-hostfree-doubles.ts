import type { Db } from "../../db/connection.ts";
import {
  account,
  grant,
  license,
  organization,
  passkey,
  session,
  setting,
  team,
  teammate,
  twoFactor,
  user,
  verification,
  workspace,
} from "../../db/schema.ts";
import type { OtpType } from "../../features/email/types.ts";
import { deriveOtpVerifier, hashEmailForOtp } from "./email-otp.ts";
import type { DerivedSecretsConfig } from "../../lib/secrets/secrets.ts";
import { IS_SIGNUP_ENABLED_CONFIG_KEY } from "./install-state.ts";
import { SUPERADMIN_ROLE } from "./session-store.ts";
import type { SessionData } from "./session-store.ts";
import { rowMatchesWhere } from "../../test-fixtures/memory-db.ts";

export async function readJsonBody<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new TypeError("expected JSON object body");
  }
  return body as T;
}

export type MockCredentialUser = {
  id: string;
  email: string;
  password: string;
  isDisabled?: boolean;
  isEmailVerified?: boolean;
};

export type MockAuthUser = {
  id: string;
  email: string;
  isDisabled: boolean;
  isEmailVerified: boolean;
  is2FaEnabled?: boolean;
  role: string;
  displayName?: string | null;
};

type MockAuthStateInternal = MockAuthState & {
  lastLogin?: string;
  inTransaction?: boolean;
  verificationSelectPhase?: number;
  verificationDeletePhase?: number;
  lastVerificationInsert?: Record<string, unknown>;
};

export type MockAuthState = {
  sessions: Map<string, SessionData>;
  credentials: Map<string, MockCredentialUser>;
  users: MockAuthUser[];
  accounts: Array<{
    userId: string;
    password: string | null;
    providerId: string;
    providerUserId: string;
  }>;
  organizations: Array<
    { id: string; name: string | null; options?: unknown }
  >;
  settings: Map<string, string>;
  licenses: Array<{
    id: string;
    organizationId: string;
    name: string | null;
    token: string;
    revokedAt: string | null;
    serverId: string | null;
    createdAt: string;
  }>;
  verificationRows: Array<{
    id: string;
    identifier: string;
    value: string;
    expiresAt: string;
    createdAt?: string;
  }>;
  insertedSessions: Array<Record<string, unknown>>;
  twoFactorRows: Array<{
    id: string;
    userId: string;
    secret: string;
    isVerified: boolean;
    backupCodes: string;
  }>;
  passkeys: Array<{
    id: string;
    userId: string;
    name: string | null;
    createdAt: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    deviceType: string;
    isBackedUp: boolean;
    aaguid: string | null;
    transports: string | null;
  }>;
};

type Row = Record<string, unknown>;

export function createEmptyMockAuthState(): MockAuthState {
  return {
    sessions: new Map(),
    credentials: new Map(),
    users: [],
    accounts: [],
    organizations: [],
    settings: new Map(),
    licenses: [],
    verificationRows: [],
    insertedSessions: [],
    twoFactorRows: [],
    passkeys: [],
  };
}

function isExpired(iso: string): boolean {
  return iso <= new Date().toISOString();
}

/**
 * Coerce an unknown value to string without Object's default
 * `[object Object]` stringification (`typescript:S6551`).
 */
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function otpIdentifier(type: OtpType, emailHash: string): string {
  return `otp:${type}:${emailHash}`;
}

function attemptsIdentifier(type: OtpType, emailHash: string): string {
  return `otp-attempts:${type}:${emailHash}`;
}

function selectCredentialRow(state: MockAuthState, login: string) {
  const key = login.trim().toLowerCase();
  for (const row of state.credentials.values()) {
    if (row.email === key) {
      return {
        userId: row.id,
        email: row.email,
        password: row.password,
        isDisabled: row.isDisabled ?? false,
        isEmailVerified: row.isEmailVerified ?? true,
        is2FaEnabled: state.users.find((u) =>
          u.id === row.id
        )?.is2FaEnabled === true,
      };
    }
  }
  for (const row of state.users) {
    if (row.email !== key) continue;
    const accountRow = state.accounts.find((a) => a.userId === row.id);
    if (!accountRow) continue;
    return {
      userId: row.id,
      email: row.email,
      password: accountRow.password,
      isDisabled: row.isDisabled,
      isEmailVerified: row.isEmailVerified,
      is2FaEnabled: row.is2FaEnabled === true,
    };
  }
  return null;
}

function mapVerificationRows(
  state: MockAuthStateInternal,
  limit: number,
  inTx: boolean,
) {
  const rows = inTx
    ? state.verificationRows
    : state.verificationRows.filter((row) => !isExpired(row.expiresAt));
  if (inTx) {
    const hasOtp = rows.some((row) =>
      row.identifier.startsWith("otp:") ||
      row.identifier.startsWith("otp-attempts:")
    );
    if (!hasOtp) {
      return rows
        .filter((row) => row.identifier.startsWith("2fa-attempts:"))
        .slice(0, limit);
    }
    state.verificationSelectPhase = (state.verificationSelectPhase ?? 0) + 1;
    if (state.verificationSelectPhase === 1) {
      return rows
        .filter((row) =>
          row.identifier.startsWith("otp:") &&
          !row.identifier.startsWith("otp-attempts:")
        )
        .slice(0, limit);
    }
    if (state.verificationSelectPhase === 2) {
      return rows
        .filter((row) => row.identifier.startsWith("otp-attempts:"))
        .slice(0, limit);
    }
  }
  return rows.slice(0, limit);
}

/** Drizzle-shaped thenable: awaitable directly and via `.limit()` / `.for().limit()`. */
function thenableRows(
  fetchRows: () => Promise<Row[]>,
): Promise<Row[]> & {
  limit: (n: number) => Promise<Row[]>;
  for: (lock: string) => { limit: (n: number) => Promise<Row[]> };
} {
  const promise = fetchRows();
  const limited = (n: number) => promise.then((rows) => rows.slice(0, n));
  return Object.assign(promise, {
    limit: limited,
    for: (_lock: string) => ({ limit: limited }),
  });
}

function mapLicenseRows(state: MockAuthState, activeOnly: boolean) {
  return state.licenses
    .filter((row) => !activeOnly || row.revokedAt === null)
    .map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      createdAt: row.createdAt,
      token: row.token,
      licenseId: row.id,
      serverId: row.serverId,
    }));
}

function fetchInnerJoinRows(
  state: MockAuthState,
  table: unknown,
): Promise<Row[]> {
  if (table === session) {
    const entries = [...state.sessions.entries()];
    if (entries.length === 0) return Promise.resolve([]);
    // Map iteration is insertion order; hostfree selects ignore WHERE, so
    // return the newest session (the cookie the current test just minted).
    const [, data] = entries.at(-1)!;
    return Promise.resolve([{
      sessionId: data.sessionId,
      userId: data.userId,
      email: data.email,
      role: data.role,
      isDisabled: false,
      createdAt: data.createdAt ?? new Date().toISOString(),
    }]);
  }
  if (table === license) {
    return Promise.resolve(
      mapLicenseRows(state, false)
        .filter((row) => row.serverId !== null)
        .map((row) => ({
          licenseId: row.id,
          id: row.serverId as string,
          name: row.name,
        })),
    );
  }
  return Promise.resolve([]);
}

function fetchWhereRows(
  state: MockAuthState,
  internal: MockAuthStateInternal,
  table: unknown,
): Promise<Row[]> {
  if (table === user) {
    return Promise.resolve(state.users.map((row) => ({
      id: row.id,
      isDisabled: row.isDisabled,
      isEmailVerified: row.isEmailVerified,
      email: row.email,
      role: row.role,
      is2FaEnabled: row.is2FaEnabled === true,
    })));
  }
  if (table === organization) {
    return Promise.resolve(
      state.organizations
        .filter((row) => row.name !== null)
        .map((row) => ({ id: row.id, options: row.options ?? null })),
    );
  }
  if (table === license) {
    return Promise.resolve(
      mapLicenseRows(state, true).map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        name: row.name,
        createdAt: row.createdAt,
        token: row.token,
      })),
    );
  }
  if (table === setting) {
    return Promise.resolve(
      [...state.settings.entries()].map(([key, value]) => ({ key, value })),
    );
  }
  if (table === verification) {
    const rows = mapVerificationRows(internal, Number.MAX_SAFE_INTEGER, false);
    return Promise.resolve(rows.map((row) => ({
      id: row.id,
      identifier: row.identifier,
      value: row.value,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt ?? row.expiresAt,
    })));
  }
  if (table === account) {
    return Promise.resolve(
      state.accounts.map((row) => ({
        id: row.userId,
        userId: row.userId,
        providerId: row.providerId,
        providerUserId: row.providerUserId,
        password: row.password,
      })),
    );
  }
  if (table === twoFactor) {
    return Promise.resolve(
      state.twoFactorRows.map((row) => ({
        id: row.id,
        userId: row.userId,
        secret: row.secret,
        isVerified: row.isVerified,
        backupCodes: row.backupCodes,
      })),
    );
  }
  if (table === passkey) {
    return Promise.resolve(
      state.passkeys.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.name,
        createdAt: row.createdAt,
        credentialId: row.credentialId,
        publicKey: row.publicKey,
        counter: row.counter,
        deviceType: row.deviceType,
        isBackedUp: row.isBackedUp,
        aaguid: row.aaguid,
        transports: row.transports,
      })),
    );
  }
  return Promise.resolve([]);
}

function fetchCredentialJoinRows(
  state: MockAuthState,
  internal: MockAuthStateInternal,
  limit: number,
): Promise<Row[]> {
  const login = internal.lastLogin;
  if (!login) return Promise.resolve([]);
  const row = selectCredentialRow(state, login);
  if (!row) return Promise.resolve([]);
  return Promise.resolve([row].slice(0, limit));
}

function fetchVerificationLimited(
  _state: MockAuthState,
  internal: MockAuthStateInternal,
  limit: number,
): Promise<Row[]> {
  const rows = mapVerificationRows(
    internal,
    limit,
    Boolean(internal.inTransaction),
  );
  return Promise.resolve(rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    value: row.value,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt ?? row.expiresAt,
  })));
}

function buildSelectFrom(
  state: MockAuthState,
  internal: MockAuthStateInternal,
  table: unknown,
) {
  const chain = {
    innerJoin: (_other: unknown, _cond: unknown) => ({
      where: (_cond: unknown) =>
        thenableRows(() => fetchInnerJoinRows(state, table)),
    }),
    leftJoin: (_other: unknown, _cond: unknown) => ({
      where: (_cond: unknown) =>
        thenableRows(() => fetchWhereRows(state, internal, table)),
    }),
    where: (_cond: unknown) =>
      thenableRows(() => fetchWhereRows(state, internal, table)),
  };

  if (table === user) {
    return {
      ...chain,
      innerJoin: (_other: unknown, _cond: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (n: number) => fetchCredentialJoinRows(state, internal, n),
        }),
      }),
    };
  }

  if (table === verification) {
    return {
      ...chain,
      where: (_cond: unknown) =>
        thenableRows(() =>
          fetchVerificationLimited(state, internal, Number.MAX_SAFE_INTEGER)
        ),
    };
  }

  return chain;
}

/**
 * Sessions the delete removes.
 *
 * Hostfree doubles ignore `WHERE` almost everywhere, but session deletion is
 * the one place where "all of them" and "all but this one" are different
 * behaviours worth modelling: `deleteSessionsByUserId` (password reset) takes
 * everything, `deleteOtherSessionsForUser` (2FA, passkeys, OAuth link/unlink)
 * keeps the session doing the securing. The condition's own chunks carry the
 * `<>` operator and the id to keep, so the double reads that much rather than
 * pretending both calls mean the same thing.
 */
function deleteSessionRows(state: MockAuthState, condition: unknown): void {
  const keepId = keptSessionId(condition);
  if (keepId === undefined) {
    state.sessions.clear();
    return;
  }
  for (const [token, data] of [...state.sessions.entries()]) {
    if (data.sessionId !== keepId) state.sessions.delete(token);
  }
}

/**
 * The right-hand value of a `ne(...)` in a drizzle condition, if any.
 *
 * A condition flattens to alternating text chunks (`{ value: string[] }`) and
 * parameters (`{ value }`); the parameter after the ` <> ` text is the id the
 * caller is keeping.
 */
function keptSessionId(condition: unknown): string | undefined {
  const flat: unknown[] = [];
  const flatten = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const nested = (value as Record<string, unknown>).queryChunks;
    if (!Array.isArray(nested)) return;
    for (const chunk of nested) {
      flat.push(chunk);
      flatten(chunk);
    }
  };
  flatten(condition);
  const chunkText = (chunk: unknown): string | undefined => {
    if (!chunk || typeof chunk !== "object") return undefined;
    const value = (chunk as Record<string, unknown>).value;
    return Array.isArray(value) &&
        value.every((part) => typeof part === "string")
      ? value.join("")
      : undefined;
  };
  for (let i = 0; i < flat.length; i++) {
    if (chunkText(flat[i])?.trim() !== "<>") continue;
    for (let j = i + 1; j < flat.length; j++) {
      const candidate = flat[j];
      if (chunkText(candidate) !== undefined) continue;
      const value = candidate && typeof candidate === "object"
        ? (candidate as Record<string, unknown>).value
        : undefined;
      if (typeof value === "string") return value;
      break;
    }
  }
  return undefined;
}

function insertSessionRow(state: MockAuthState, row: Record<string, unknown>) {
  state.insertedSessions.push(row);
  const userId = String(row.userId);
  const token = String(row.token);
  const cred = [...state.credentials.values()].find((u) => u.id === userId);
  const userRow = state.users.find((u) => u.id === userId);
  state.sessions.set(token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: cred?.email ?? userRow?.email ?? "user@example.com",
    role: userRow?.role ?? "user",
    createdAt: asString(row.createdAt, new Date().toISOString()),
  });
  return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) };
}

function insertUserRow(state: MockAuthState, row: Record<string, unknown>) {
  const id = crypto.randomUUID();
  state.users.push({
    id,
    email: String(row.email),
    isDisabled: Boolean(row.isDisabled),
    isEmailVerified: Boolean(row.isEmailVerified),
    is2FaEnabled: Boolean(row.is2FaEnabled),
    role: asString(row.role, "user"),
    displayName: (row.name as string | null | undefined) ??
      (row.displayName as string | null | undefined) ?? null,
  });
  return { returning: () => Promise.resolve([{ id }]) };
}

function accountAlreadyExists(
  state: MockAuthState,
  row: Record<string, unknown>,
  providerId: string,
  providerUserId: string,
): boolean {
  return state.accounts.some((existing) =>
    existing.providerId === providerId &&
    existing.providerUserId === providerUserId
  ) ||
    state.accounts.some((existing) =>
      existing.userId === String(row.userId) &&
      existing.providerId === providerId
    );
}

function insertAccountRow(state: MockAuthState, row: Record<string, unknown>) {
  const providerId = asString(row.providerId, "credential");
  const providerUserId = asString(row.providerUserId, String(row.userId));
  if (accountAlreadyExists(state, row, providerId, providerUserId)) {
    throw Object.assign(new Error("duplicate key"), { code: "23505" });
  }
  state.accounts.push({
    userId: String(row.userId),
    password: typeof row.password === "string" ? row.password : null,
    providerId,
    providerUserId,
  });
  return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) };
}

function insertOrganizationRow(
  state: MockAuthState,
  row: Record<string, unknown>,
) {
  const id = crypto.randomUUID();
  state.organizations.push({
    id,
    name: (row.name as string | null | undefined) ??
      (row.displayName as string | null | undefined) ?? null,
  });
  return { returning: () => Promise.resolve([{ id }]) };
}

function insertLicenseRow(state: MockAuthState, row: Record<string, unknown>) {
  const id = crypto.randomUUID();
  state.licenses.push({
    id,
    organizationId: String(row.organizationId),
    name: (row.name as string | null | undefined) ??
      (row.displayName as string | null | undefined) ?? null,
    token: String(row.token),
    revokedAt: null,
    serverId: null,
    createdAt: asString(row.createdAt, new Date().toISOString()),
  });
  return { returning: () => Promise.resolve([{ id }]) };
}

function insertVerificationRow(
  state: MockAuthState,
  internal: MockAuthStateInternal,
  row: Record<string, unknown>,
) {
  const id = crypto.randomUUID();
  const stamp = asString(
    row.createdAt,
    asString(row.updatedAt, new Date().toISOString()),
  );
  internal.lastVerificationInsert = row;
  const identifier = String(row.identifier);
  const existing = state.verificationRows.some((entry) =>
    entry.identifier === identifier
  );
  if (!existing) {
    state.verificationRows.push({
      id,
      identifier,
      value: String(row.value),
      expiresAt: String(row.expiresAt),
      createdAt: stamp,
    });
  }
  return {
    returning: () => Promise.resolve(existing ? [] : [{ id }]),
    onConflictDoUpdate: (config: { set?: Record<string, unknown> }) => {
      const target = state.verificationRows.find((entry) =>
        entry.identifier === identifier
      );
      if (target && config.set?.value !== undefined) {
        target.value = String(config.set.value);
      }
      if (target && config.set?.expiresAt !== undefined) {
        target.expiresAt = String(config.set.expiresAt);
      }
      return Promise.resolve(undefined);
    },
    onConflictDoNothing: () => ({
      returning: () => Promise.resolve(existing ? [] : [{ id }]),
    }),
  };
}

function insertTwoFactorRow(
  state: MockAuthState,
  row: Record<string, unknown>,
) {
  const id = crypto.randomUUID();
  state.twoFactorRows.push({
    id,
    userId: String(row.userId),
    secret: String(row.secret),
    isVerified: Boolean(row.isVerified),
    backupCodes: asString(row.backupCodes, "[]"),
  });
  return { returning: () => Promise.resolve([{ id }]) };
}

function insertPasskeyRow(state: MockAuthState, row: Record<string, unknown>) {
  const credentialId = String(row.credentialId);
  if (state.passkeys.some((entry) => entry.credentialId === credentialId)) {
    const err = new Error("duplicate key value") as Error & { code: string };
    err.code = "23505";
    throw err;
  }
  const id = crypto.randomUUID();
  state.passkeys.push({
    id,
    userId: String(row.userId),
    name: (row.name as string | null | undefined) ?? null,
    createdAt: asString(row.createdAt, new Date().toISOString()),
    credentialId,
    publicKey: String(row.publicKey),
    counter: Number(row.counter ?? 0),
    deviceType: asString(row.deviceType, "singleDevice"),
    isBackedUp: Boolean(row.isBackedUp),
    aaguid: (row.aaguid as string | null | undefined) ?? null,
    transports: (row.transports as string | null | undefined) ?? null,
  });
  return { returning: () => Promise.resolve([{ id }]) };
}

function insertSimpleRow(
  state: MockAuthState,
  table: unknown,
  row: Record<string, unknown>,
) {
  if (table === setting) {
    state.settings.set(String(row.key), String(row.value));
  }
  return {
    returning: () => Promise.resolve([{ id: crypto.randomUUID() }]),
    onConflictDoUpdate: () => ({
      set: () => Promise.resolve(undefined),
    }),
    onConflictDoNothing: () => Promise.resolve(undefined),
  };
}

function handleInsertValues(
  state: MockAuthState,
  table: unknown,
  row: Record<string, unknown>,
) {
  const internal = state as MockAuthStateInternal;
  if (table === session) return insertSessionRow(state, row);
  if (table === user) return insertUserRow(state, row);
  if (table === account) return insertAccountRow(state, row);
  if (table === organization) return insertOrganizationRow(state, row);
  if (table === license) return insertLicenseRow(state, row);
  if (table === verification) {
    return insertVerificationRow(state, internal, row);
  }
  if (table === twoFactor) return insertTwoFactorRow(state, row);
  if (table === passkey) return insertPasskeyRow(state, row);
  if (
    table === team ||
    table === teammate ||
    table === grant ||
    table === workspace ||
    table === setting
  ) {
    return insertSimpleRow(state, table, row);
  }
  return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) };
}

/**
 * Rows of an authn table that satisfy the statement's `WHERE`, evaluated by
 * the shared memory-db walker (so an update or delete can never hit a row the
 * real SQL would not).
 */
function matchingRows<T extends Record<string, unknown>>(
  table: Parameters<typeof rowMatchesWhere>[0],
  rows: readonly T[],
  condition: unknown,
): T[] {
  return rows.filter((row) => rowMatchesWhere(table, row, condition));
}

/**
 * Apply an `update … set … where` to the double once, and return the rows it
 * matched (as they were matched, so a compare-and-set on `counter` sees the
 * pre-update value). Tables outside the authn set keep their earlier,
 * predicate-free handling.
 */
function applyUpdate(
  state: MockAuthState,
  table: unknown,
  patch: Record<string, unknown>,
  condition: unknown,
): Row[] {
  if (table === user) {
    const rows = matchingRows(user, state.users, condition);
    for (const row of rows) {
      if (patch.isEmailVerified !== undefined) {
        row.isEmailVerified = Boolean(patch.isEmailVerified);
      }
      if (patch.is2FaEnabled !== undefined) {
        row.is2FaEnabled = Boolean(patch.is2FaEnabled);
      }
    }
    return rows.map((row) => ({
      id: row.id,
      isEmailVerified: row.isEmailVerified,
    }));
  }
  if (table === twoFactor) {
    const rows = matchingRows(twoFactor, state.twoFactorRows, condition);
    for (const row of rows) {
      if (patch.secret !== undefined) row.secret = String(patch.secret);
      if (patch.isVerified !== undefined) {
        row.isVerified = Boolean(patch.isVerified);
      }
      if (patch.backupCodes !== undefined) {
        row.backupCodes = String(patch.backupCodes);
      }
    }
    return rows.map((row) => ({ id: row.id }));
  }
  if (table === passkey) {
    const rows = matchingRows(passkey, state.passkeys, condition);
    for (const row of rows) {
      if (patch.counter !== undefined) row.counter = Number(patch.counter);
    }
    return rows.map((row) => ({ id: row.id }));
  }
  if (table === account) {
    const rows = matchingRows(account, state.accounts, condition);
    for (const row of rows) {
      if (patch.password !== undefined) row.password = String(patch.password);
    }
    return rows.map(() => ({ id: crypto.randomUUID() }));
  }
  return [];
}

function revokeFirstActiveLicense(
  state: MockAuthState,
  patch: Record<string, unknown>,
): Row[] | undefined {
  const row = state.licenses.find((entry) => entry.revokedAt === null);
  if (!row) return undefined;
  row.revokedAt = asString(patch.revokedAt, new Date().toISOString());
  return [{ id: row.id }];
}

function deleteVerificationRows(
  state: MockAuthState,
  internal: MockAuthStateInternal,
): void {
  const hasOtp = state.verificationRows.some((row) =>
    row.identifier.startsWith("otp:") ||
    row.identifier.startsWith("otp-attempts:")
  );
  const has2faAttempts = state.verificationRows.some((row) =>
    row.identifier.startsWith("2fa-attempts:")
  );
  if (!hasOtp && has2faAttempts) {
    state.verificationRows = state.verificationRows.filter((row) =>
      !row.identifier.startsWith("2fa-attempts:")
    );
    return;
  }
  if (!hasOtp) {
    state.verificationRows.shift();
    return;
  }
  if (internal.inTransaction) {
    internal.verificationDeletePhase = (internal.verificationDeletePhase ?? 0) +
      1;
    if (internal.verificationDeletePhase === 1) {
      const idx = state.verificationRows.findIndex((row) =>
        row.identifier.startsWith("otp:") &&
        !row.identifier.startsWith("otp-attempts:")
      );
      if (idx >= 0) state.verificationRows.splice(idx, 1);
      return;
    }
    state.verificationRows = state.verificationRows.filter((row) =>
      !row.identifier.startsWith("otp-attempts:")
    );
    return;
  }
  state.verificationRows.shift();
}

function pushOtpPair(
  state: MockAuthState,
  otpRow: MockAuthState["verificationRows"][number],
  attemptsRow: MockAuthState["verificationRows"][number],
): void {
  state.verificationRows.push(otpRow, attemptsRow);
}

/** Minimal drizzle-shaped double for auth sign-in + session middleware paths. */
export function createMockAuthDb(state: MockAuthState): Db {
  const internal = state as MockAuthStateInternal;

  const db = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) =>
        handleInsertValues(state, table, row),
    }),
    select: (_fields?: unknown) => ({
      from: (table: unknown) => buildSelectFrom(state, internal, table),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const applied = Promise.resolve().then(() =>
            applyUpdate(state, table, patch, condition)
          );
          return Object.assign(applied.then(() => undefined), {
            returning: async () => {
              const matched = await applied;
              if (table === license) {
                return revokeFirstActiveLicense(state, patch) ?? [];
              }
              return matched;
            },
          });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (condition: unknown) => {
        let returningRows: Row[] = [];
        if (table === session) deleteSessionRows(state, condition);
        if (table === verification) deleteVerificationRows(state, internal);
        if (table === twoFactor) {
          const gone = new Set(
            matchingRows(twoFactor, state.twoFactorRows, condition),
          );
          state.twoFactorRows = state.twoFactorRows.filter((row) =>
            !gone.has(row)
          );
        }
        if (table === passkey) {
          const gone = matchingRows(passkey, state.passkeys, condition);
          returningRows = gone.map((row) => ({ id: row.id }));
          state.passkeys = state.passkeys.filter((row) => !gone.includes(row));
        }
        if (table === account) {
          const gone = matchingRows(account, state.accounts, condition);
          returningRows = gone.map((row) => ({ id: row.userId }));
          state.accounts = state.accounts.filter((row) => !gone.includes(row));
        }
        if (table === user) {
          const gone = matchingRows(user, state.users, condition);
          state.users = state.users.filter((row) => !gone.includes(row));
        }
        const promise = Promise.resolve(undefined);
        return Object.assign(promise, {
          returning: () => Promise.resolve(returningRows),
        });
      },
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => {
      internal.inTransaction = true;
      internal.verificationSelectPhase = 0;
      internal.verificationDeletePhase = 0;
      try {
        return await fn(db as unknown as Db);
      } finally {
        internal.inTransaction = false;
        internal.verificationSelectPhase = 0;
        internal.verificationDeletePhase = 0;
      }
    },
  };

  return db as unknown as Db;
}

export function seedMockCredentialUser(
  state: MockAuthState,
  cred: MockCredentialUser,
): void {
  state.credentials.set(cred.email, cred);
  if (!state.users.some((row) => row.id === cred.id)) {
    state.users.push({
      id: cred.id,
      email: cred.email,
      isDisabled: cred.isDisabled ?? false,
      isEmailVerified: cred.isEmailVerified ?? true,
      is2FaEnabled: false,
      role: "user",
    });
  }
  if (!state.accounts.some((row) => row.userId === cred.id)) {
    state.accounts.push({
      userId: cred.id,
      password: cred.password,
      providerId: "credential",
      providerUserId: cred.id,
    });
  }
}

export function seedMockUser(
  state: MockAuthState,
  userRow: MockAuthUser,
): void {
  state.users.push(userRow);
}

export function seedMockSession(
  state: MockAuthState,
  token: string,
  data: SessionData,
): void {
  state.sessions.set(token, {
    ...data,
    createdAt: data.createdAt ?? new Date().toISOString(),
  });
}

export function seedMockInstalledInstance(state: MockAuthState): void {
  state.organizations.push({
    id: crypto.randomUUID(),
    name: "Root Organization",
  });
  state.users.push({
    id: crypto.randomUUID(),
    email: "root@example.com",
    isDisabled: false,
    isEmailVerified: true,
    role: SUPERADMIN_ROLE,
  });
}

export function seedMockSignupEnabled(
  state: MockAuthState,
  enabled: boolean,
): void {
  state.settings.set(IS_SIGNUP_ENABLED_CONFIG_KEY, enabled ? "1" : "0");
}

/** Tag the next credential lookup to match a specific login string. */
export function withMockLogin(
  state: MockAuthState,
  login: string,
): MockAuthState {
  return Object.assign(state, { lastLogin: login });
}

export async function seedMockOtpVerification(
  state: MockAuthState,
  email: string,
  type: OtpType,
  otp: string,
  secrets: DerivedSecretsConfig,
): Promise<void> {
  const emailHash = await hashEmailForOtp(email);
  const identifier = otpIdentifier(type, emailHash);
  const attemptsId = attemptsIdentifier(type, emailHash);
  const verifier = await deriveOtpVerifier(type, emailHash, otp, secrets);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const stamp = new Date().toISOString();
  pushOtpPair(
    state,
    {
      id: crypto.randomUUID(),
      identifier,
      value: verifier,
      expiresAt,
      createdAt: stamp,
    },
    {
      id: crypto.randomUUID(),
      identifier: attemptsId,
      value: "0",
      expiresAt,
      createdAt: stamp,
    },
  );
}

/** Seed an expired OTP row (and attempts companion) for negative-path tests. */
export async function seedMockExpiredOtpVerification(
  state: MockAuthState,
  email: string,
  type: OtpType,
  otp: string,
  secrets: DerivedSecretsConfig,
): Promise<void> {
  const emailHash = await hashEmailForOtp(email);
  const identifier = otpIdentifier(type, emailHash);
  const attemptsId = attemptsIdentifier(type, emailHash);
  const verifier = await deriveOtpVerifier(type, emailHash, otp, secrets);
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  const stamp = new Date(Date.now() - 120_000).toISOString();
  pushOtpPair(
    state,
    {
      id: crypto.randomUUID(),
      identifier,
      value: verifier,
      expiresAt,
      createdAt: stamp,
    },
    {
      id: crypto.randomUUID(),
      identifier: attemptsId,
      value: "0",
      expiresAt,
      createdAt: stamp,
    },
  );
}
