/**
 * Whether, and to whom, secrets bound for the co-located daemon are sealed.
 *
 * Uploaded instance TLS keys (`public-urls-update`) and the tunnel token
 * (`tunnel-token`) sit in the cell outbox (Redis stream / Durable Object
 * storage) until the daemon takes them. A daemon that advertises
 * `sealed-instance-secrets-v1` receives them as recipient-bound `tpdaemon`
 * envelopes — the same sealing every deploy secret uses — so the outbox never
 * holds the plaintext. An older daemon still gets the legacy plaintext fields.
 */
import type { Db } from "../../db/connection.ts";
import { isDaemonKeyActive } from "../servers/daemon-state.ts";
import { getServerDaemonStateByServerId } from "../servers/server-identity-db.ts";
import type { DaemonSecretRecipient } from "../../lib/secrets/data-encryption.ts";
import type { SecretsConfig } from "../../lib/secrets/secrets.ts";
import { SEALED_INSTANCE_SECRETS_FEATURE } from "../../lib/version-wire.ts";

export type InstanceSecretSealing = {
  secretsConfig: SecretsConfig;
  recipient: DaemonSecretRecipient;
};

/** The daemon can open sealed secrets, but this instance cannot seal to it. */
export class InstanceSecretSealingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceSecretSealingError";
  }
}

/**
 * `null` when the daemon does not advertise `sealed-instance-secrets-v1`
 * (legacy plaintext delivery). Throws {@link InstanceSecretSealingError}
 * rather than fall back to plaintext when the daemon can open envelopes but
 * the instance cannot produce one.
 */
export async function resolveInstanceSecretSealing(
  db: Db,
  serverId: string,
  secretsConfig: SecretsConfig | undefined,
): Promise<InstanceSecretSealing | null> {
  const state = await getServerDaemonStateByServerId(db, serverId);
  const features = state?.projection?.features ?? [];
  if (!state || !features.includes(SEALED_INSTANCE_SECRETS_FEATURE)) {
    return null;
  }
  if (!isDaemonKeyActive(state.key)) {
    throw new InstanceSecretSealingError(
      "the co-located daemon has no active key to seal secrets to",
    );
  }
  if (!secretsConfig) {
    throw new InstanceSecretSealingError(
      "the instance secret is required to seal secrets for the daemon",
    );
  }
  return { secretsConfig, recipient: { serverId, keyId: state.key.id } };
}
