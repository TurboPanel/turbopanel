/** Short TTL for key-rotation challenges. */
export const DAEMON_CHALLENGE_TTL_MS = 15_000;
/** Enroll and auth challenges — matches `/auth/challenge` `expiresAt` contract. */
export const DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS = 60_000;

export type DaemonChallenge = {
  id: string;
  nonce: string;
  at: string;
};

type StoredDaemonChallenge = DaemonChallenge & {
  issuedAtMs: number;
  serverId?: string;
  keyId?: string;
};

export function issueDaemonChallenge(
  nowMs = Date.now(),
): StoredDaemonChallenge {
  return {
    id: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    at: new Date(nowMs).toISOString(),
    issuedAtMs: nowMs,
  };
}

export function isDaemonChallengeFresh(
  challenge: StoredDaemonChallenge,
  nowMs = Date.now(),
  maxAgeMs = DAEMON_CHALLENGE_TTL_MS,
): boolean {
  return nowMs - challenge.issuedAtMs <= maxAgeMs;
}

export function createDaemonChallengeStore(
  maxAgeMs = DAEMON_CHALLENGE_TTL_MS,
) {
  const challenges = new Map<string, StoredDaemonChallenge>();

  const pruneExpired = (nowMs = Date.now()) => {
    for (const [challengeId, challenge] of challenges.entries()) {
      if (!isDaemonChallengeFresh(challenge, nowMs, maxAgeMs)) {
        challenges.delete(challengeId);
      }
    }
  };

  return {
    issue(
      params: { serverId?: string; keyId?: string } = {},
    ): DaemonChallenge {
      const nowMs = Date.now();
      pruneExpired(nowMs);
      const challenge = issueDaemonChallenge(nowMs);
      challenge.serverId = params.serverId;
      challenge.keyId = params.keyId;
      challenges.set(challenge.id, challenge);
      return {
        id: challenge.id,
        nonce: challenge.nonce,
        at: challenge.at,
      };
    },

    consume(params: {
      challengeId: string;
      serverId?: string;
      keyId?: string;
    }): DaemonChallenge | null {
      const nowMs = Date.now();
      pruneExpired(nowMs);
      const challenge = challenges.get(params.challengeId);
      if (!challenge) return null;
      challenges.delete(params.challengeId);

      if (
        challenge.serverId !== undefined &&
        challenge.serverId !== params.serverId
      ) {
        return null;
      }
      if (challenge.keyId !== undefined && challenge.keyId !== params.keyId) {
        return null;
      }
      if (!isDaemonChallengeFresh(challenge, nowMs, maxAgeMs)) {
        return null;
      }
      return {
        id: challenge.id,
        nonce: challenge.nonce,
        at: challenge.at,
      };
    },
  };
}
