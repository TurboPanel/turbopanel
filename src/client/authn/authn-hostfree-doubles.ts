import type { Db } from '../../db.ts'
import {
  account,
  grant,
  license,
  member,
  organization,
  session,
  setting,
  team,
  teammate,
  user,
  verification,
  workspace,
} from '../../lib/db/schema.ts'
import {
  deriveOtpVerifier,
  hashEmailForOtp,
  type OtpType,
} from './email-otp.ts'
import type { DerivedSecretsConfig } from './secrets.ts'
import { IS_SIGNUP_ENABLED_CONFIG_KEY } from './install-state.ts'
import { SUPERADMIN_ROLE } from './session-store.ts'
import type { SessionData } from './session-store.ts'

export type MockCredentialUser = {
  id: string
  email: string
  username?: string | null
  password: string
  isDisabled?: boolean
  isEmailVerified?: boolean
}

export type MockAuthUser = {
  id: string
  email: string
  username?: string | null
  isDisabled: boolean
  isEmailVerified: boolean
  role: string
  displayName?: string | null
}

type MockAuthStateInternal = MockAuthState & {
  lastLogin?: string
  inTransaction?: boolean
  verificationSelectPhase?: number
  verificationDeletePhase?: number
}

export type MockAuthState = {
  sessions: Map<string, SessionData>
  credentials: Map<string, MockCredentialUser>
  users: MockAuthUser[]
  accounts: Array<{ userId: string; password: string }>
  organizations: Array<{ id: string; displayName: string | null }>
  settings: Map<string, string>
  licenses: Array<{
    id: string
    organizationId: string
    displayName: string | null
    token: string
    revokedAt: string | null
    serverId: string | null
    createdAt: string
  }>
  verificationRows: Array<{
    id: string
    identifier: string
    value: string
    expiresAt: string
    createdAt?: string
  }>
  insertedSessions: Array<Record<string, unknown>>
}

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
  }
}

function isExpired(iso: string): boolean {
  return iso <= new Date().toISOString()
}

function otpIdentifier(type: OtpType, emailHash: string): string {
  return `otp:${type}:${emailHash}`
}

function attemptsIdentifier(type: OtpType, emailHash: string): string {
  return `otp-attempts:${type}:${emailHash}`
}

function selectCredentialRow(state: MockAuthState, login: string) {
  const trimmed = login.trim()
  const byEmail = trimmed.includes('@')
  const key = byEmail ? trimmed.toLowerCase() : trimmed
  for (const row of state.credentials.values()) {
    const match = byEmail
      ? row.email === key
      : (row.username ?? '') === key
    if (match) {
      return {
        userId: row.id,
        username: row.username ?? null,
        email: row.email,
        password: row.password,
        isDisabled: row.isDisabled ?? false,
        isEmailVerified: row.isEmailVerified ?? true,
      }
    }
  }
  for (const row of state.users) {
    const match = byEmail
      ? row.email === key
      : (row.username ?? '') === key
    if (!match) continue
    const accountRow = state.accounts.find((a) => a.userId === row.id)
    if (!accountRow) continue
    return {
      userId: row.id,
      username: row.username ?? null,
      email: row.email,
      password: accountRow.password,
      isDisabled: row.isDisabled,
      isEmailVerified: row.isEmailVerified,
    }
  }
  return null
}

function mapVerificationRows(
  state: MockAuthStateInternal,
  limit: number,
  inTx: boolean,
) {
  const rows = inTx
    ? state.verificationRows
    : state.verificationRows.filter((row) => !isExpired(row.expiresAt))
  if (inTx) {
    state.verificationSelectPhase = (state.verificationSelectPhase ?? 0) + 1
    if (state.verificationSelectPhase === 1) {
      return rows
        .filter((row) =>
          row.identifier.startsWith('otp:') &&
          !row.identifier.startsWith('otp-attempts:')
        )
        .slice(0, limit)
    }
    if (state.verificationSelectPhase === 2) {
      return rows
        .filter((row) => row.identifier.startsWith('otp-attempts:'))
        .slice(0, limit)
    }
  }
  return rows.slice(0, limit)
}

/** Drizzle-shaped thenable: awaitable directly and via `.limit()` / `.for().limit()`. */
function thenableRows<T>(
  fetchRows: () => Promise<T[]>,
): Promise<T[]> & {
  limit: (n: number) => Promise<T[]>
  for: (lock: string) => { limit: (n: number) => Promise<T[]> }
} {
  const promise = fetchRows()
  const limited = (n: number) => promise.then((rows) => rows.slice(0, n))
  return Object.assign(promise, {
    limit: limited,
    for: (_lock: string) => ({ limit: limited }),
  })
}

/** Minimal drizzle-shaped double for auth sign-in + session middleware paths. */
export function createMockAuthDb(state: MockAuthState): Db {
  const internal = state as MockAuthStateInternal

  const db = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === session) {
          state.insertedSessions.push(row)
          const userId = String(row.userId)
          const token = String(row.token)
          const cred = [...state.credentials.values()].find((u) => u.id === userId)
          const userRow = state.users.find((u) => u.id === userId)
          state.sessions.set(token, {
            sessionId: crypto.randomUUID(),
            userId,
            username: cred?.username ?? userRow?.username ?? null,
            email: cred?.email ?? userRow?.email ?? 'user@example.com',
            role: userRow?.role ?? 'user',
          })
          return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) }
        }
        if (table === user) {
          const id = crypto.randomUUID()
          state.users.push({
            id,
            email: String(row.email),
            username: (row.username as string | null | undefined) ?? null,
            isDisabled: Boolean(row.isDisabled),
            isEmailVerified: Boolean(row.isEmailVerified),
            role: String(row.role ?? 'user'),
            displayName: (row.displayName as string | null | undefined) ?? null,
          })
          return {
            returning: () => Promise.resolve([{ id }]),
          }
        }
        if (table === account) {
          state.accounts.push({
            userId: String(row.userId),
            password: String(row.password),
          })
          return { returning: () => Promise.resolve([{ id: crypto.randomUUID() }]) }
        }
        if (table === organization) {
          const id = crypto.randomUUID()
          state.organizations.push({
            id,
            displayName: (row.displayName as string | null | undefined) ?? null,
          })
          return { returning: () => Promise.resolve([{ id }]) }
        }
        if (table === license) {
          const id = crypto.randomUUID()
          state.licenses.push({
            id,
            organizationId: String(row.organizationId),
            displayName: (row.displayName as string | null | undefined) ?? null,
            token: String(row.token),
            revokedAt: null,
            serverId: null,
            createdAt: String(row.createdAt ?? new Date().toISOString()),
          })
          return {
            returning: () => Promise.resolve([{ id }]),
          }
        }
        if (table === verification) {
          const id = crypto.randomUUID()
          const stamp = String(row.createdAt ?? row.updatedAt ?? new Date().toISOString())
          state.verificationRows.push({
            id,
            identifier: String(row.identifier),
            value: String(row.value),
            expiresAt: String(row.expiresAt),
            createdAt: stamp,
          })
          return {
            onConflictDoUpdate: () => Promise.resolve(undefined),
          }
        }
        if (
          table === team ||
          table === member ||
          table === teammate ||
          table === grant ||
          table === workspace ||
          table === setting
        ) {
          if (table === setting) {
            state.settings.set(String(row.key), String(row.value))
          }
          return {
            returning: () => Promise.resolve([{ id: crypto.randomUUID() }]),
            onConflictDoUpdate: () => ({
              set: () => Promise.resolve(undefined),
            }),
            onConflictDoNothing: () => Promise.resolve(undefined),
          }
        }
        return {
          returning: () => Promise.resolve([{ id: crypto.randomUUID() }]),
        }
      },
    }),
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const licenseRows = (activeOnly: boolean) =>
          state.licenses
            .filter((row) => !activeOnly || row.revokedAt === null)
            .map((row) => ({
              id: row.id,
              organizationId: row.organizationId,
              displayName: row.displayName,
              createdAt: row.createdAt,
              token: row.token,
              licenseId: row.id,
              serverId: row.serverId,
            }))

        const chain = {
          innerJoin: (_other: unknown, _cond: unknown) => ({
            where: (_cond: unknown) => thenableRows(async () => {
              if (table === session) {
                const entries = [...state.sessions.entries()]
                if (entries.length === 0) return []
                const [, data] = entries[0]
                return [{
                  sessionId: data.sessionId,
                  userId: data.userId,
                  username: data.username,
                  email: data.email,
                  role: data.role,
                  isDisabled: false,
                }]
              }
              if (table === license) {
                return licenseRows(false)
                  .filter((row) => row.serverId !== null)
                  .map((row) => ({
                    licenseId: row.id,
                    id: row.serverId as string,
                    displayName: row.displayName,
                  }))
              }
              return []
            }),
          }),
          where: (_cond: unknown) => thenableRows(async () => {
            if (table === user) {
              return state.users.map((row) => ({
                id: row.id,
                isDisabled: row.isDisabled,
                isEmailVerified: row.isEmailVerified,
                email: row.email,
                username: row.username ?? null,
                role: row.role,
              }))
            }
            if (table === organization) {
              return state.organizations
                .filter((row) => row.displayName !== null)
                .map((row) => ({ id: row.id }))
            }
            if (table === license) {
              return licenseRows(true).map((row) => ({
                id: row.id,
                organizationId: row.organizationId,
                displayName: row.displayName,
                createdAt: row.createdAt,
                token: row.token,
              }))
            }
            if (table === setting) {
              const entries = [...state.settings.entries()]
              return entries.map(([key, value]) => ({ key, value }))
            }
            if (table === verification) {
              const rows = mapVerificationRows(internal, Number.MAX_SAFE_INTEGER, false)
              return rows.map((row) => ({
                id: row.id,
                identifier: row.identifier,
                value: row.value,
                expiresAt: row.expiresAt,
                createdAt: row.createdAt ?? row.expiresAt,
              }))
            }
            return []
          }),
        }

        if (table === user) {
          return {
            ...chain,
            innerJoin: (_other: unknown, _cond: unknown) => ({
              where: (_cond: unknown) => ({
                limit: async (n: number) => {
                  const login = internal.lastLogin
                  if (!login) return []
                  const row = selectCredentialRow(state, login)
                  return row ? [row] : []
                },
              }),
            }),
          }
        }

        if (table === verification) {
          const fetchVerification = async (n: number) => {
            const rows = mapVerificationRows(internal, n, Boolean(internal.inTransaction))
            return rows.map((row) => ({
              id: row.id,
              identifier: row.identifier,
              value: row.value,
              expiresAt: row.expiresAt,
              createdAt: row.createdAt ?? row.expiresAt,
            }))
          }
          return {
            ...chain,
            where: (_cond: unknown) => thenableRows(() => fetchVerification(Number.MAX_SAFE_INTEGER)),
          }
        }

        return chain
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          const applyUserPatch = () => {
            if (table === user) {
              for (const row of state.users) {
                if (patch.isEmailVerified !== undefined) {
                  row.isEmailVerified = Boolean(patch.isEmailVerified)
                }
              }
            }
          }
          const promise = Promise.resolve().then(() => applyUserPatch())
          return Object.assign(promise, {
            returning: async () => {
              if (table === license) {
                for (const row of state.licenses) {
                  if (row.revokedAt === null) {
                    row.revokedAt = String(patch.revokedAt ?? new Date().toISOString())
                    return [{ id: row.id }]
                  }
                }
              }
              applyUserPatch()
              if (table === user) {
                const first = state.users[0]
                return first
                  ? [{ id: first.id, isEmailVerified: first.isEmailVerified }]
                  : []
              }
              if (table === account) {
                return [{ id: crypto.randomUUID() }]
              }
              return []
            },
          })
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (_cond: unknown) => {
        if (table === session) {
          state.sessions.clear()
        }
        if (table === verification) {
          if (internal.inTransaction) {
            internal.verificationDeletePhase = (internal.verificationDeletePhase ?? 0) + 1
            if (internal.verificationDeletePhase === 1) {
              const idx = state.verificationRows.findIndex((row) =>
                row.identifier.startsWith('otp:') &&
                !row.identifier.startsWith('otp-attempts:')
              )
              if (idx >= 0) state.verificationRows.splice(idx, 1)
            } else {
              state.verificationRows = state.verificationRows.filter((row) =>
                !row.identifier.startsWith('otp-attempts:')
              )
            }
          } else {
            state.verificationRows.shift()
          }
        }
        return Promise.resolve(undefined)
      },
    }),
    transaction: async (fn: (tx: Db) => Promise<unknown>) => {
      internal.inTransaction = true
      internal.verificationSelectPhase = 0
      internal.verificationDeletePhase = 0
      try {
        return await fn(db as Db)
      } finally {
        internal.inTransaction = false
        internal.verificationSelectPhase = 0
        internal.verificationDeletePhase = 0
      }
    },
  }

  return db as unknown as Db
}

export function seedMockCredentialUser(
  state: MockAuthState,
  cred: MockCredentialUser,
): void {
  state.credentials.set(cred.email, cred)
  const existingUser = state.users.find((row) => row.id === cred.id)
  if (!existingUser) {
    state.users.push({
      id: cred.id,
      email: cred.email,
      username: cred.username ?? null,
      isDisabled: cred.isDisabled ?? false,
      isEmailVerified: cred.isEmailVerified ?? true,
      role: 'user',
    })
  }
  if (!state.accounts.some((row) => row.userId === cred.id)) {
    state.accounts.push({
      userId: cred.id,
      password: cred.password,
    })
  }
}

export function seedMockUser(state: MockAuthState, userRow: MockAuthUser): void {
  state.users.push(userRow)
}

export function seedMockSession(
  state: MockAuthState,
  token: string,
  data: SessionData,
): void {
  state.sessions.set(token, data)
}

export function seedMockInstalledInstance(state: MockAuthState): void {
  state.organizations.push({
    id: crypto.randomUUID(),
    displayName: 'Default Organization',
  })
  state.users.push({
    id: crypto.randomUUID(),
    email: 'root@example.com',
    username: null,
    isDisabled: false,
    isEmailVerified: true,
    role: SUPERADMIN_ROLE,
  })
}

export function seedMockSignupEnabled(state: MockAuthState, enabled: boolean): void {
  state.settings.set(IS_SIGNUP_ENABLED_CONFIG_KEY, enabled ? '1' : '0')
}

/** Tag the next credential lookup to match a specific login string. */
export function withMockLogin(
  state: MockAuthState,
  login: string,
): MockAuthState {
  return Object.assign(state, { lastLogin: login })
}

export async function seedMockOtpVerification(
  state: MockAuthState,
  email: string,
  type: OtpType,
  otp: string,
  secrets: DerivedSecretsConfig,
): Promise<void> {
  const emailHash = await hashEmailForOtp(email)
  const identifier = otpIdentifier(type, emailHash)
  const attemptsId = attemptsIdentifier(type, emailHash)
  const verifier = await deriveOtpVerifier(type, emailHash, otp, secrets)
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const stamp = new Date().toISOString()
  state.verificationRows.push({
    id: crypto.randomUUID(),
    identifier,
    value: verifier,
    expiresAt,
    createdAt: stamp,
  })
  state.verificationRows.push({
    id: crypto.randomUUID(),
    identifier: attemptsId,
    value: '0',
    expiresAt,
    createdAt: stamp,
  })
}

/** Seed an expired OTP row (and attempts companion) for negative-path tests. */
export async function seedMockExpiredOtpVerification(
  state: MockAuthState,
  email: string,
  type: OtpType,
  otp: string,
  secrets: DerivedSecretsConfig,
): Promise<void> {
  const emailHash = await hashEmailForOtp(email)
  const identifier = otpIdentifier(type, emailHash)
  const attemptsId = attemptsIdentifier(type, emailHash)
  const verifier = await deriveOtpVerifier(type, emailHash, otp, secrets)
  const expiresAt = new Date(Date.now() - 60_000).toISOString()
  const stamp = new Date(Date.now() - 120_000).toISOString()
  state.verificationRows.push({
    id: crypto.randomUUID(),
    identifier,
    value: verifier,
    expiresAt,
    createdAt: stamp,
  })
  state.verificationRows.push({
    id: crypto.randomUUID(),
    identifier: attemptsId,
    value: '0',
    expiresAt,
    createdAt: stamp,
  })
}
