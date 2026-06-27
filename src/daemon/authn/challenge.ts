/** Default challenge TTL when callers do not override store lifetime. */
export const DAEMON_CHALLENGE_TTL_MS = 15_000;
/** Enrollment and auth challenges — matches `/auth/challenge` `expiresAt` contract. */
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

