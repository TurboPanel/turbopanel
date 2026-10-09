/**
 * Organization-wide Orchestrator HTTP API and Raft auth (control-plane derived).
 *
 * Every Orchestrator node in an organization shares one Raft group. Followers
 * proxy HTTP to the leader's `HTTPAdvertise` address and must present the same
 * `HTTPAuthUser` / `HTTPAuthPassword` the leader expects — per-host random
 * `api.cnf` files made cross-host proxy return `Unauthorized` and broke
 * discovery. `RaftAuthToken` is the same class of secret: one value for the
 * whole org Raft group.
 *
 * Derived like {@link ./topology-credential.ts}: HKDF purpose off the root
 * secret, HMAC over `organization:<id>`, sealed to each daemon on
 * `managed.ha.reconcile`. The daemon materializes `api.cnf` and `raft.cnf`
 * before rendering `orchestrator.conf.json`.
 */

import { base64urlEncode } from "../../lib/encoding/base64url.ts";
import {
  type DaemonSecretRecipient,
  encryptSecretForDaemon,
} from "../../lib/secrets/data-encryption.ts";
import { deriveKey, type SecretsConfig } from "../../lib/secrets/secrets.ts";

export const ORCHESTRATOR_API_CREDENTIAL_PURPOSE =
  "managed-orchestrator-api-credential";
export const ORCHESTRATOR_RAFT_TOKEN_PURPOSE =
  "managed-orchestrator-raft-token";

export const ORCHESTRATOR_API_PASSWORD_LENGTH = 32;
export const ORCHESTRATOR_RAFT_TOKEN_LENGTH = 32;

export type OrganizationOrchestratorApiCredential = {
  username: string;
  password: string;
};

export function orchestratorApiUsernameForOrganization(
  organizationId: string,
): string {
  return `tp_orchapi_${organizationId.replaceAll("-", "").slice(0, 12)}`;
}

export async function deriveOrganizationOrchestratorApiCredential(
  secretsConfig: SecretsConfig,
  organizationId: string,
): Promise<OrganizationOrchestratorApiCredential> {
  const current = secretsConfig.versioned[0];
  if (!current) {
    throw new Error(
      "No signing secret available — configure TURBOPANEL_SECRET",
    );
  }
  const key = await deriveKey(
    current.value,
    ORCHESTRATOR_API_CREDENTIAL_PURPOSE,
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`organization:${organizationId}`),
  );
  return {
    username: orchestratorApiUsernameForOrganization(organizationId),
    password: base64urlEncode(new Uint8Array(mac)).slice(
      0,
      ORCHESTRATOR_API_PASSWORD_LENGTH,
    ),
  };
}

export async function deriveOrganizationOrchestratorRaftToken(
  secretsConfig: SecretsConfig,
  organizationId: string,
): Promise<string> {
  const current = secretsConfig.versioned[0];
  if (!current) {
    throw new Error(
      "No signing secret available — configure TURBOPANEL_SECRET",
    );
  }
  const key = await deriveKey(current.value, ORCHESTRATOR_RAFT_TOKEN_PURPOSE);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`organization:${organizationId}`),
  );
  return base64urlEncode(new Uint8Array(mac)).slice(
    0,
    ORCHESTRATOR_RAFT_TOKEN_LENGTH,
  );
}

export async function buildOrganizationOrchestratorApiUser(
  secretsConfig: SecretsConfig,
  recipient: DaemonSecretRecipient,
  organizationId: string,
): Promise<{ username: string; password: string }> {
  const derived = await deriveOrganizationOrchestratorApiCredential(
    secretsConfig,
    organizationId,
  );
  return {
    username: derived.username,
    password: await encryptSecretForDaemon(
      secretsConfig,
      recipient,
      derived.password,
    ),
  };
}

export async function buildOrganizationOrchestratorRaftToken(
  secretsConfig: SecretsConfig,
  recipient: DaemonSecretRecipient,
  organizationId: string,
): Promise<string> {
  const token = await deriveOrganizationOrchestratorRaftToken(
    secretsConfig,
    organizationId,
  );
  return encryptSecretForDaemon(secretsConfig, recipient, token);
}
