import {
  createDaemonChallengeStore,
  DAEMON_CHALLENGE_TTL_MS,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
  type DaemonChallenge,
} from '../authn/challenge.ts'
import type { RedisCellClient } from './redis/client.ts'
import { challengeKey } from './redis/keys.ts'
import { CONSUME_CHALLENGE } from './redis/lua.ts'

export interface DaemonChallengeStore {
  issue(params?: { serverId?: string; keyId?: string }): Promise<DaemonChallenge>
  consume(params: {
    challengeId: string
    serverId?: string
    keyId?: string
  }): Promise<DaemonChallenge | null>
  /** Stored lifetime in ms — used for `expiresAt` in API responses. */
  readonly ttlMs: number
}

/**
 * DO-backed challenge store. Uses a well-known per-instance Durable Object
 * named `"challenge-store"` (not a per-server cell) because enrollment
 * challenges have no serverId yet. Auth and key-rotation challenges that
 * include serverId/keyId still work — consume validates those fields against
 * the stored row.
 */
export function createDurableObjectChallengeStore(
  stub: DurableObjectStub,
  ttlMs = DAEMON_CHALLENGE_TTL_MS,
): DaemonChallengeStore {
  const rpc = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> => {
    return await stub.fetch(`https://do.internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  return {
    ttlMs,

    async issue(params = {}): Promise<DaemonChallenge> {
      const response = await rpc('/rpc/challenge/issue', {
        serverId: params.serverId ?? '',
        keyId: params.keyId ?? '',
        ttlMs,
      })
      if (!response.ok) {
        throw new Error(await response.text())
      }
      return await response.json() as DaemonChallenge
    },

    async consume(params: {
      challengeId: string
      serverId?: string
      keyId?: string
    }): Promise<DaemonChallenge | null> {
      const response = await rpc('/rpc/challenge/consume', {
        challengeId: params.challengeId,
        serverId: params.serverId ?? '',
        keyId: params.keyId ?? '',
        ttlMs,
      })
      if (!response.ok) {
        throw new Error(await response.text())
      }
      const result = await response.json() as { challenge: DaemonChallenge | null }
      return result.challenge
    },
  }
}

export function createRedisChallengeStore(
  client: RedisCellClient,
  ttlMs = DAEMON_CHALLENGE_TTL_MS,
): DaemonChallengeStore {
  return {
    ttlMs,

    async issue(params = {}): Promise<DaemonChallenge> {
      const challengeId = crypto.randomUUID()
      const nonce = crypto.randomUUID()
      const at = new Date().toISOString()
      const issuedAtMs = Date.now()

      await client.hset(challengeKey(challengeId), {
        nonce,
        at,
        serverId: params.serverId ?? '',
        keyId: params.keyId ?? '',
        issuedAtMs: String(issuedAtMs),
      })
      await client.expire(
        challengeKey(challengeId),
        Math.ceil(ttlMs / 1000),
      )

      return { id: challengeId, nonce, at }
    },

    async consume(params: {
      challengeId: string
      serverId?: string
      keyId?: string
    }): Promise<DaemonChallenge | null> {
      const key = challengeKey(params.challengeId)
      const result = await client.eval(
        CONSUME_CHALLENGE,
        1,
        key,
        params.serverId ?? '',
        params.keyId ?? '',
        Date.now(),
        ttlMs,
      )

      if (!Array.isArray(result) || result.length < 2) return null

      return {
        id: params.challengeId,
        nonce: String(result[0]),
        at: String(result[1]),
      }
    },
  }
}

export function createInMemoryChallengeStore(
  maxAgeMs = DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
): DaemonChallengeStore {
  const store = createDaemonChallengeStore(maxAgeMs)
  return {
    ttlMs: maxAgeMs,

    async issue(params = {}): Promise<DaemonChallenge> {
      return store.issue(params)
    },

    async consume(params: {
      challengeId: string
      serverId?: string
      keyId?: string
    }): Promise<DaemonChallenge | null> {
      return store.consume(params)
    },
  }
}

export {
  DAEMON_CHALLENGE_TTL_MS,
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
} from '../authn/challenge.ts'
