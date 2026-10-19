import { eraseStoredPairs } from '../tls/stored-pair.ts'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { createOrganizationForUser } from '../authn/install-state.ts'
import { canAccessOrganization, listAccessibleOrganizations } from '../org-context.ts'
import { parseJsonBody } from '../shared.ts'
import { type Db, getDb } from '../../db/connection.ts'
import {
  AUDIT_MAX_PAGE_SIZE,
  listAuditForOrganization,
} from '../../features/audit/audit-records.ts'
import { organization } from '../../db/schema.ts'
import {
  checkOrgDefaultSslModeForExternalAccess,
  withManagedTlsPolicyLock,
} from '../../features/managed/external-access-tls.ts'
import {
  loadOrgOptionsRow,
  mergeOrgOptionsSql,
  openOrgSettingsScope,
  orgOptionsGetRoute,
  orgOptionsPatchRoute,
  recordOrgSettingAudit,
  removeOrgOptionSql,
  writeOrgOptions,
} from './settings-route.ts'
import {
  parseOrganizationOptions,
  resolveRandomizedPrincipalUsernames,
} from '../../features/organizations/organization-options.ts'
import { loadOrgServerCapacity } from '../../features/servers/server-capacity.ts'
import { listTimezones } from '../../lib/timezones.ts'
import { assertCidrAvailable } from '../../features/net/cidr-collisions.ts'
import { alignedNetworkCidr } from '../../lib/ip-address.ts'
import { findDockerBridgePoolOverlap } from '../../features/deploy/docker-address-pools.ts'
import { cidrCollisionResponse } from '../networks/network-scope.ts'
import {
  applyManagedDefaultsPatch,
  composeDefaultResourceLimitsGetResponse,
  composeDefaultResourceLimitsPutResponse,
  composeGatedFieldsGetResponse,
  composeGatedFieldsPutResponse,
  defaultEnvironmentGetResponse,
  defaultEnvironmentPutResponse,
  defaultTimezoneGetResponse,
  defaultTimezonePutResponse,
  deployHooksGetResponse,
  deployHooksPutResponse,
  dockerNetworkingGetResponse,
  dockerNetworkingPutResponse,
  hostDefaultsGetResponse,
  hostDefaultsPutResponse,
  managedDefaultsGetResponse,
  managedDefaultsPutResponse,
  parseComposeDefaultResourceLimitsPatch,
  parseComposeGatedFieldsPatch,
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseDeployHooksPatch,
  parseDockerNetworkingPatch,
  parseHostDefaultsPatch,
  parseManagedDefaultsPatch,
  parseOrganizationCreateDisplayName,
  parseOrganizationPatchDisplayName,
  parseServerCapacityPutBody,
  parseTemperatureUnitPatch,
  parseTlsSettingsPatch,
  temperatureUnitGetResponse,
  temperatureUnitPutResponse,
  tlsSettingsGetResponse,
  tlsSettingsPutResponse,
  toOrganizationRecord,
  validateManagedDefaults,
} from './routes-helpers.ts'
import { registerOrganizationFabricRoutes } from './fabric-routes.ts'

async function loadOrganizationRecord(db: Db, id: string) {
  const [orgRow] = await db
    .select({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt,
    })
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return orgRow ?? null
}

export function registerOrganizationRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization routes')
  }
  const secrets = opts.secrets

  router.use('/organizations', createSessionMiddleware(secrets))
  router.use('/organizations/:id', createSessionMiddleware(secrets))
  router.use('/organizations/:id/default-timezone', createSessionMiddleware(secrets))
  router.use('/organizations/:id/temperature-unit', createSessionMiddleware(secrets))
  router.use('/organizations/:id/host-defaults', createSessionMiddleware(secrets))
  router.use('/organizations/:id/default-environment', createSessionMiddleware(secrets))
  router.use('/organizations/:id/server-capacity', createSessionMiddleware(secrets))
  router.use('/organizations/:id/managed-defaults', createSessionMiddleware(secrets))
  router.use('/organizations/:id/principal-defaults', createSessionMiddleware(secrets))
  router.use('/organizations/:id/docker-networking', createSessionMiddleware(secrets))
  router.use('/organizations/:id/tls-settings', createSessionMiddleware(secrets))
  router.use('/organizations/:id/compose-privileged-fields', createSessionMiddleware(secrets))
  router.use('/timezones', createSessionMiddleware(secrets))
  registerOrganizationFabricRoutes(router, opts)

  router.get('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const organizations = await listAccessibleOrganizations(db, session.userId)
    return c.json({ organizations })
  })

  router.post('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsedDisplayName = parseOrganizationCreateDisplayName(body)
    if (!parsedDisplayName.ok) {
      return c.json({ error: parsedDisplayName.error }, parsedDisplayName.status)
    }

    const { organizationId } = await createOrganizationForUser(
      db,
      session.userId,
      parsedDisplayName.name
    )

    return c.json({ ok: true as const, id: organizationId })
  })

  router.get('/organizations/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const allowed = await canAccessOrganization(db, session.userId, id)
    if (!allowed) return c.json({ error: 'Not found' }, 404)

    const orgRow = await loadOrganizationRecord(db, id)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    return c.json({ organization: toOrganizationRecord(orgRow) })
  })

  router.patch('/organizations/:id', async (c) => {
    const scope = await openOrgSettingsScope(c, 'manage')
    if (scope instanceof Response) return scope
    const { db, id } = scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseOrganizationPatchDisplayName(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    const orgRow = await loadOrganizationRecord(db, id)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    await db
      .update(organization)
      .set({
        name: parsed.name,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organization.id, id))

    const updated = await loadOrganizationRecord(db, id)
    if (!updated) return c.json({ error: 'Not found' }, 404)

    return c.json({
      ok: true as const,
      organization: toOrganizationRecord(updated),
    })
  })

  router.get(
    '/organizations/:id/default-timezone',
    orgOptionsGetRoute('manage', defaultTimezoneGetResponse)
  )
  router.put(
    '/organizations/:id/default-timezone',
    orgOptionsPatchRoute({
      gate: 'manage',
      parse: parseDefaultTimezonePatch,
      respond: defaultTimezonePutResponse,
    })
  )

  router.get(
    '/organizations/:id/temperature-unit',
    orgOptionsGetRoute('manage', temperatureUnitGetResponse)
  )
  router.put(
    '/organizations/:id/temperature-unit',
    orgOptionsPatchRoute({
      gate: 'manage',
      parse: parseTemperatureUnitPatch,
      respond: temperatureUnitPutResponse,
    })
  )

  router.get(
    '/organizations/:id/tls-settings',
    orgOptionsGetRoute('manage', tlsSettingsGetResponse)
  )
  router.put(
    '/organizations/:id/tls-settings',
    orgOptionsPatchRoute({
      gate: 'manage',
      parse: parseTlsSettingsPatch,
      respond: tlsSettingsPutResponse,
      // Turning Let's Encrypt off: the stored keys are no longer needed.
      afterWrite: async (db, organizationId, patch) => {
        if (patch.acmeEnabled === false) {
          await eraseStoredPairs(db, organizationId)
        }
      },
      audit: (patch) => ({
        action: 'organization.acme.set',
        context: { acmeEnabled: patch.acmeEnabled },
      }),
    })
  )

  // Org-owner, not just organization:manage — this gates namespace/
  // capability-escaping Compose fields (privileged, cap_add, network_mode,
  // …) that grant root-equivalent access to the shared daemon host,
  // compromising every co-hosted tenant. See `sec-compose-privileged-gate`
  // (2026-09-15 security audit) and `lib/compose/field-policy.ts`'s
  // `GATED_SERVICE_FIELD_KEYS`.
  router.get(
    '/organizations/:id/compose-privileged-fields',
    orgOptionsGetRoute('owner', composeGatedFieldsGetResponse)
  )
  router.put(
    '/organizations/:id/compose-privileged-fields',
    orgOptionsPatchRoute({
      gate: 'owner',
      parse: parseComposeGatedFieldsPatch,
      respond: composeGatedFieldsPutResponse,
      audit: (patch) => ({
        action: 'organization.compose_privileged_fields.set',
        context: { composeGatedFieldsEnabled: patch.composeGatedFieldsEnabled },
      }),
    })
  )

  // Deploy hooks (`preDeployCommand` / `postDeployCommand`) are arbitrary
  // shell a project member authors and the daemon runs at deploy time —
  // confined to the service container, but code nobody reviewed in a commit.
  // Off by default; the owner opts the organization in here.
  router.get('/organizations/:id/deploy-hooks', orgOptionsGetRoute('owner', deployHooksGetResponse))
  router.put(
    '/organizations/:id/deploy-hooks',
    orgOptionsPatchRoute({
      gate: 'owner',
      parse: parseDeployHooksPatch,
      respond: deployHooksPutResponse,
      audit: (patch) => ({
        action: 'organization.deploy_hooks.set',
        context: { deployHooksEnabled: patch.deployHooksEnabled },
      }),
    })
  )

  /**
   * The organization's audit trail, newest first.
   *
   * Owner-only, matching the bar on the actions it records: the trail names
   * who did what, which is exactly what an attacker with a member session
   * would read to learn the shape of an organization. Keyset pagination —
   * pass the last row's `createdAt` as `before`.
   */
  router.get('/organizations/:id/audit', async (c) => {
    const scope = await openOrgSettingsScope(c, 'owner')
    if (scope instanceof Response) return scope
    const { db, id } = scope

    const before = c.req.query('before')
    const limitRaw = c.req.query('limit')
    const limit = limitRaw === undefined ? undefined : Number(limitRaw)
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit <= 0 || limit > AUDIT_MAX_PAGE_SIZE)
    ) {
      return c.json({ error: 'Invalid limit' }, 400)
    }

    const entries = await listAuditForOrganization(db, {
      organizationId: id,
      ...(before ? { before } : {}),
      ...(limit === undefined ? {} : { limit }),
    })
    return c.json({ entries })
  })

  router.get(
    '/organizations/:id/compose-resource-defaults',
    orgOptionsGetRoute('owner', composeDefaultResourceLimitsGetResponse)
  )

  router.put('/organizations/:id/compose-resource-defaults', async (c) => {
    const scope = await openOrgSettingsScope(c, 'owner')
    if (scope instanceof Response) return scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsedPatch = parseComposeDefaultResourceLimitsPatch(body)
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status)
    }

    if (!(await loadOrgOptionsRow(scope.db, scope.id))) {
      return c.json({ error: 'Not found' }, 404)
    }

    // `null` clears the opt-in; jsonb merge-patch cannot remove a key, so the
    // clear is written as a key removal on the stored object.
    const patch = parsedPatch.patch.composeDefaultResourceLimits
    await writeOrgOptions(
      scope.db,
      scope.id,
      patch === null
        ? removeOrgOptionSql('composeDefaultResourceLimits')
        : mergeOrgOptionsSql({ composeDefaultResourceLimits: patch })
    )
    const updated = await loadOrgOptionsRow(scope.db, scope.id)

    await recordOrgSettingAudit(c, scope, 'organization.compose_resource_defaults.set', {
      composeDefaultResourceLimits: patch,
    })

    return c.json(
      composeDefaultResourceLimitsPutResponse(parseOrganizationOptions(updated?.options))
    )
  })

  router.get(
    '/organizations/:id/host-defaults',
    orgOptionsGetRoute('manage', hostDefaultsGetResponse)
  )
  router.put(
    '/organizations/:id/host-defaults',
    orgOptionsPatchRoute({
      gate: 'manage',
      parse: parseHostDefaultsPatch,
      respond: hostDefaultsPutResponse,
    })
  )

  router.get(
    '/organizations/:id/default-environment',
    orgOptionsGetRoute('manage', defaultEnvironmentGetResponse)
  )
  router.put(
    '/organizations/:id/default-environment',
    orgOptionsPatchRoute({
      gate: 'manage',
      parse: (body) => {
        const parsed = parseDefaultEnvironmentPutBody(body)
        return parsed.ok
          ? { ok: true, patch: { defaultEnvironmentName: parsed.defaultEnvironmentName } }
          : parsed
      },
      respond: defaultEnvironmentPutResponse,
    })
  )

  router.get('/organizations/:id/server-capacity', async (c) => {
    const scope = await openOrgSettingsScope(c, 'manage')
    if (scope instanceof Response) return scope

    const capacity = await loadOrgServerCapacity(scope.db, scope.id)
    if (!capacity) return c.json({ error: 'Not found' }, 404)

    return c.json(capacity)
  })

  router.put('/organizations/:id/server-capacity', async (c) => {
    const scope = await openOrgSettingsScope(c, 'owner')
    if (scope instanceof Response) return scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseServerCapacityPutBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    if (!(await loadOrgOptionsRow(scope.db, scope.id))) {
      return c.json({ error: 'Not found' }, 404)
    }
    await writeOrgOptions(scope.db, scope.id, mergeOrgOptionsSql({ maxServers: parsed.maxServers }))

    const capacity = await loadOrgServerCapacity(scope.db, scope.id)
    if (!capacity) return c.json({ error: 'Not found' }, 404)

    return c.json({ ok: true as const, ...capacity })
  })

  router.get(
    '/organizations/:id/managed-defaults',
    orgOptionsGetRoute('manage', (options) =>
      managedDefaultsGetResponse(options.managedDatabase ?? {})
    )
  )

  router.put('/organizations/:id/managed-defaults', async (c) => {
    const scope = await openOrgSettingsScope(c, 'manage')
    if (scope instanceof Response) return scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsedPatch = parseManagedDefaultsPatch(body)
    if (!parsedPatch.ok) {
      return c.json({ error: parsedPatch.error }, parsedPatch.status)
    }

    const orgRow = await loadOrgOptionsRow(scope.db, scope.id)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    // Nested object: merge in app code, then write the whole `managedDatabase`
    // value — jsonb `||` is shallow and would drop sibling keys.
    const stored = parseOrganizationOptions(orgRow.options).managedDatabase ?? {}
    const next = applyManagedDefaultsPatch(stored, parsedPatch.patch)

    // Collisions only exist post-merge: one family's override can land on the
    // other family's still-inherited default.
    const invalid = validateManagedDefaults(next)
    if (invalid) return c.json({ error: invalid.error }, invalid.status)

    const write = (tx: Db) =>
      writeOrgOptions(tx, scope.id, mergeOrgOptionsSql({ managedDatabase: next }))

    // A changed SSL default is checked and saved under the SSL policy lock:
    // refused while a database that follows it is served by a server that
    // allows external access. An unchanged default (a ports-only save) is not
    // re-checked, so older data never blocks it.
    if (next.sslMode === stored.sslMode) {
      await write(scope.db)
    } else {
      const refusal = await withManagedTlsPolicyLock(scope.db, async (tx) => {
        const found = await checkOrgDefaultSslModeForExternalAccess(tx, {
          organizationId: scope.id,
          sslMode: next.sslMode,
        })
        if (!found) await write(tx)
        return found
      })
      if (refusal) return c.json(refusal, 409)
    }

    return c.json(managedDefaultsPutResponse(next))
  })

  router.get(
    '/organizations/:id/principal-defaults',
    orgOptionsGetRoute('manage', (options) => ({
      randomizedUsernames: options.randomizedPrincipalUsernames ?? null,
      effectiveRandomizedUsernames: resolveRandomizedPrincipalUsernames(options),
    }))
  )

  router.put('/organizations/:id/principal-defaults', async (c) => {
    const scope = await openOrgSettingsScope(c, 'manage')
    if (scope instanceof Response) return scope
    const { db, id } = scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    // `null` clears the override back to the platform default (on); only
    // affects principals created after the change — nothing is renamed.
    const value = (body as Record<string, unknown>).randomizedUsernames
    if (value !== null && typeof value !== 'boolean') {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    await writeOrgOptions(
      db,
      id,
      value === null
        ? removeOrgOptionSql('randomizedPrincipalUsernames')
        : mergeOrgOptionsSql({ randomizedPrincipalUsernames: value })
    )

    return c.json({
      ok: true as const,
      randomizedUsernames: value,
      effectiveRandomizedUsernames: value ?? true,
    })
  })

  router.get(
    '/organizations/:id/docker-networking',
    orgOptionsGetRoute('manage', (options) => dockerNetworkingGetResponse(options.docker ?? {}))
  )

  router.put('/organizations/:id/docker-networking', async (c) => {
    const scope = await openOrgSettingsScope(c, 'manage')
    if (scope instanceof Response) return scope
    const { db, id } = scope

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseDockerNetworkingPatch(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    // The body is replace-all, so the submitted bridge and the submitted
    // pools are checked against each other here — the authority below
    // excludes the *stored* docker addressing and would never see this pair.
    const next = parsed.value
    const bridgeVsPool = findDockerBridgePoolOverlap(next)
    if (bridgeVsPool) {
      return cidrCollisionResponse(c, {
        code: 'cidr_overlaps_docker_network',
        cidr: bridgeVsPool.bridgeCidr,
        conflictingCidr: bridgeVsPool.pool.base,
        networkId: null,
        datacenterId: null,
      })
    }

    // Every pool base goes through the one CIDR collision authority: dockerd
    // will carve bridge networks out of it on every host, so it must not
    // overlap the fabric, a reserved hole, a site subnet or a registered
    // docker network. The stored pools and bridge are excluded — this PUT
    // replaces them, and the body's own entries were already checked against
    // each other.
    for (const pool of next?.addressPools ?? []) {
      const collision = await assertCidrAvailable(db, {
        organizationId: id,
        cidr: pool.base,
        intent: 'docker',
        excludeDockerHostCidrs: true,
      })
      if (collision) return cidrCollisionResponse(c, collision)
    }

    // `bip` is the docker0 bridge's own address + prefix on every host; the
    // network it names is a docker network like any other and must clear the
    // same authority (reserved holes, site subnets, the fabric host range
    // and container pool, registered docker rows). Once stored it joins the
    // registry through `dockerHostCidrs`, so later writes stay clear of it.
    // The stored pools and bridge are excluded for the same reason as above.
    if (next?.defaultBridgeCidr) {
      // Already syntactically valid (`parseDockerNetworkingPatch`), so the
      // aligned network form always resolves.
      const collision = await assertCidrAvailable(db, {
        organizationId: id,
        cidr: alignedNetworkCidr(next.defaultBridgeCidr) ?? next.defaultBridgeCidr,
        intent: 'docker',
        excludeDockerHostCidrs: true,
      })
      if (collision) return cidrCollisionResponse(c, collision)
    }

    // Top-level jsonb merge replaces the whole `docker` object, which is the
    // correct replace-all semantics for a list; an all-cleared body removes
    // the key.
    await writeOrgOptions(
      db,
      id,
      next === null ? removeOrgOptionSql('docker') : mergeOrgOptionsSql({ docker: next })
    )

    return c.json(dockerNetworkingPutResponse(next ?? {}))
  })

  router.get('/timezones', (c) => {
    return c.json({ timezones: listTimezones() })
  })
}
