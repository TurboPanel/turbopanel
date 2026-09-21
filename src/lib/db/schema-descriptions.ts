/**
 * Human descriptions for every physical table and every non-obvious column
 * in the control-plane schema — the single source both the Postgres
 * `COMMENT ON` migrations and the website data dictionary are generated
 * from (`scripts/schema-comments.mjs`, `scripts/generate-data-dictionary.mjs`).
 *
 * Keyed by **physical** names (`seat`, `copy`, `2fa`, …), exactly as they
 * appear in the latest `migrations/meta/NNNN_snapshot.json` — never by the
 * drizzle export name. `schema-descriptions.test.ts` holds this file to the
 * shipped schema: every table needs a `group` and a `summary`; every column
 * that is not obvious (see {@link isObviousColumn}) needs a description; a
 * description for a table or column that does not exist fails; and every
 * description here must already be carried by a migration (the test runs
 * the pending-comment delta and fails if it is non-empty).
 *
 * Writing rules (enforced): one sentence, at most {@link MAX_DESCRIPTION_LENGTH}
 * characters, no line breaks, none of the characters `| { } < > "` (they
 * break GFM table cells, MDX expressions and SQL string quoting). Use
 * backticks for identifiers and literal values; single quotes are fine.
 * Say what the value is, who writes it, and the allowed members / units /
 * derived-vs-stored fact when there is one. The daemon is the "daemon",
 * never an "agent" (`pnpm check:vocabulary`).
 *
 * Change procedure: `src/lib/db/AGENTS.md` → "Schema descriptions".
 */

export const MAX_DESCRIPTION_LENGTH = 160

/** Characters a description may never contain (table cells, MDX, SQL quoting). */
export const FORBIDDEN_DESCRIPTION_CHARS = /[|{}<>"\n\r\t]/

/** Columns every table carries with the same meaning; never described per table. */
export const STANDARD_COLUMNS: Readonly<Record<string, string>> = {
  id: 'Primary key (`uuidv7()`, time-ordered).',
  created_at: 'Row creation time.',
  updated_at: 'Last write time; the ORM sets it to `now()` on every update.',
}

/**
 * A column is obvious when it is one of {@link STANDARD_COLUMNS} or a plain
 * parent link: a foreign key whose name is exactly `<referenced table>_id`.
 * Anything else — including a foreign key under another name, such as
 * `server.assigned_tier_id` or `audit.actor_user_id` — carries a rule worth
 * one sentence and must be described.
 */
export function isObviousColumn(column: string, foreignKeyTable: string | undefined): boolean {
  if (column in STANDARD_COLUMNS) return true
  return foreignKeyTable !== undefined && column === `${foreignKeyTable}_id`
}

export const DATA_DICTIONARY_GROUPS = {
  identity: {
    title: 'Identity',
    blurb:
      'Who a person is to the control plane: the Better Auth-compatible user, credential, session and verification tables.',
  },
  organizations: {
    title: 'Organizations',
    blurb:
      'The tenant boundary. Organizations own every other resource; teams and teammates carry membership; the TLS tables hold the Organization CA and its rotations.',
  },
  billing: {
    title: 'Billing',
    blurb:
      'Tiers are platform-global priced offerings; licenses, payers, subscriptions and seats record what an organization bought and how each server is entitled.',
  },
  platform: {
    title: 'Access, audit and configuration',
    blurb:
      'Authorization grants, the audit ledger, instance-wide settings and the global lease table the schedulers coordinate through.',
  },
  networking: {
    title: 'Networking',
    blurb:
      'Datacenters as logical routing domains, the org network registry, managed addresses, and the TurboFabric mesh (fabric, relays, subnets).',
  },
  resources: {
    title: 'Resource tree and tagging',
    blurb:
      'Workspace → project → environment → service → hosting / container, plus the principals, tenancies, bindings and variables that hang off them, and the free-form tag and marker tables.',
  },
  managed: {
    title: 'Managed databases',
    blurb:
      'Managed database instances, their replicas, backups and recovery runs.',
  },
  storage: {
    title: 'Storage and secrets',
    blurb:
      'Storage volumes, their copies and mounts, and the sealed secret envelopes.',
  },
  runtime: {
    title: 'Servers, runtime and metrics',
    blurb:
      'Enrolled servers and their daemon keys, the command / dispatch pipeline, deployments, slots, tasks, labels, and the metrics topology generations.',
  },
  git: {
    title: 'Git and SSH',
    blurb:
      'Git forges, connections, repositories, the webhook delivery ledger and user SSH keys.',
  },
  notifications: {
    title: 'Notifications',
    blurb: 'The notification catalogue rows, delivery channels, routing rules and per-channel attempts.',
  },
} as const

export type DataDictionaryGroup = keyof typeof DATA_DICTIONARY_GROUPS

export type TableDescription = Readonly<{
  group: DataDictionaryGroup
  /** One sentence: what a row is, cardinality, who writes it. */
  summary: string
  /** Physical column name → one sentence. Standard columns are never listed. */
  columns: Readonly<Record<string, string>>
}>

/** Physical table name → description. Alphabetical within each group. */
export const SCHEMA_DESCRIPTIONS: Readonly<Record<string, TableDescription>> = {
  // ── identity ──────────────────────────────────────────────────────────
  '2fa': {
    group: 'identity',
    summary:
      'TOTP enrolment for a user, at most one row per user (`uniq_2fa_user_id`); inserted or reset on enable, verified once, and deleted when two-factor is disabled.',
    columns: {
      user_id: 'Enrolled user; unique, so re-enabling resets the existing row instead of adding one, and disable deletes it.',
      secret: 'TOTP shared secret sealed as a `tpsecret` envelope with the data-encryption key; never plaintext and never returned after enrolment.',
      is_verified: 'False until the user proves the first six-digit code; only a verified row turns on `user.is_2fa_enabled` and receives backup codes.',
      backup_codes: 'JSON array of HMAC verifier envelopes (`tpotp.vN.hex`) for the ten one-time backup codes, `[]` until verified; a used code is removed from the array.',
    },
  },
  account: {
    group: 'identity',
    summary:
      'One sign-in credential per user and provider: the local password account (`credential`) or a linked GitHub/Google identity; unique on provider plus subject.',
    columns: {
      provider_id: '`credential` for the local password account, or the OAuth provider id `github` or `google` for a linked identity.',
      provider_user_id: 'Provider-side subject: the user\'s own uuid on `credential` rows, else the GitHub/Google account id; unique together with `provider_id`.',
      access_token: 'Reserved OAuth column; the provider flow deliberately writes null and never persists provider tokens.',
      refresh_token: 'Reserved OAuth column; the provider flow deliberately writes null and never persists provider tokens.',
      id_token: 'Reserved OAuth column; the provider flow deliberately writes null and never persists provider tokens.',
      access_token_expires_at: 'Reserved OAuth column; never written by any first-party code path.',
      refresh_token_expires_at: 'Reserved OAuth column; never written by any first-party code path.',
      scope: 'Reserved OAuth column; never written by any first-party code path.',
      password: 'Argon2id PHC-format hash (`$argon2id$v=19$m=N,t=N,p=N$salt$digest`) on `credential` rows, set at sign-up, install and password reset; null on OAuth rows.',
    },
  },
  passkey: {
    group: 'identity',
    summary:
      'One WebAuthn credential registered by a user (several per user allowed), unique by `credential_id`; inserted at registration, updated on each passkey sign-in.',
    columns: {
      aaguid: 'Authenticator model AAGUID decoded from the attestation as a dashed lowercase UUID string; identifies the make, not the individual key.',
      name: 'User-chosen label given at registration (the device or authenticator it lives on); shown in the Security screen, never used for matching.',
      public_key: 'Credential public key as a JSON-serialised JWK (ES256 or RS256) converted from the attestation\'s COSE key; verifies sign-in assertions.',
      credential_id: 'Base64url credential id from the attestation; unique across the instance and the lookup key for passkey sign-in.',
      counter: 'Authenticator signature counter from the last accepted assertion; a lower value rejects the sign-in (clone detection) and updates are compare-and-swap.',
      device_type: '`multiDevice` when the attestation flags the credential backup-eligible, else `singleDevice`; derived once at registration.',
      is_backed_up: 'Backup-state flag from the attestation (credential synced by its provider); with `device_type` it drives the Synced / Multi-device / This device label.',
      transports: 'JSON array string of WebAuthn transports reported at registration (for example `internal`, `usb`, `hybrid`), or null when none were reported.',
    },
  },
  session: {
    group: 'identity',
    summary:
      'One row per signed-in session keyed by the opaque cookie `token`; rows are deleted (never extended) on sign-out or security changes and ignored once expired.',
    columns: {
      expires_at: 'Fixed at creation to now + 7 days (`SESSION_EXPIRES_IN_MS`); never extended, and lookups treat rows past it as absent.',
      token: 'Opaque server-generated value, 32 random bytes base64url-encoded; unique, carried by the session cookie and matched verbatim.',
      ip_address: 'Client address captured at sign-in as IPv4 or IPv6 text (hence 45 chars); informational only, null when unknown.',
      user_agent: 'Browser UA request header captured at sign-in; informational only, null when unknown.',
    },
  },
  user: {
    group: 'identity',
    summary:
      'One row per person who can sign in to the instance, keyed by unique `email`; created by password sign-up, OTP sign-in, OAuth sign-up or the install wizard.',
    columns: {
      metadata: 'Reserved pairing jsonb with no first-party reader or writer today; stays null.',
      options: 'Reserved pairing jsonb with no first-party reader or writer today; stays null.',
      name: 'Optional display name copied at creation from the OAuth profile or the OTP sign-in form (1-255 chars); absent on password sign-up and never edited later.',
      email: 'Unique sign-in address, trimmed at write; the identity that accounts, sessions, OTP flows and invitation accepts are matched against.',
      is_email_verified: 'True once the address is proven: set at creation by OTP or OAuth sign-up and the install wizard, or later by the verify-email link and OTP routes.',
      is_2fa_enabled: 'Derived flag kept in step with the `2fa` row: set true when TOTP enrolment is verified and false when two-factor is disabled.',
      is_disabled: 'Sign-in gate read by every authn path (password, OTP, passkey, OAuth) and refused with `account_disabled`; no control-plane route writes it today.',
      role: 'Instance role `user`, `admin` or `superadmin`; sign-ups get `user`, the install wizard mints the one `superadmin`, and admins bypass org grants.',
    },
  },
  verification: {
    group: 'identity',
    summary:
      'Short-lived email verification tokens and OTP verifiers keyed by unique `identifier`; rows are upserted per purpose and deleted or left to expire on use.',
    columns: {
      expires_at: 'Hard expiry compared at read: 24 h for verify-email links, 300 s for OTPs and their attempt counters; expired rows are ignored and replaced.',
      identifier: 'Lookup key: the bare email for verify-email links, `otp:TYPE:sha256(email)` for an OTP and `otp-attempts:TYPE:sha256(email)` for its attempt counter.',
      value: 'Never the raw secret: SHA-256 hex of the link token, a keyed HMAC envelope `tpotp.vN.hex` for an OTP, or the decimal failed-attempt count.',
    },
  },
  // ── organizations ─────────────────────────────────────────────────────
  changeover: {
    group: 'organizations',
    summary:
      'Journal row for one Organization CA rotation (at most one `in_progress` per org); never deleted, it is the audit trail and resume state of the fan-out.',
    columns: {
      metadata: 'Fan-out resume state written between passes: `resumeAfterManagedId` keyset cursor and `needsRedeploy` server/environment pairs.',
      options: 'Pairing jsonb; never written by the changeover code, stays null.',
      organization_id: 'Owning org; the partial unique index allows one `in_progress` row per org, which is what makes the row act as the rotation lease.',
      from_ca_generation: 'Generation that was active when the rotation minted its successor; 0 until the mint step has run.',
      to_ca_generation: 'New active generation minted by this rotation; 0 until minted, and a non-zero value lets a repeated request resume fan-out.',
      state: '`in_progress` (lease held), then `awaiting_retire` once fan-out converged, then `completed` when the old generation is retired, or `failed`.',
      started_at: 'When the lease was taken; reset when a stale in-progress row (older than 15 min) is stolen by another isolate.',
      completed_at: 'Set by the retire step together with `state` = `completed`; null otherwise and cleared when a stale row is stolen.',
      results: 'Array of per-server fan-out rows with `serverId`, `kind` (`ingress`, `apply` or `binding`), `managedId`, `commandId`, `status` and `error`.',
    },
  },
  invitation: {
    group: 'organizations',
    summary:
      'Team-scoped invite emailed to an address; one pending per (team, email) with a 7-day link, turned into a `teammate` row plus grants on accept.',
    columns: {
      user_id: 'The inviter (a manager of the team), not the invitee; the invitee is known only by `email` until accept.',
      team_id: 'Team the invitee joins on accept; there is no `organization_id`, the organization is derived through the team.',
      expires_at: 'Creation time + 7 days; `status` is not flipped on expiry, readers compare this column against now.',
      email: 'Invited address; accept succeeds only for a signed-in account whose email equals it case-insensitively.',
      status: '`pending` at creation, then `accepted` by the accept route or `revoked` by the revoke route; expiry is not a status.',
      grants: 'Array of `entityType` / `entityId` / `permissionKey` specs an owner attached, or null for the default `organization:manage`; written as `grant` rows on accept.',
    },
  },
  leaf: {
    group: 'organizations',
    summary:
      'Tracking row per deployed Organization-CA-signed leaf (`ingress` per server, `engine` per replica); upserted after apply succeeds, keeps no history.',
    columns: {
      server_id: 'Host the leaf is deployed on; unique per server for `ingress` rows.',
      kind: '`ingress` (ProxySQL frontend leaf on a server) or `engine` (a cluster replica\'s engine leaf).',
      managed_id: 'Engine leaves only: the managed cluster that owns the replica; must be null on `ingress` rows.',
      replica_id: 'Engine leaves only: the replica whose leaf this tracks, unique per replica; must be null on `ingress` rows.',
      ca_id: 'The `tls` Organization CA row that signed the leaf; the row is cascade-deleted with that CA.',
      ca_generation: 'Generation of the signing CA at issue time; a mismatch with the active generation makes the leaf due for renewal.',
      not_after: 'Leaf expiry (90-day lifetime); the renewal sweep treats a leaf as due when less than a third of its lifetime remains.',
      issued_at: 'When the leaf was minted; refreshed on every re-issue upsert.',
    },
  },
  organization: {
    group: 'organizations',
    summary:
      'Tenant organization; one is created by the install wizard and by every sign-up, its members come through teams, and `options` holds org-wide defaults.',
    columns: {
      metadata: 'Reserved pairing jsonb with no first-party reader or writer today; stays null.',
      options: 'Org-wide settings merged key-by-key by the organization PATCH routes (`defaultServerTimezone`, `maxServers`, `acmeEnabled`, `managedDatabase` and more).',
      name: 'Display name; `My Organization` when sign-up gives none, otherwise set by the install wizard or PATCH `/organizations/:id`.',
    },
  },
  team: {
    group: 'organizations',
    summary:
      'Team within an organization; every org gets a `Default Team` at creation, and membership in any of its teams is what makes a user an org member.',
    columns: {
      metadata: 'Reserved pairing jsonb with no first-party reader or writer today; stays null.',
      options: 'Reserved pairing jsonb with no first-party reader or writer today; stays null.',
      name: 'Display label of 1-255 chars, `Default Team` for the team created with the organization; no route creates or renames teams today.',
    },
  },
  teammate: {
    group: 'organizations',
    summary:
      'User-to-team membership row (unique per pair), the source of truth for organization membership; written at org creation and on invitation accept.',
    columns: {
      team_id: 'Team joined; unique together with `user_id`, and organization membership is derived through `team.organization_id` rather than stored here.',
    },
  },
  tls: {
    group: 'organizations',
    summary:
      'Per-organization TLS library: uploaded, Let\'s Encrypt, self-signed certificates and the Organization CA generations; `hosting.tls_id` pins rows by id.',
    columns: {
      metadata: 'Certificate facts not promoted to columns: `dnsNames`, `hasWildcard`, `notBefore`, `subject`, `issuer` and `acme` (`challengeType`, `managedBy`, `lastError`).',
      options: 'Operator knobs: `prefer` (pin priority), `autoRenew`, and `requestedHostnames` asked for on Let\'s Encrypt or self-signed create; null on Organization CA rows.',
      name: 'Operator label of 1-255 letters, digits, space, dot, underscore or dash; fixed `Organization CA` on CA rows.',
      source: '`upload`, `lets_encrypt` (Caddy-managed ACME on the host), `self_signed` or `organization_ca`; decides which other columns are meaningful.',
      certificate_pem: 'Leaf plus intermediate chain PEM; null on `lets_encrypt` rows because Caddy issues and holds the certificate on the serving host.',
      private_key_pem: 'Private key PEM sealed as a `tpsecret` envelope, never returned by the client API; null on `lets_encrypt` rows.',
      status: 'Row health `ready`, `pending`, `expired`, `failed`, `revoked` or `managed` (Caddy ACME intent); `expired` is derived at read from `not_after`, others stored.',
      not_after: 'Certificate expiry parsed from the PEM at write; epoch-0 placeholder on `managed` rows; indexed for expiry checks.',
      fingerprint_sha256: 'SHA-256 fingerprint of the leaf DER, unique per organization when set; null on `managed` rows that have no certificate yet.',
      ca_state: 'Organization CA lifecycle `active` (one per org), `retired` (still in the trust bundle) or `revoked`; null on non-CA rows.',
      ca_generation: 'Monotonic per-org counter (max + 1) assigned when a CA is minted; leaves record which generation signed them; null on non-CA rows.',
    },
  },
  // ── billing ───────────────────────────────────────────────────────────
  allowance: {
    group: 'billing',
    summary:
      'Self-hosted entitlement grant: at most one row per organization giving `quantity` free units at the custom `SX` tier so assignment runs with no subscription.',
    columns: {
      organization_id: 'Organization holding the grant; unique (`uniq_allowance_organization`), so an organization has zero or one row.',
      tier_id: 'Always the `SX` custom-rung tier row (`ensureCustomTierRow`), stored rather than looked up by label so entitlement reads on the ingest path add no query.',
      quantity: 'Free `SX` units the self-hosted runtime grants to match its active licenses; always at least 1 because writing zero deletes the row instead.',
    },
  },
  entitlement: {
    group: 'billing',
    summary:
      'Which runtime series a principal may execute on its host: one row per principal, runtime and series, realised by the daemon as a unix group membership.',
    columns: {
      runtime: 'Runtime family the grant covers, `php` or `node` (CHECK `entitlement_runtime_check`).',
      series: 'Exec boundary series such as `8.4` or `24` (digits with an optional dotted minor, CHECKed), never a patch pin; realised as group `tpphp84` or `tpnode24`.',
      granted_by: '`operator` for an explicit grant via the principal routes, `deploy` for a row deploy-prepare inserted because a service declared the runtime; both revocable.',
    },
  },
  license: {
    group: 'billing',
    summary:
      'Organization-scoped server registration key: one row per minted key, latched to one server on first enroll, soft-deleted via `revoked_at`, never tied to a tier.',
    columns: {
      server_id: 'Server that consumed this key, set once on first successful enroll (partial unique index: one license per server); null while unconsumed, SET NULL on delete.',
      name: 'Optional operator display name; `this server` is reserved for the colocated control-plane license minted at install and refused by `POST /licenses`.',
      token: 'Argon2id PHC hash of the registration key (same format as `account.password`); the plaintext is returned once at mint and cannot be recovered from this row.',
      revoked_at: 'Soft-delete timestamp set by a revoke or by an ended subscription revoking every license; non-null means inactive, and the row keeps `server_id` for audit.',
    },
  },
  payer: {
    group: 'billing',
    summary:
      'Projection of one provider customer (who pays), written only by the Stripe webhook ingress; its subject is exactly one of an organization or a user.',
    columns: {
      organization_id: 'Organization subject; exactly one of `organization_id` and `user_id` is non-null (`payer_subject_check`), and it is unique per provider when set.',
      user_id: 'User subject for a personal subscription; exactly one of `organization_id` and `user_id` is non-null (`payer_subject_check`), unique per provider when set.',
      provider: 'Payment provider that owns this customer; only `stripe` is allowed today (CHECK `payer_provider_check`), `apple` is reserved in comments but not accepted.',
      provider_customer_id: 'Provider-side customer id (Stripe `cus_...`); unique together with `provider` and the conflict target of the webhook upsert.',
      tax_id: 'Value of the first tax id the provider reports on the customer (`customer.tax_ids`), copied by the webhook for display; presence only, never validated here.',
    },
  },
  seat: {
    group: 'billing',
    summary:
      'Subscription line: `quantity` purchased licenses at one `tier`, projected from provider subscription items by the Stripe webhook (export `subscriptionItem`).',
    columns: {
      tier_id: 'Tier this line counts against, resolved from the item product via `tier.provider_product_id`; unique per subscription, RESTRICT so a used tier stays readable.',
      provider_item_id: 'Provider-side subscription item id (Stripe `si_...`), unique; when two provider items map to one tier the row keeps the first id with the summed quantity.',
      provider_price_id: 'Provider price the item bills at (Stripe `price_...`), projected from the item and restated by every mutation; the tier knows its product, not its price.',
      quantity: 'Number of licenses purchased at this tier, copied from the provider item quantity (summed when items share a tier); an ended subscription counts as zero.',
    },
  },
  subscription: {
    group: 'billing',
    summary:
      'One provider subscription per `payer`, upserted by the Stripe webhook on `provider_subscription_id`; holds status, period end, parked schedule and grace clock.',
    columns: {
      provider_subscription_id: 'Provider-side subscription id (Stripe `sub_...`); unique and the conflict target of the webhook upsert.',
      status: 'Checked status: `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`, or `unknown` for an unrecognised value.',
      provider_status: 'Provider status string verbatim, never interpreted; kept beside `status` so an unknown Stripe value lands as `unknown` plus the raw string, not a refused event.',
      current_period_end: 'End of the current billing period as the provider reports it, taken from the subscription or else its first item; null when the provider gives none.',
      schedule_id: 'Provider subscription schedule id (Stripe `sub_sched_...`) while a downgrade is parked on a schedule; null otherwise, written by the webhook projection.',
      grace_expires_at: 'Moment entitlement lapses after non-payment: latched to `past_due_since` plus 65 days while status is `past_due` or `unpaid`, cleared on any other status.',
      past_due_since: 'First moment the provider reported `past_due` or `unpaid`; latched while delinquent, cleared by any other status so a second lapse restarts the grace clock.',
    },
  },
  tier: {
    group: 'billing',
    summary:
      'Global billed offering: one row per ladder label (`S1` to `S7`, `SX`) bound to a provider product; written under Admin Tiers, deactivated and never deleted.',
    columns: {
      label: 'Ladder label `S1` to `S7` or `SX`, the unique key into the in-code ladder (`src/lib/tiers/ladder.ts`) that holds everything the tier entitles.',
      rank: 'Ladder position copied from the in-code ladder on insert, never from a request; unique, orders tiers and decides upgrade versus downgrade and greedy assignment.',
      provider: 'Payment provider the row bills through; only `stripe` is allowed today (CHECK `tier_provider_check`), matching `payer.provider`.',
      provider_product_id: 'Provider Product id (Stripe `prod_...`) chosen from the provider catalogue and verified before write; null on the custom `SX` row, which is never purchasable.',
      price_cents: 'Display cache of the product default price in minor units, written on verify and refreshed by the provider price webhooks; nothing does arithmetic on it.',
      currency: 'Display cache beside `price_cents`: lower-case ISO currency code of the provider default price, written on verify and by the price webhooks.',
      is_custom: 'Copied from the in-code ladder on insert (true only for `SX`); identity like `label` and `rank`, never changed by a patch.',
      is_active: 'Set false by a superadmin to hide the tier from new purchases; rows are deactivated, never deleted, so seats that count against it keep resolving.',
    },
  },
  // ── platform ──────────────────────────────────────────────────────────
  audit: {
    group: 'platform',
    summary:
      'Append-only trail of security-relevant operator actions (rows never updated or deleted, no `updated_at`), written by `recordAudit` after the action succeeded.',
    columns: {
      organization_id: 'Organization the action belongs to, which the org-scoped read filters on; null for an instance-wide action such as a superadmin editing an org-less forge.',
      actor_user_id: 'User who acted, SET NULL when the account is deleted; null only for an action the platform took on nobody\'s behalf, never for an operator action.',
      actor_email: 'Actor\'s email denormalised at write time so the trail still names who acted after the account is deleted.',
      action: 'Dot-joined subject and verb from `AUDIT_ACTIONS` (such as `server.delete`, `grant.create`, `organization.acme.set`); a label only, not CHECKed so it can grow.',
      target_type: 'What the action was done to: `organization`, `server`, `forge`, or the `entity_type` of the grant being created or deleted.',
      target_id: 'Id of the target row when there is one (server, forge, organization or grant entity); nullable and without an FK so the trail outlives the target.',
      context: 'Small non-secret JSON facts kept beside the action, such as `purged`, `acmeEnabled`, `deployHooksEnabled` or the grant details; never a credential.',
    },
  },
  grant: {
    group: 'platform',
    summary:
      'Allow-only ACL row: one positive grant of `permission` from a subject (`actor_type`, `actor_id`) on an entity; written by access routes, invitations, install.',
    columns: {
      actor_type: 'Subject kind holding the grant: `user`, `team` or `organization` (`SUBJECT_TYPES` in `src/client/authz/catalog.ts`).',
      actor_id: 'Id of the subject row named by `actor_type` (a `user`, `team` or `organization` id); no FK because the referenced table varies.',
      entity_type: 'Kind of the entity granted on: a resource-tree kind or `team` (`GRANT_ENTITY_TYPES`); `principal` and `repository` are deliberately excluded.',
      entity_id: 'Id of the entity row named by `entity_type`; no FK because the referenced table varies, and ancestry is resolved from the domain tables at evaluation time.',
      permission: 'Grantable permission key: `organization:own`, `organization:manage`, `team:own`, `team:manage`, `system:read` or `system:operate`; never `system:manage`.',
    },
  },
  lease: {
    group: 'platform',
    summary:
      'Cross-isolate compare-and-swap lease: one row per `name` (plus organization for the billing lock) with an `owner` token and `expires_at`; four callers share it.',
    columns: {
      name: 'Lease name: `OFFLINE_SWEEP_LOCK`, `LEAF_RENEWAL_SWEEP_LOCK` and `REENCRYPT_SWEEP_LOCK` are global, `BILLING_QUANTITY_LOCK` is per organization.',
      organization_id: 'Null for the three global leases, set for the per-organization `BILLING_QUANTITY_LOCK`; unique with `name` under NULLS NOT DISTINCT so one global row per name.',
      owner: 'Random UUID minted by the holder and checked on every steal or release; empty string plus expired `expires_at` is a release tombstone (offline, leaf).',
      expires_at: 'Moment the hold lapses and the row becomes stealable (TTL 60 s billing, 90 s offline sweep, 120 s leaf renewal and reencrypt); extended or reset by the holder.',
      cursor: 'Keyset resume point (`notAfter`, `id`) written only by the leaf-renewal sweep and compared on every steal with `owner` and `expires_at`; null elsewhere.',
    },
  },
  setting: {
    group: 'platform',
    summary:
      'Instance-wide key/value store: one row per upper-case `key` with a JSON `value`, written by the settings resolvers, install state and the billing side-ledgers.',
    columns: {
      key: 'Unique upper-case key such as `SYSTEM_EMAIL`, `SYSTEM_AUTH_PROVIDERS`, `IS_SIGNUP_ENABLED`, or `BILLING_PENDING_CHANGES:` followed by an organization id.',
      value: 'JSON value for the key (scalar, array or object); any secret inside it is stored only as a sealed `tpsecret` envelope, never in plaintext.',
    },
  },
  // ── networking ────────────────────────────────────────────────────────
  datacenter: {
    group: 'networking',
    summary:
      'Logical routing domain (not a building) of mutually routable private subnets, operator-created per org; a server may belong to zero or many via `ip` pins.',
    columns: {
      metadata: 'Free-form jsonb returned by the datacenter API; no control-plane code path writes or interprets any key on it today.',
      options: 'Operator policy jsonb: `priority` (0..1000, lower wins, default 100), `trusted` (default true), `addressPreference`, `sshPort`, `ntp`, timezone defaults.',
      name: 'Operator-chosen display name; also seeded onto the site `network` row created together with the datacenter.',
      description: 'Optional operator free-text note about the datacenter.',
    },
  },
  fabric: {
    group: 'networking',
    summary:
      'Org TurboFabric WireGuard mesh (host interface `tp0`), at most one row per organization; absence means TurboFabric is off and private keys are never stored.',
    columns: {
      metadata: 'Free-form jsonb; no control-plane code path writes or reads it today.',
      options: 'Mesh policy jsonb: `containerPool` (relay prefix pool, default `10.192.0.0/12`), `listenPort` (default 51821), `mtu` (1280..9000, default 1420), `allowRelay`.',
      cidr: 'Host `tp0` address range that relay `address` values are carved from, auto-picked at enable to avoid every occupied org range (default `10.250.0.0/16`).',
      name: 'Optional display name (1..255 chars of letters, digits, space, dot, underscore, dash); no control-plane code path writes it today.',
    },
  },
  ip: {
    group: 'networking',
    summary:
      'Single registry of every managed address per org, one row per address: public VPS addresses, datacenter free-pool rows and per-server membership pins.',
    columns: {
      metadata: 'Pin markers written by the automatic repin pass: `repin` (`at`, `from` = previous address) and `stale` (`since`, `reason`) when no clear replacement exists.',
      options: 'Free-form jsonb accepted on address create and echoed by the API; no control-plane code path interprets any key on it.',
      datacenter_id: 'Datacenter this address belongs to; required when `scope = \'datacenter\'`, null on public addresses; rows cascade away when the datacenter is deleted.',
      network_id: 'Site subnet the address sits in; required on a membership pin (`scope = \'datacenter\'` plus `server_id`), null on public and free-pool rows, set null on delete.',
      server_id: 'Server holding this address; null marks a datacenter free-pool row, non-null together with `datacenter_id` makes a membership pin; server delete is restricted.',
      address: 'IPv4 or IPv6 address (inet, unique per organization); the family is derived from it, not stored; immutable after create except via the automatic repin pass.',
      allocation: 'Operator-chosen consumer model, `dedicated` (one consumer) or `shared`; immutable after create, and pins made by the datacenter routes are always `dedicated`.',
      scope: 'Reachability class, `public` (world-reachable) or `datacenter` (inside one of the org\'s site subnets, `datacenter_id` required); immutable after create.',
      description: 'Optional operator note and the only editable field on an address; addresses are identified by `address`, never named.',
      repin_pending_fanout_at: 'Set by the automatic repin apply pass when a pin moved address, cleared by the maintenance sweep once the routing fan-out was enqueued; null = nothing pending.',
    },
  },
  network: {
    group: 'networking',
    summary:
      'Org-owned network registry row of `kind` datacenter, docker, compose, managed or reserved; which scope FKs and `cidr` may be set is fixed per kind by a CHECK.',
    columns: {
      metadata: 'Free-form jsonb; the only reader is a legacy fallback that accepts `metadata.dockerNetworkName` when `options` lacks it, and nothing writes it today.',
      options: 'Kind-specific jsonb: `dockerNetworkName` plus optional `subnet`, `ipRange`, `gateway`, `mtu` on docker rows; `dockerNetworkName` (row UUID) on compose/managed.',
      datacenter_id: 'Owning datacenter, required and only allowed on `kind = \'datacenter\'` site CIDR rows (a datacenter may own several); datacenter delete is restricted meanwhile.',
      server_id: 'Optional host pin allowed only on `kind = \'docker\'` external Docker registrations (null = org-wide); every other kind must leave it null.',
      environment_id: 'Optional environment pin for `kind = \'compose\'` spanning networks (null = org-shared); set null when the environment is deleted so the row survives.',
      kind: 'Row kind: `datacenter` (site CIDR), `docker` (external Docker network), `compose` (TurboFabric spanning network), `managed` (one per org) or `reserved`.',
      cidr: 'Registered range: required on `datacenter` and `reserved` rows, mirrored from `options.subnet` on `docker` rows, null on `managed`; checked for collisions.',
      name: 'Display name; operator-set on docker and reserved rows, seeded from the datacenter name on site rows, and the Compose network key on compose rows.',
      compose_key: 'Compose network key from the environment\'s document on `kind = \'compose\'` rows (unique per environment), written by `ensureComposeNetworkRow`; null otherwise.',
    },
  },
  relay: {
    group: 'networking',
    summary:
      'One server\'s membership in an org TurboFabric mesh (one row per fabric and server), allocated by `ensureFabricRelays`; holds its `tp0` address and peer config.',
    columns: {
      metadata: 'Control-plane reconcile stamps: `appliedPayloadHash`, `appliedAt`, `observed` (peers the daemon saw) and diagnostics-only `paths` (selected path per peer).',
      options: 'Relay policy jsonb merged by PATCH: `allowRelay` (true or false, null inherits the org and may only tighten) and `preferredGatewayIds` (ordered, deduped).',
      server_id: 'Member server, unique per fabric; delete is restricted, so `deleteServerFabricMembership` must remove the relay and its subnets first.',
      address: 'Allocated `tp0` host address (inet) carved from `fabric.cidr`, unique per fabric and rendered as a /32 host route in peer AllowedIPs.',
      role: 'Mesh role, `gateway` (advertises `advertised_cidrs` to remote peers, must belong to a datacenter with a subnet) or `member` (host route only, the default).',
      keepalive: 'Operator WireGuard PersistentKeepalive in seconds (1..65535); null means auto, which is 25 s on `direct_nat` paths and none otherwise.',
      endpoint_address: 'Operator endpoint override (inet, no port); null means the path planner derives the endpoint from datacenter, public and daemon-reported addresses.',
      public_key: 'Server\'s WireGuard public key, stamped by the control plane from the first successful `server.fabric.reconcile` result; null until then, unique per fabric.',
      prefix: 'Container aggregate CIDR (a /16 from `fabric.options.containerPool`) allocated to this server and forwarded over `tp0`; per-network subnets are carved from it.',
      advertised_cidrs: 'Operator-configured LAN CIDRs a `gateway` relay advertises to remote peers (native cidr[], host bits cleared); must be empty when `role = \'member\'`.',
      preshared_key: 'Sealed `tpsecret` envelope of the operator-set WireGuard preshared key; write-only, never returned by the API, resealed for the daemon at reconcile.',
    },
  },
  subnet: {
    group: 'networking',
    summary:
      'Per-server realization of a `kind = \'compose\'` spanning network, one row per network and server, written by `ensureNetworkSubnet` when spanning networks build.',
    columns: {
      metadata: 'Free-form jsonb; no control-plane code path writes or reads it today.',
      options: 'Optional segment extras read by `parseSegmentNetworkExtras` when rendering the Docker bridge: `mtu` (1280..9000) and an IPv4 `gateway`; no writer found today.',
      network_id: 'Spanning network (`kind = \'compose\'` row) this per-server subnet realizes, unique together with `server_id`; rows cascade away with the network.',
      server_id: 'Server hosting this segment; delete is restricted, so `deleteServerFabricMembership` removes the subnets first.',
      cidr: 'Server-local Docker bridge subnet for the network, the lowest free /24 carved from the server\'s `relay.prefix` around org exclusions by `requireSubnetCidr`.',
    },
  },
  // ── resources ─────────────────────────────────────────────────────────
  binding: {
    group: 'resources',
    summary:
      'Join edge attaching a managed-database principal to a consuming compose service; materializes system-owned `variable` rows for deploy credential injection.',
    columns: {
      metadata: 'Reserved jsonb; no current code path writes it.',
      options: 'Reserved jsonb; no current code path writes it.',
      principal_id: 'Managed database user whose credentials are injected; cascade-deleted with the principal (user gone, binding gone).',
      service_id: 'Consuming compose service; ON DELETE RESTRICT so a service with bindings cannot be deleted.',
      database_name: 'Database inside the cluster the credentials point at (1-63 chars, identifier charset); must be one of the cluster\'s `options.databases`.',
      key_prefix: 'Environment variable prefix for the emitted credential keys (default `DATABASE`), unique per service; identifier charset, 1-64 chars.',
      is_emit_engine_defaults: 'When true, also emit the unprefixed conventional engine keys (PG*, MYSQL_*); at most one such binding per service (API field `emitEngineDefaults`).',
    },
  },
  container: {
    group: 'resources',
    summary:
      'Pins one Docker container to a service and the server observed to host it; rows are pre-allocated at deploy and upserted from the daemon\'s post-deploy report.',
    columns: {
      metadata: 'Free-form jsonb accepted from `POST /containers` and `PATCH` with identity keys stripped; no platform code path writes or reads it.',
      options: 'Free-form jsonb accepted from `POST /containers` and `PATCH` with identity keys stripped; no platform code path writes or reads it.',
      server_id: 'Observed placement: the server hosting this container (RESTRICT), distinct from the desired pin on `environment.server_id`.',
      container_id: 'Docker container id from the daemon\'s report; NULL between pre-allocation and the first report, and reset to NULL on an empty (stop/destroy) report.',
      container_name: 'Docker `container_name`; `uuid` naming yields the service UUID plus `-N` per ordinal, `-in` for ingress, `-ha` for Orchestrator; `custom` keeps authored names.',
      status: '`pending` until the daemon reports, then Docker\'s compose ps State verbatim (`created` through `dead`), `unknown` for an unlisted state, `exited` on stop.',
      role: '`service` for workload or engine replicas, `ingress` for the per-service Traefik or shared ProxySQL frontend (ordinal 1), `turbopanel` for the platform stack.',
      compose_service_name: 'Compose service key the container was started under, as reported by the daemon; multi-instance clones carry a `-N` suffix on the base key.',
      ordinal: '1-based instance index within the service, unique with `service_id` and `role`; ingress rows are always 1 and managed replicas match `replica.ordinal`.',
    },
  },
  environment: {
    group: 'resources',
    summary:
      'One deployable copy of a project (staging, production) pinned to a server and deployed as a unit; created via the API or by the platform for system projects.',
    columns: {
      metadata: 'Client jsonb; the promoted keys `serverId` and `component` are stripped on create and patch so placement and system identity never live here.',
      options: 'Jsonb whose `compose` key is the per-environment ComposeDocument overlay merged onto the project compose at deploy; placement keys are stripped on save.',
      server_id: 'Desired whole-server placement pin and single source of truth; NULL inherits `project.options.defaultServerId` at deploy, lifecycle and stop.',
      generation: 'Monotonic desired generation, incremented once per deploy plan by `bumpEnvironmentGeneration` and fanned into `deployment.desired_generation`.',
      name: 'Display label under `environment_name_format_check` (letters, digits, space, `._/-`, 1-255 chars); the first environment takes the organization default name.',
      description: 'Optional free-text description written by the client API; the first environment is created with \'Default environment\'.',
    },
  },
  hosting: {
    group: 'resources',
    summary:
      'Routing entry for a service (hostnames or TCP/UDP ports, bind scope, TLS pin) rendered into Caddy and Traefik; written by the panel API or compose reconcile.',
    columns: {
      metadata: 'Compose provenance markers `composeOwned`, `composeServiceName`, `composeRoute`, `composeTlsMode`, `composeAdopted` set by reconcile; other keys are client-set.',
      options: 'Validated routing jsonb: `hostnames`, `pathPrefix`, `targetPort`, `protocol`, `ports`, `bind` (`public`, `datacenter`, `local`), `proxy` toggles, `web` hints.',
      tls_id: 'Optional pin into the organization TLS library; NULL means Caddy `tls internal` (self-signed), and the pin is cleared when the certificate row is deleted.',
      ip_id: 'Optional pin to a registered `ip` row of scope `public` for ingress addressing; requires `bind: public` and is cleared when the ip row is deleted.',
      name: 'Display label: compose reconcile sets it to the hostname on compose-owned rows, otherwise the panel API writes it; no format CHECK, app-side length cap.',
      description: 'Optional free-text description; panel-authored and preserved across compose reconcile.',
      protocol: 'Mirror of validated `options.protocol` (`http`, `tcp`, `udp`) kept so SQL can filter ingress decisions without a jsonb cast; NULL reads as `http`.',
    },
  },
  hostname: {
    group: 'resources',
    summary:
      'Uniqueness mirror of `hosting.options.hostnames`, one row per hostname, replaced on every hosting write so Postgres can enforce one hostname per organization.',
    columns: {
      routing_organization_id: 'Organization whose routing owns the hostname, half of the unique key; today always the hosting\'s own organization, named for future cross-organization hosting.',
      hostname: 'One DNS name copied verbatim from `hosting.options.hostnames` by `replaceHostingHostnames`; unique per routing organization regardless of path prefix.',
    },
  },
  marker: {
    group: 'resources',
    summary:
      'Join edge applying one tag to exactly one taggable entity; org is derived through `tag`, and `setEntityTags` replaces an entity\'s whole set.',
    columns: {
      server_id: 'Tagged server when the parent is a server; exactly one of the seven parent columns is non-NULL (CHECK), unique per tag, cascades on delete.',
      workspace_id: 'Tagged workspace when the parent is a workspace; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.',
      project_id: 'Tagged project when the parent is a project; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.',
      environment_id: 'Tagged environment when the parent is an environment; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.',
      service_id: 'Tagged service when the parent is a service; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.',
      datacenter_id: 'Tagged datacenter when the parent is a datacenter; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.',
      storage_id: 'Tagged storage when the parent is a storage; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.',
    },
  },
  principal: {
    group: 'resources',
    summary:
      'Account identity attachable to services: a Linux host account (`system`) or a managed database user (`database`); written by principal store and managed API.',
    columns: {
      metadata: 'System principals: `home` (under `/srv/users`), optional `uid`/`gid` mirror, `composeAlias`; managed users: `managedRoot`, `engine`, `databases`.',
      options: 'Host-account settings: `shell` (closed allowlist, default `/usr/sbin/nologin`) and optional operator `uid`/`gid` override; parsed by `parsePrincipalOptions`.',
      kind: '`system` for a Linux server host account or `database` for a managed engine user.',
      provider: 'System that owns the account: `server` for host accounts, or the engine (`postgres`, `mysql`, `redis`, `clickhouse`) for database users.',
      username: 'Short internal account name (letter or underscore first, then letters, digits, underscore, hyphen); server accounts get a shorter API-layer cap.',
      applied_username: 'Login actually created on the host or engine: `username`, or `username` plus an underscore and 11 random chars when the org randomizes names; fixed at create.',
      password: 'Write-only credential sealed as a `tpsecret` envelope, never returned on GET and resealed to `tpdaemon` for delivery; null when no engine password exists.',
      organization_id: 'Home organization set on every insert, not derived; for a managed user it is the cluster\'s home org via its environment, not the hosting servers\' orgs.',
      project_id: 'Optional project scope for compose-declared hosting principals; cascade-deleted with the project.',
      managed_id: 'Optional managed-engine scope for database users (root and per-user rows); cascade-deleted with the cluster.',
    },
  },
  project: {
    group: 'resources',
    summary:
      'One application or stack described by one compose document, owned by a workspace; user projects come from the API, system projects from the platform hierarchy.',
    columns: {
      metadata: 'Client jsonb: `type` is `docker-compose`, `managed`, `template` or platform-only `system` (absent means setup not chosen yet), plus optional catalog `code`.',
      options: 'Jsonb holding `compose` (the base ComposeDocument), `containerNaming` (`uuid` or `custom`), `defaultServerId` and `composeSource` seed provenance.',
      organization_id: 'Denormalized copy of the workspace\'s organization, resolved on every insert; exists so `uniq_project_organization_name` can be a real per-organization unique.',
      repository_id: 'The single Git repository this project is; NULL when not repository-backed, adopted from the first compose `sourceId` on save, RESTRICT on delete.',
      name: 'Display label, unique per organization after trim and case-fold (partial unique index, 409 `project_name_in_use`); four system project names are reserved.',
      description: 'Optional free-text description written by the client API; no format CHECK, app-side length cap only.',
      component: 'System-component discriminator (`hosting-ingress`, `managed-ingress`, `managed-ha`, `turbopanel`) written by the platform hierarchy; NULL on every user project.',
    },
  },
  service: {
    group: 'resources',
    summary:
      'One deployable unit (a compose service) within an environment; rows are derived from the compose document by reconcile, managed allocation or daemon reports.',
    columns: {
      metadata: 'Client jsonb reserved for non-indexed facts; promoted identity keys are stripped on write and the compose name never lives here.',
      options: 'Validated per-service settings jsonb: `instances`, `build`, `operations`, `healthCheck`, `resources`, plus deploy hooks when the organization enables them.',
      name: 'User-facing label (formerly `display_name`) under `service_name_format_check`, nullable and not unique; reconcile defaults it to the compose service key.',
      description: 'Optional free-text description written by the client API.',
      compose_service_name: 'Compose service key, derived only: written by compose reconcile, managed allocation and daemon-report reconcile, never by a client; unique per environment.',
    },
  },
  tag: {
    group: 'resources',
    summary:
      'Organization-owned tag definition written by the tags routes; names are labels unique per organization after lower-casing and trimming.',
    columns: {
      metadata: 'Sparse jsonb bag reserved by the repo-wide column convention; no code path writes it for tag rows today.',
      options: 'Sparse jsonb bag reserved by the repo-wide column convention; no code path writes it for tag rows today.',
      name: 'Operator-chosen label, unique per organization on `lower(btrim(name))`; no format CHECK in the database.',
      description: 'Optional free-text description normalized like a display name; NULL when empty.',
      color: 'Optional display colour as a `#rgb` or `#rrggbb` hex string; NULL when unset.',
    },
  },
  tenancy: {
    group: 'resources',
    summary:
      'Join edge marking the Linux/system principal a compose service runs as; unique (principal_id, service_id), written by the principal store and compose reconcile.',
    columns: {
      principal_id: 'System principal that stewards the service (runs as, owns the site tree); cascade-deleted with the principal.',
      service_id: 'Consuming compose service; ON DELETE RESTRICT so a service delete must clear its run-as edges first.',
    },
  },
  variable: {
    group: 'resources',
    summary:
      'One config key/value at exactly one scope (organization, workspace, project, environment, service, hosting or server), resolved narrowest-wins into deploy env.',
    columns: {
      organization_id: 'Organization scope parent, the widest inheritance level; exactly one of the seven scope columns is non-null (`variable_exactly_one_parent_check`).',
      workspace_id: 'Workspace scope parent, overriding organization values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.',
      project_id: 'Project scope parent, overriding workspace values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.',
      environment_id: 'Environment scope parent, overriding project values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.',
      service_id: 'Service scope parent, overriding environment values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.',
      hosting_id: 'Hosting scope parent, the narrowest level, merged per service at deploy (later hosting wins); exactly one of the seven scope columns is non-null.',
      server_id: 'Server scope parent, resolved per server at deploy and outside the inheritance chain; exactly one of the seven scope columns is non-null.',
      binding_id: 'When set the row is system-owned, materialized by a managed-database binding; client PATCH/DELETE return 403 and the row cascades with the binding.',
      key: 'Environment variable name matching `^[A-Za-z_][A-Za-z0-9_]*$`, unique per scope parent via partial unique indexes.',
      value: 'Plaintext for non-secrets; for secrets a sealed `tpsecret` envelope (data-encryption key) the API never returns and deploy delivers as a file.',
      is_secret: 'True marks the value sealed and write-only: read back as null, never interpolated into YAML or `.env`, compiled to a Compose secret file at deploy.',
      is_literal: 'True escapes `$` so Docker Compose does not interpolate the value; false leaves a `$OTHER` reference for Compose to expand (API field `isLiteral`).',
      is_for_build: 'True injects the non-secret value into `build.args` at deploy (API field `forBuild`); default false.',
      is_for_runtime: 'True injects the non-secret value into the container `environment` at deploy (API field `forRuntime`); default true.',
      description: 'Optional free-text note written by the client API.',
    },
  },
  workspace: {
    group: 'resources',
    summary:
      'Grouping of projects inside one organization; operator rows are `kind=\'user\'` and each organization also holds exactly one platform `turbopanel` workspace.',
    columns: {
      name: 'Display label under `workspace_name_format_check` (letters, digits, space, `._-`), unique per organization at the API; \'TurboPanel\' is reserved from first boot.',
      description: 'Optional free-text description written by the client API; no format CHECK, app-side length cap only.',
      kind: 'Workspace discriminator: `user` (default, operator-created) or `turbopanel` (the single machine workspace per organization, provisioned at install).',
    },
  },
  // ── managed ───────────────────────────────────────────────────────────
  backup: {
    group: 'managed',
    summary:
      'One completed managed-engine backup artifact recorded from the daemon\'s `managed.backup` result; unique per (managed_id, backup_id), cascades with the cluster.',
    columns: {
      backup_id: 'Daemon-minted `bk_` plus hex token that is also the artifact filename on the host; unique per managed engine, not globally.',
      size_bytes: 'Artifact size in bytes as reported by the daemon after writing the dump; re-checked before a restore.',
      checksum: 'Lowercase SHA-256 hex digest of the artifact computed by the daemon; a restore refuses on mismatch.',
      database: 'Database name for a single-database backup; null for an instance-scope backup.',
      path: 'Absolute artifact path on the primary server\'s filesystem as reported by the daemon.',
    },
  },
  managed: {
    group: 'managed',
    summary:
      'One managed database cluster per environment (1:1 via unique environment_id); created by the managed create route, status projected by the command consumer.',
    columns: {
      metadata: 'Residual cluster facts: `rootPrincipalId` and `rootUsername` set at create, plus `host`, `port` and `error` written by the command consumer from daemon results.',
      options: 'Operator settings jsonb with keys `settings` (engine ManagedSettings) and `databases` (string array), written by the managed routes and parsed per engine spec.',
      environment_id: 'Owning environment; exactly one managed row per environment (unique index), cascade-deleted with it.',
      server_id: 'Placement pin of the primary member\'s host, copied from the environment at create and re-set by the consumer only on a primary-member apply success.',
      name: 'Operator label for the cluster (1-255 chars of letters, digits, space, dot, underscore, hyphen); null when unnamed.',
      engine: 'Catalog engine code set once at create from ManagedEngineSpec: `postgres`, `mysql`, `mariadb`, `redis` or `clickhouse` (only the first three are creatable).',
      status: 'Lifecycle state: `provisioning` at create, `applying` while a command is queued, then daemon-observed `ready`, `stopped` or `failed` projected by the consumer.',
    },
  },
  recovery: {
    group: 'managed',
    summary:
      'Durable HA journal entry for one managed cluster recovery (failover, switchover or DR); at most one non-terminal row per managed_id, written by the HA flow.',
    columns: {
      metadata: 'Fencing and progress facts: `fencingEpoch`, `fenceCommandIds`, `promoteCommandId`, `haPresent`, `fenced`, `drainApplied`, `lagBytes`, `blockedReason`.',
      options: 'Reserved jsonb; no current code path writes it.',
      kind: '`automatic-failover`, `switchover` (planned promotion of a failover replica) or `disaster-recovery` (promotion of a remote read replica).',
      source_primary_member_id: '`replica.id` of the primary being replaced, stored without an FK so deleting the member cannot block the journal.',
      target_member_id: '`replica.id` of the member being promoted, stored without an FK; null when an automatic failover was `blocked` with no eligible candidate.',
      state: 'Journal phase: `detecting`, `fencing`, `promoting`, `repointing`, `reconciling-ingress`, `verifying`, then terminal `completed`, `failed` or `blocked`.',
      started_at: 'When the recovery was opened; set explicitly by `insertRecovery` together with the initial state.',
      completed_at: 'When the recovery reached a terminal state; null while still in flight.',
    },
  },
  replica: {
    group: 'managed',
    summary:
      'One server\'s membership in a managed cluster (primary plus replicas); exactly one `primary` per managed_id, written by the member lifecycle and the consumer.',
    columns: {
      metadata: 'Daemon-observed `replication` health (`state`, `observedAt`, optional `lagBytes`, `lagSeconds`) written by the consumer after apply and lifecycle commands.',
      options: 'Reserved jsonb; no current code path writes it.',
      server_id: 'Host running this member; one member per server per cluster and a private port is unique per server; deleting the server is restricted.',
      role: '`primary` or `replica`; a partial unique index allows one primary per cluster and the consumer swaps roles on promote and failover.',
      replica_class: '`failover` (same datacenter, promotable) or `read` (any org server, never auto-promoted); null on the primary and ignored when role is primary.',
      is_read_eligible: 'Whether the listener may route read-only logins to this member; true on the primary, operator-chosen on replicas (API field `readEligible`).',
      ordinal: '1-based member ordinal, unique per cluster; the primary is 1 and it mirrors the engine service\'s container ordinal.',
      replication_transport: 'Resolved private path from this member to the primary: `local`, `datacenter`, `fabric` or `public`; null until resolved or on the primary.',
      private_port: 'Host port 45000-45999 published on the member\'s private address for replication and ProxySQL backends; allocated per server, null for single-member clusters.',
      status: 'Per-member state: `provisioning`, `applying`, `ready`, `stopped`, `failed` or `needs_resync` (set on demote or a failed fence, never auto-cleared).',
    },
  },
  // ── storage ───────────────────────────────────────────────────────────
  copy: {
    group: 'storage',
    summary:
      'One physical copy of a storage identity (docker volume or host path today); one `primary` per storage, local copies pin `server_id`, remote ones leave it null.',
    columns: {
      metadata: 'Free-form jsonb passed through from the copy API; no keys are read by the platform today.',
      options: 'Provider options: compose-registered docker copies carry `managed` (true when Compose owns the volume) and `externalName` for external volumes.',
      server_id: 'Host holding a local `docker` or `path` copy, unique with storage and provider; null for remote/shared providers; ON DELETE RESTRICT.',
      secret_id: 'Optional provider credential from `secret` for remote providers; ON DELETE RESTRICT; unused by the docker and path providers.',
      provider: '`docker` or `path` today; `block`, `nfs`, `cifs`, `s3`, `s3_compatible`, `sftp`, `ftp` and `webdav` are reserved and not accepted by the API.',
      role: '`primary` (one per storage; anchors the access-mode placement check), `replica`, `scratch` (never mountable) or `archive`.',
      state: 'Materialization state: `pending`, `materializing`, `ready`, `syncing`, `stale`, `failed` or `retiring`; set via the API, defaults to `pending`.',
      path: 'Host filesystem path for a `path` copy; null means the platform layout or the principal\'s volumes directory is resolved at deploy and never persisted.',
      endpoint: 'Remote endpoint for network providers; API passthrough, unused by `docker` and `path` copies.',
      generation: 'Reserved generation counter, default 0; no current code path increments it.',
    },
  },
  mount: {
    group: 'storage',
    summary:
      'Attachment of a storage identity inside one compose service at a container path; unique (service_id, destination_path), written by the storage API and compose.',
    columns: {
      metadata: 'Free-form jsonb settable through the mount API; no keys are read by the platform today.',
      options: 'Reserved jsonb; no current code path writes it.',
      service_id: 'Consuming compose service; ON DELETE RESTRICT, so compose unregister clears mounts in the same transaction as the service reconcile.',
      destination_path: 'Container path the storage is mounted at, unique per service.',
      subpath: 'Optional subdirectory of the storage to mount instead of its root; forwarded to the daemon when non-empty.',
      is_read_only: 'Mount the storage read-only in the container (API field `readOnly`); default false.',
    },
  },
  secret: {
    group: 'storage',
    summary:
      'Org-owned sealed secret for storage providers and git deploy keys; `secret_envelope` is one `tpsecret` payload, written today only by the deploy-key route.',
    columns: {
      metadata: 'Non-secret descriptors; for `git_deploy_key` rows: `publicKey`, `fingerprint` and `keyType` (`ed25519`).',
      options: 'Reserved jsonb; no current code path writes it.',
      principal_id: 'Optional association with a principal (SET NULL on delete so a principal delete never fails on an org secret); no current writer sets it.',
      provider: '`s3`, `s3_compatible`, `nfs`, `cifs`, `sftp`, `ftp`, `webdav` (reserved storage providers) or `git_deploy_key` (the only one written today).',
      name: 'Operator label for the secret; not an identifier and not unique.',
      secret_envelope: '`tpsecret` envelope of provider-specific JSON; for `git_deploy_key` the sealed plaintext is the OpenSSH private key verbatim, resealed unopened for the daemon.',
    },
  },
  storage: {
    group: 'storage',
    summary:
      'Logical identity of persistent data owned by an organization and scoped to at most one of workspace, project, environment or service; bytes live on `copy` rows.',
    columns: {
      metadata: 'Free-form jsonb from the API; `dockerVolumeName` is stamped to the storage UUID on volume create because the Docker volume name is the storage id.',
      options: 'Free-form jsonb passed through from the storage API; no keys are read by the platform today.',
      organization_id: 'Owning organization stored directly (an intentional exception to derived ownership); cascade-deletes the storage with the org.',
      workspace_id: 'Optional workspace scope, at most one scope column may be set; SET NULL on delete so a `retain` row survives as org-owned storage.',
      project_id: 'Optional project scope, at most one scope column may be set; SET NULL on delete so a `retain` row survives as org-owned storage.',
      environment_id: 'Optional environment scope (compose volumes are environment-scoped), at most one scope column set; SET NULL on delete so `retain` rows survive.',
      service_id: 'Optional service scope, at most one scope column may be set; SET NULL on delete so a `retain` row survives as org-owned storage.',
      kind: '`volume` (named Docker volume), `directory`, `file` (sealed content) or `object` (reserved, not accepted by the API).',
      name: 'Operator label, or the Compose volume key for auto-registered volumes; up to 255 chars with no charset CHECK.',
      access_mode: '`single_writer` (default), `multi_reader` or `multi_writer`; single_writer refuses a deploy scheduled on a server other than the primary copy\'s.',
      retention: '`retain` (default) keeps the row as org-owned when its scope parent is deleted; `delete` removes it with the parent.',
      generation: 'Reserved generation counter, default 0; no current code path increments it.',
      principal_id: 'Optional owning system principal; path copies without an explicit `path` resolve under that principal\'s volumes directory; SET NULL on delete.',
      content_envelope: 'Sealed file content for `kind=\'file\'` entries (`tpsecret` at rest, resealed to `tpdaemon` at deploy); up to 256 KiB plaintext; null otherwise.',
      compose_volume_key: 'Compose top-level volume key for auto-registered `volume` rows; unique per environment and the idempotency key for compose volume registration.',
    },
  },
  // ── runtime ───────────────────────────────────────────────────────────
  capability: {
    group: 'runtime',
    summary:
      'Append-only history of resolved v5 metrics capability plans per server (one row per server and generation), inserted only when the resolved plan hash changes.',
    columns: {
      generation: 'Control-plane counter starting at 0 and incremented by one each time the resolved plan hash differs from the latest recorded row; unique per server.',
      plan_hash: 'SHA-256 hex of the canonical field-ordered plan, domain-separated with the prefix `turbopanel:metrics-capability-plan:`; the cheap did-it-change comparison key.',
      plan: 'Full resolved `MetricsCapabilityPlan` snapshot stored for audit and debugging; jsonb so the plan shape needs no migration.',
      applied_at: 'Control-plane timestamp taken when this generation row was written during metrics ingest plan resolution, not a daemon-reported time.',
    },
  },
  command: {
    group: 'runtime',
    summary:
      'Append-only command history, one row per attempt dispatched to a daemon; created by routes and reconcilers, advanced by `transitionCommand`; UI status source.',
    columns: {
      metadata: 'Follow-up-chain blob only (`pendingStandbyApplies`, `managedDestroyGate`, `followUpPromote`, `pendingTlsLeaf`, `desiredHash`) and one-shot claim flags.',
      options: 'Unused today; kept only for the schema rule that pairs `metadata` with `options`.',
      actor_type: '`user` for an operator request or `system` for the control plane\'s own reconcilers, sweeps and webhooks (mirrors `COMMAND_ACTOR_TYPES`); no FK.',
      actor_id: 'Id of the acting user, or of the triggering entity (usually the server) when `actor_type` is `system`; no FK.',
      name: 'Command type from `COMMAND_TYPES` in commands/types.ts, such as `daemon.ping`, `environment.deploy`, `managed.apply` or `system.reconcile`.',
      status: 'State `queued`, `dispatching`, `sent`, `acked`, `running`, then terminal `succeeded`, `failed`, `timed_out` or `cancelled`; set by `transitionCommand`.',
      attempts: 'Dispatch retry count, incremented by the queue consumer each time it picks the command up.',
      context: 'Allowlisted non-secret identifier bag (`managedId`, `environmentId`, `generation`) extracted by commands/context.ts so reads never need the dispatch payload.',
      result_summary: 'Small bounded typed result reported by the daemon on completion (API field `result`); execution logs live in the execution-log store, not here.',
      error_code: 'Machine-readable terminal error code set when the command fails or times out.',
      error_message: 'Human-readable terminal error text (API field `error`) set alongside `error_code`.',
      queued_at: 'Set by `transitionCommand` when the status becomes `queued`.',
      dispatch_started_at: 'Set when the queue consumer picks the command up (status `dispatching`).',
      sent_at: 'Set when the command is enqueued to the daemon cell outbox (status `sent`).',
      acked_at: 'Set when the daemon acknowledges receipt (status `acked`).',
      started_at: 'Set when the daemon reports that execution has begun (status `running`).',
      finished_at: 'Set when the command reaches any terminal status.',
      expires_at: 'Optional deadline: once passed, the consumer marks the command `timed_out` instead of dispatching it; consumer-made follow-ups set 10 minutes, NULL means none.',
      managed_destroy_gate_id: '`metadata.managedDestroyGate.gateId` promoted to an indexed column so gated replica-destroy completions can be filtered; `memberIds` stays in jsonb.',
    },
  },
  deployment: {
    group: 'runtime',
    summary:
      'Current desired and applied state per (environment, server) pair, upserted on each redeploy by deploy-routes.ts; history lives in `environment.deploy` commands.',
    columns: {
      metadata: 'Jsonb patched on apply outcome: `error` holds the last failure message and is reset to null on success.',
      options: 'Per-target apply inputs written at deploy time: `secretPlan` and `siteReleases` (release trees the compose declares) for that server.',
      desired_generation: 'Environment deploy generation this row targets, written by deploy-routes.ts for every planned and drained server on each deploy.',
      applied_generation: 'Generation the daemon last applied successfully on this server, set on the `applied` transition; NULL until a first success.',
      desired_hash: 'sha256 of this server\'s compiled runtime compose.yaml for the desired generation; NULL for draining targets.',
      status: '`pending`, `applying` (deploy command created), `applied`, `failed`, or `draining` (server dropped from the plan, awaiting cleanup); set by deploy-routes.',
      last_command_id: 'Id of the `command` row for the most recent apply attempt on this pair; no FK, it is the join key from current state into the append-only command history.',
      finished_at: 'When the last apply attempt reached a terminal state; summarizes only the latest attempt.',
      duration_ms: 'Wall-clock duration of the last apply attempt in milliseconds; NULL when unknown.',
      outcome: 'Terminal outcome of the last apply attempt: `applied`, `failed` or `timed_out` (the command\'s own terminal status); NULL until one finishes.',
    },
  },
  dispatch: {
    group: 'runtime',
    summary:
      'One-shot daemon execution payload for a command and the only place secret-bearing command input lives; inserted with its command row, deleted on success.',
    columns: {
      command_id: 'Primary key and FK to `command.id` (cascade): exactly one payload per command, written in the same transaction as the command row.',
      payload: 'Typed, bounded daemon command input (may carry compose YAML, credential envelopes or TLS material); read once by the consumer just before dispatch.',
      expires_at: 'Failure-retention deadline: NULL until a terminal failure, then now plus 24h (`failed`, `timed_out`, `cancelled`); the maintenance sweep deletes expired rows.',
    },
  },
  generation: {
    group: 'runtime',
    summary:
      'Append-only history of every topology generation a server\'s daemon reported (one row per server and generation), inserted verbatim from `topology-report`.',
    columns: {
      generation: 'Daemon-maintained topology generation counter, bumped only when the enumerated NIC, GPU, filesystem, disk or signal identity set or slot mapping changes.',
      boot_generation: 'Daemon boot counter, incremented when `/proc/sys/kernel/random/boot_id` differs from the value persisted in its state directory; sent with the snapshot.',
      snapshot: 'Full daemon-reported topology object stored verbatim: networks, filesystems, blockDevices, gpus, hardwareSignals, cpu, numaNodes, capacities, machineClass.',
      applied_at: 'Daemon\'s own report timestamp (`topology-report.at`) for when this generation took effect, never the control-plane receipt time.',
    },
  },
  key: {
    group: 'runtime',
    summary:
      'The Ed25519 daemon identity key of a server, one row per server (unique `server_id` and `fingerprint`), written on enroll and re-enroll by server-identity-db.',
    columns: {
      server_id: 'Owning server, UNIQUE so re-enrolment replaces the row in place (fresh id, cleared `revoked_at`) unless the row is revoked; cascades on server delete.',
      algorithm: 'Signature algorithm of the key, constrained to `Ed25519`.',
      public_jwk: 'Raw Ed25519 public JWK with `crv`, `kty` and `x` as sent by the daemon at enrolment; the private half never leaves the host.',
      fingerprint: 'SHA-256 hex digest of the canonical JSON of `crv`, `kty` and `x`; globally UNIQUE and used to look up the server on daemon auth.',
      revoked_at: 'Set by `revokeDaemonKey`; non-null blocks new JWT issuance and is sticky, so a re-enrolment against a revoked row is refused rather than replacing it.',
      last_used_at: 'Stamped by `touchDaemonKeyLastUsed` when a daemon JWT session is issued (single-column write, no cell wake); reset to NULL on re-enrolment.',
    },
  },
  label: {
    group: 'runtime',
    summary:
      'Key/value labels on a server, the source for compose `deploy.placement.constraints` (`node.labels.*`); replaced as a whole set by the labels API, max 64.',
    columns: {
      key: 'Label key, 1 to 255 chars matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` and unique per server; matched by `node.labels.KEY` placement constraints.',
      value: 'Label value string (empty allowed, default `\'\'`) capped at the description max length; compared with `==` or `!=` in placement constraints.',
    },
  },
  monitor: {
    group: 'runtime',
    summary:
      'Per-server ProxySQL backend monitor credential minted by the control plane, one row per server; kept off `server.options` since that jsonb is served and cached.',
    columns: {
      server_id: 'Owning server, UNIQUE because one ProxySQL runs per host with a single global monitor credential; ON DELETE CASCADE so a deleted host leaves no orphaned secret.',
      username: 'Deterministic monitor role name: `tp_monitor_` plus the first 12 hex chars of the server UUID without dashes, kept within engine identifier limits.',
      secret_envelope: 'Password sealed with the data-encryption key (`ENVELOPE_PREFIX_SECRET` prefix); resealed to a `tpdaemon` envelope per recipient at send time.',
    },
  },
  server: {
    group: 'runtime',
    summary:
      'One enrolled host per row (uuidv7 id); daemon enroll and heartbeats project host facts onto it, operators set the name, options and pins via PATCH.',
    columns: {
      metadata: 'Daemon-projected host facts jsonb: `resources`, `geo`, `docker`, `runtimes`, `cell` plus the operator `hardwareProfile`; hostname, OS and NTP have own columns.',
      options: 'Operator config jsonb served verbatim by GET /servers: `timezone`, `sshPort`, `ntp`, `hosting`, `cellLocationHint`, `cellGeneration`, `metricsCapabilityPlan`.',
      organization_id: 'Owning organization, nullable; ON DELETE RESTRICT so an organization that still has server rows cannot be deleted.',
      name: 'Optional operator-chosen display name, set when the registration key is minted or via PATCH; the UI falls back to `hostname` when null.',
      hostname: 'Daemon-reported host name written on enroll, hello and identity projection; used with `machine_key` to match a reconnecting daemon to its row.',
      machine_key: 'Deterministic HMAC-SHA256 digest of the host machine-id (never the raw id, not a secret), echoed into signed enroll/auth payloads and used to match reconnects.',
      os_id: 'Distro `ID` from /etc/os-release as reported by the daemon; Raspberry Pi OS (including 64-bit `ID=debian` with /etc/rpi-issue) is stored as `raspberry-pi-os`.',
      os_family: 'Daemon-reported OS family, one of `linux`, `windows`, `freebsd` or `darwin`.',
      os_version: 'Daemon-reported OS version, preferring `DEBIAN_VERSION_FULL` or /etc/debian_version over `VERSION_ID` (such as `13.5`).',
      os_codename: 'Daemon-reported `VERSION_CODENAME` from /etc/os-release.',
      os_pretty_name: 'Daemon-reported `PRETTY_NAME` from /etc/os-release.',
      os_architecture: 'Daemon-reported CPU architecture from the Deno build, such as `x86_64` or `aarch64`.',
      machine_class: '`physical` or `virtual` for sensor entitlement; NULL means auto, where ingest writes `physical` once sensors are found (never `virtual`); PATCH can pin.',
      timezone: 'Daemon-observed IANA host timezone; the operator override lives in `options.timezone` and wins when set.',
      is_time_sync_enabled: 'Daemon-reported NTP client enabled flag (`ntpEnabled` from the systemd-timesyncd facts); NULL when never reported.',
      ntp_servers: 'Daemon-reported jsonb array of objects with `host` and optional `fallback` (FallbackNTP entries), read from timesyncd.conf or timedatectl.',
      ntp_last_synced_at: 'Last successful NTP sync: set from the daemon stamp or first synced observation, cleared when the host reports unsynced, never bumped to now() per heartbeat.',
      assigned_tier_id: 'Derived, never chosen: the purchased tier covering this server, recomputed by assignment-records.ts on seat, grant, enroll or hardware change; NULL if none.',
      is_connected: 'Daemon liveness flag written by the cell projection on connect and disconnect; `online`, `offline` or `unknown` is derived from it and `status_changed_at`.',
      status_changed_at: 'Time of the last `is_connected` flip in either direction; read as `connectedAt` while connected and offline-since otherwise, NULL if never transitioned.',
      daemon: 'Sparse jsonb with an optional `projection` (hostname, machineKey, remoteAddress, keyId, daemonBuild) written by the cell; the key lives in `key`.',
      is_hosting_enabled: 'Boolean mirror of validated `options.hosting.enabled`, written by the same PATCH route so system/reconcile.ts can filter hosting in SQL; NULL means not set.',
    },
  },
  slot: {
    group: 'runtime',
    summary:
      'One scheduled replica instance of a service on a server; derived scheduling state the planner writes through `replaceEnvironmentSlots` on each deploy.',
    columns: {
      metadata: 'Reserved; never written by the slot re-plan today.',
      options: 'Reserved; never written by the slot re-plan today.',
      server_id: 'Server the planner placed this replica on; sticky across re-plans (only `generation` is rewritten) unless the planner moves it; ON DELETE RESTRICT.',
      address: 'Cross-host inet address allocated on the environment\'s spanning compose network; at most one per slot, NULL clears a prior allocation.',
      slot: '0-based replica index within the service (unlike 1-based `container.ordinal`), unique per service.',
      generation: 'Environment deploy generation of the plan that last wrote this row; matches `deployment.desired_generation`.',
      desired_state: 'Intended state, `running`, `stopped` or `removed`; the planner only writes `running` today.',
    },
  },
  task: {
    group: 'runtime',
    summary:
      'Cron-style scheduled command on a service, created and edited by operators via the tasks API and rendered into systemd timers at deploy time; no run history.',
    columns: {
      metadata: 'Accepted by the record helper but never written by the tasks API today; reserved.',
      options: 'Accepted by the record helper but never written by the tasks API today; reserved.',
      name: 'Operator display name, unique per service and normalized as a display name (no format CHECK).',
      schedule: 'Cron expression validated by `parseCronSchedule` in lib/cron.ts and converted to a systemd `OnCalendar` value at deploy time.',
      command: 'Shell command line to run (under 1000 chars, each argument under 512), validated by `parseCronCommand`.',
      timezone: 'Optional IANA timezone (validated against the allowed list) applied when the schedule is converted to a systemd `OnCalendar` value; NULL means none set.',
      is_enabled: 'Operator toggle; a disabled task stays stored but `renderCronForDeploy` skips it, so no timer is rendered at deploy time.',
      concurrency_policy: 'What happens when a run is still going at the next tick: `allow` overlapping runs, `forbid` skips the tick (default), `replace` restarts the run.',
      timeout_seconds: 'Longest a run may take before it is stopped, at most 86400 (24h); NULL means no declared limit.',
    },
  },
  // ── git ───────────────────────────────────────────────────────────────
  connection: {
    group: 'git',
    summary:
      'One Git provider grant to one organization, a GitHub App installation or a GitLab OAuth account connection, made through a `forge` row.',
    columns: {
      metadata: 'Sparse jsonb bag reserved by the repo-wide column convention; no code path writes it for connection rows today.',
      options: 'Sparse jsonb bag reserved by the repo-wide column convention; no code path writes it for connection rows today.',
      forge_id: 'Application the grant was made through; with `external_installation_id` it resolves a webhook delivery to exactly one row (cascades on forge delete).',
      provider: '`github` or `gitlab`, denormalized from the forge as a filter column.',
      external_installation_id: 'Provider-side id as text: the numeric GitHub App installation id, or the GitLab user/group id; for GitHub unique per forge across the instance.',
      account_login: 'Login of the provider account the grant sits on (GitHub installation account or GitLab user), refreshed on every connect or reconnect.',
      account_type: 'Provider account kind as GitHub reports it (`User` or `Organization`); always `User` for GitLab connections.',
      suspended_at: 'Set while the provider reports the installation suspended or a token refresh failed; cleared on reconnect, and suspended rows are skipped by the trigger.',
      oauth_envelope: 'GitLab only: sealed OAuth pair as JSON `accessTokenEnvelope`, `refreshTokenEnvelope`, `expiresAt`, `scope` (tpsecret strings); NULL for GitHub.',
    },
  },
  delivery: {
    group: 'git',
    summary:
      'Replay-protection ledger of inbound webhook deliveries for every gate kind (GitHub, GitLab, Stripe); org-agnostic, secret-free, pruned after 7 days.',
    columns: {
      provider: 'Webhook gate kind that claimed the delivery: `github`, `gitlab` or `stripe`.',
      external_delivery_id: 'Provider delivery id: GitHub `X-GitHub-Delivery`, GitLab `X-Gitlab-Event-UUID` (else `sha256:` digest of the body), or the Stripe event id.',
      event: 'Provider event name (`push`, `check_suite`, a Stripe event `type`) recorded for tracing only.',
      object_id: 'Stripe `data.object.id` kept until projection settles so entitlement survives a crash after the 2xx; NULL for git deliveries.',
      object_type: 'Stripe `data.object.object` (for example `subscription`) kept beside `object_id` for the projection sweep; NULL for git deliveries.',
      projected_at: 'When the Stripe projection settled (success, skip or permanent error); NULL means pending retry and exempt from pruning, git rows stay NULL.',
    },
  },
  forge: {
    group: 'git',
    summary:
      'A registered Git provider application (GitHub App or GitLab OAuth app) that connections are granted through; `organization_id` NULL means instance-wide.',
    columns: {
      metadata: 'Sparse jsonb bag reserved by the repo-wide column convention; no code path writes it for forge rows today.',
      options: 'Sparse jsonb bag reserved by the repo-wide column convention; no code path writes it for forge rows today.',
      organization_id: 'NULL means instance-wide (any organization may connect through it); set means the app belongs to that organization alone.',
      provider: 'Git provider kind, `github` or `gitlab`, chosen at registration and never changed.',
      name: 'Display name of the app; for GitHub Apps it is overwritten from the provider on each sync, and varchar(255) is that write\'s only length guard.',
      base_url: 'Origin the app lives on (github.com, gitlab.com or a self-managed host); part of the unique key with `provider` and `external_app_id`.',
      api_url: 'Explicit API origin for a GitHub Enterprise Server or self-managed GitLab; NULL means derive it from `base_url`.',
      external_app_id: 'Provider-side application id as text: the numeric GitHub App id (matches `X-GitHub-Hook-Installation-Target-ID`) or the GitLab OAuth application id.',
      app_slug: 'GitHub App slug used to build the install URL; filled by the manifest flow or sync, NULL for GitLab.',
      client_id: 'OAuth client id the provider issued for this app; its secret is sealed in `envelopes.clientSecretEnvelope`.',
      redirect_uri: 'OAuth redirect URI registered with the provider for the GitLab authorize flow; NULL for GitHub Apps.',
      webhook_origin: 'Public origin the provider was told to deliver webhooks to at registration; NULL on apps registered before that choice existed.',
      is_public: 'Whether the provider was told the app is publicly installable; set at creation (true for instance-wide apps) and refreshed from GitHub on sync.',
      custom_git_user: 'SSH user for clone URLs of a self-hosted forge on a non-standard port (`ssh://user@host:port/path`); unused by GitHub App sources.',
      custom_git_port: 'SSH port for clone URLs of a self-hosted forge, paired with `custom_git_user`; unused by GitHub App sources.',
      synced_at: 'Last successful reconcile of this row against the provider\'s own record of the app (the sync handler); NULL if never synced.',
      envelopes: 'Sealed `tpsecret` envelopes under JSON keys `privateKeyEnvelope`, `clientSecretEnvelope`, `webhookSecretEnvelope`; never returned by the API.',
      webhook_ref: 'Opaque unguessable routing token that ends this app\'s webhook URL (`/webhook/github/` plus the token); it routes a delivery to its app, not a credential.',
      webhook_token_hash: 'GitLab only: HMAC of the webhook token so a delivery on the unscoped path resolves in one indexed lookup; NULL for GitHub apps.',
    },
  },
  repository: {
    group: 'git',
    summary:
      'One Git repository registered to an organization (one row per repo per org); workloads attach via `project.repository_id` or compose `x-turbopanel.source` refs.',
    columns: {
      metadata: 'Free-form jsonb the caller may send on repository create or patch; bookkeeping, never load-bearing, and the API folds the inspect columns into it on the wire.',
      options: 'Caller-supplied policy jsonb; the webhook trigger also parks `pendingChecks` (`commitSha`, `ref`, `recordedAt`) here in `checks_passed` mode.',
      connection_id: 'Provider connection that authorizes clones and webhook matching; NULL for deploy-key and anonymous git lanes, set NULL when the connection is deleted.',
      secret_id: 'Deploy key (`secret` row with the sealed private key) for SSH and deploy-key GitLab sources; NULL for connection-backed or anonymous repositories.',
      provider: '`github`, `gitlab`, or `git` for a plain URL read through a connected server instead of a provider API.',
      repository_url: 'Clone URL stored canonicalized (lower-cased host, `.git` suffix, no trailing slash) so the per-organization unique dedupes spellings.',
      repository_external_id: 'Provider-side repository/project id as text, used to match webhook deliveries because it survives renames; NULL for plain git.',
      default_branch: 'Tracked branch: operator-set, or copied from `detected_default_branch` while the row still follows the provider\'s default.',
      subdirectory: 'Relative checkout subdirectory used as the build root, same rule as compose `x-turbopanel.root`; NULL means the repository root.',
      auto_deploy: 'Push-to-deploy mode: `immediate`, `checks_passed` (wait for a green check suite) or `disabled` (default); plain git never deploys on push.',
      detected_default_branch: 'Provider-reported default branch from the latest refresh or inspect, compared with `default_branch` to show drift.',
      default_branch_checked_at: 'When `detected_default_branch` was last read from the provider.',
      last_inspected_at: 'When the head commit was last inspected through the provider (the inspect route\'s bookkeeping).',
      last_inspected_commit_sha: 'Head commit SHA observed at `last_inspected_at`.',
    },
  },
  ssh: {
    group: 'git',
    summary:
      'A public key that may authenticate as a principal over SSH; the daemon renders `authorized_keys` from it, and fingerprint lookups answer lost-laptop revocation.',
    columns: {
      name: 'Operator-facing label (1 to 255 chars), distinct from the key\'s own `comment`.',
      key_type: 'SSH key algorithm from the CHECK list (`ssh-ed25519`, `ecdsa-sha2-nistp*`, their `sk-` FIDO variants, `ssh-rsa`); `ssh-dss` is rejected.',
      public_key: 'Canonical `type base64` re-rendered from the decoded blob, never the pasted line; the comment moves to `comment` and a leading options field is rejected.',
      fingerprint: '`SHA256:` plus unpadded base64 digest of the decoded blob, byte-identical to `ssh-keygen -lf`; unique per principal.',
      comment: 'Sanitized display comment from the pasted line (printable ASCII, no quotes or backslashes, max 255); NULL when none.',
      user_id: 'Org member who added the key: audit provenance, not ownership; set NULL on user delete so the key survives.',
      bits: 'RSA modulus size in bits (minimum 2048); NULL for the fixed-size key types.',
    },
  },
  // ── notifications ─────────────────────────────────────────────────────
  attempt: {
    group: 'notifications',
    summary:
      'Delivery-attempt ledger: one row per event per routed channel, inserted before the send so a crash leaves a pending row; retried by the maintenance tick.',
    columns: {
      organization_id: 'Organization the event belongs to; NULL for an instance-scoped event.',
      event: 'Catalogue code (`NOTIFICATION_EVENTS`), same vocabulary as `notification.event`.',
      severity: '`info`, `warning` or `critical`, copied from the event\'s catalogue definition.',
      payload: 'Rendered non-secret message as JSON: `event`, `severity`, `title`, `body`, `organizationId`, `organizationName`, `targetType`, `targetId`, `context`, `at`.',
      status: '`pending` (default, not yet sent), `sent`, `failed` (retry due) or `abandoned` (after 5 failed attempts); retries pick up `pending` and `failed`.',
      attempts: 'Number of send attempts so far, bumped in SQL by the sender; the row is abandoned once it reaches 5.',
      next_attempt_at: 'Earliest time the retry sweep may pick the row up: now plus 2 min grace on insert, then backoff of 1, 5, 25 and 125 min; NULL once sent.',
      sent_at: 'When a send succeeded; NULL until then.',
      last_error: 'Short failure code from the last attempt (`http_503`, `timeout`, `network`, `address_scheme_not_https`), never a body or the address.',
    },
  },
  channel: {
    group: 'notifications',
    summary:
      'An address notifications can be delivered to, owned by the instance, one organization or one user per `scope`; addresses of secret kinds are sealed.',
    columns: {
      scope: 'Owner kind: `instance`, `organization` or `user`; the owner columns must agree with it (CHECK).',
      organization_id: 'Owning organization, set only when `scope` is `organization` and NULL otherwise.',
      user_id: 'Owning user, set only when `scope` is `user`; a personal channel follows the user across organizations.',
      kind: 'Transport: `email`, `webhook`, `slack`, `discord`, `telegram` or `push` (push is registered by the store apps, never typed).',
      label: 'Owner-chosen display name such as \'Ops Slack\'.',
      address: 'Delivery address: plain for `email`, else a sealed `tpsecret` envelope (webhook, Slack or Discord URL, Telegram `token/chatId`, push token).',
      signing_secret: 'Sealed `tpsecret` HMAC key for the generic `webhook` kind (`X-TurboPanel-Signature: sha256=...`); NULL for other kinds.',
      verified_at: 'When the address was confirmed; stamped at creation for own or member emails, NULL means unverified and email delivery is skipped.',
      disabled_at: 'Set when the owner pauses the channel; it keeps its rules but receives nothing until resumed.',
      created_by_user_id: 'User whose session created the channel (provenance, set NULL on user delete); differs from `user_id` for org and instance channels.',
    },
  },
  notification: {
    group: 'notifications',
    summary:
      'One bell inbox row per event per recipient user, written by `emitNotification` for every member or manager the event\'s audience names.',
    columns: {
      user_id: 'Recipient of the inbox row; one row per person the event reached, chosen by the event\'s audience (members or managers).',
      organization_id: 'Organization the event belongs to; NULL for an instance-scoped event such as `fleet.mass_disconnect`.',
      event: 'Catalogue code (`NOTIFICATION_EVENTS`): `server.offline`, `fleet.mass_disconnect`, `server.deleted`, `server.daemon_key_revoked`, `access.grant_*`.',
      severity: '`info`, `warning` or `critical`, copied from the event\'s catalogue definition.',
      title: 'One-line sentence rendered from the catalogue\'s title template at emit time; also the email subject.',
      body: 'Fuller sentence rendered from the catalogue\'s body template; NULL when the event defines none.',
      target_type: 'Catalog entity kind the event is about (`server`, or a grant\'s entity type) so the bell can link to it; NULL when there is no target.',
      target_id: 'UUID of the `target_type` entity; not a foreign key, so it may outlive the entity.',
      context: 'Small non-secret facts the sentence was rendered from, such as `serverName`, `lastSeenAt`, `count`, `actorEmail`, `permissionKey`, `subjectKind`, `subjectId`.',
      read_at: 'When the recipient marked it read (Mark all read); NULL while unread and counted in the badge.',
      dismissed_at: 'When the recipient dismissed the row from the bell; NULL while it is still shown.',
    },
  },
  rule: {
    group: 'notifications',
    summary:
      'Subscription row saying which event (or `*`) reaches a channel at or above a severity floor; a channel with no rule receives nothing.',
    columns: {
      event: 'One catalogue event code, or `*` for every event; unique per channel.',
      min_severity: 'Severity floor `info` (default), `warning` or `critical`; delivered only when the event\'s severity ranks at or above it.',
    },
  },

}
