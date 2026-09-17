/**
 * Host-free coverage for environment deploy route pure helpers.
 */

import { assertEquals } from '@std/assert'
import type { DeployPrepareError } from './deploy-prepare.ts'
import {
  buildDeployPreviewContainers,
  buildDeployPreviewServers,
  buildNativeAppServicesForDeploy,
  buildSitesForDeploy,
  composeProjectName,
  DEPLOY_REF_INVALID,
  deployMaterialsErrorResponse,
  deployPreviewServerLabel,
  expandHostingsForComposeInstances,
  fabricGateErrorResponse,
  hostingsNeedSharedHttpIngress,
  isPlainObject,
  mapPrepareErrorResponse,
  parseDeployRef,
  parseDeployRequestFlags,
  parseLifecycleAction,
  resolveDeployReleaseServiceId,
  preferredListenPortsFromHostings,
  queuedCommandsResponseBody,
  readHostingPorts,
  readHostingProtocol,
  readHostnames,
  readPathPrefix,
  readTargetPort,
  scheduleErrorResponse,
  tlsPinErrorCode,
  validateDeployMaterials,
} from './deploy-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const projectId = '11111111-1111-4111-8111-111111111111'

test('composeProjectName uses project UUID verbatim', () => {
  assertEquals(composeProjectName(projectId), projectId)
})

test('tlsPinErrorCode maps pin errors', () => {
  assertEquals(tlsPinErrorCode('pin_not_found'), 'tls_pin_not_found')
  assertEquals(tlsPinErrorCode('pin_mismatch'), 'tls_pin_mismatch')
  assertEquals(tlsPinErrorCode('pin_not_ready'), 'tls_pin_not_ready')
})

test('fabricGateErrorResponse maps failed and pending fabric gates', () => {
  assertEquals(
    fabricGateErrorResponse({
      kind: 'failed',
      serverId: projectId,
      commandId: 'cmd-1',
      error: 'peer down',
    }),
    {
      status: 422,
      body: {
        error: 'fabric_reconcile_failed',
        serverId: projectId,
        commandId: 'cmd-1',
        message: 'peer down',
      },
    },
  )
  assertEquals(
    fabricGateErrorResponse({
      kind: 'failed',
      serverId: projectId,
      commandId: 'cmd-2',
      error: null,
    }),
    {
      status: 422,
      body: {
        error: 'fabric_reconcile_failed',
        serverId: projectId,
        commandId: 'cmd-2',
      },
    },
  )
  assertEquals(
    fabricGateErrorResponse({
      kind: 'pending',
      pending: [{ serverId: projectId, commandId: 'cmd-3' }],
    }),
    {
      status: 409,
      body: {
        error: 'fabric_reconcile_pending',
        pending: [{ serverId: projectId, commandId: 'cmd-3' }],
      },
    },
  )
})

test('mapPrepareErrorResponse covers every DeployPrepareError kind', () => {
  const cases: DeployPrepareError[] = [
    { kind: 'health_check', required: true, services: ['web'] },
    { kind: 'empty_compose' },
    { kind: 'datacenter_ip_required', serverId: projectId },
    { kind: 'docker_external_network_unregistered', names: ['external-net'] },
    { kind: 'site_principal_ambiguous', composeServiceName: 'php' },
    {
      kind: 'resource_limit',
      violations: [{
        scope: 'organization',
        field: 'maxCpus',
        limit: 1,
        requested: 2,
      }],
    },
    { kind: 'binding_endpoint_unavailable' },
    { kind: 'variable_unresolved', message: 'missing {$project.x}', ref: '{$project.x}' },
    { kind: 'variable_ref_invalid', message: 'bad ref' },
    { kind: 'variable_secret_interpolation', message: 'use {$SECRET}' },
    {
      kind: 'storage_location_unavailable',
      storageId: 'st-1',
      storageName: 'data',
      accessMode: 'single_writer',
      primaryServerId: 'srv-primary',
      scheduledServerId: 'srv-other',
      serviceId: 'svc-1',
    },
    { kind: 'site_cron_unowned', composeServiceName: 'cron-site' },
    { kind: 'site_managed_directory_unowned', composeServiceName: 'uploads' },
    { kind: 'source_principal_ambiguous', composeServiceName: 'git-app' },
    {
      kind: 'source_ref_unresolved',
      composeServiceName: 'git-app',
      sourceId: 'src-1',
      ref: 'missing-branch',
      message: 'ref not found',
    },
    { kind: 'principal_alias_unknown', composeServiceName: 'blog', alias: 'ghost' },
    {
      kind: 'principal_required_for_service_kind',
      composeServiceName: 'blog',
      serviceKind: 'site',
    },
    {
      kind: 'compose_field_unsupported',
      issues: [{
        path: 'services.web.deploy.update_config',
        message:
          'deploy.update_config is not supported by TurboPanel — TurboPanel has no rolling-update controller',
        level: 'error',
        line: 5,
      }],
    },
  ]

  assertEquals(mapPrepareErrorResponse(cases[0]).status, 409)
  assertEquals(mapPrepareErrorResponse(cases[1]).body.error, 'compose_empty')
  assertEquals(mapPrepareErrorResponse(cases[2]).body.error, 'datacenter_ip_required')
  assertEquals(mapPrepareErrorResponse(cases[3]).body.error, 'docker_external_network_unregistered')
  assertEquals(mapPrepareErrorResponse(cases[4]).body.error, 'site_principal_ambiguous')
  assertEquals(mapPrepareErrorResponse(cases[5]).body.error, 'resource_limit_exceeded')
  assertEquals(mapPrepareErrorResponse(cases[6]).body.error, 'binding_endpoint_unavailable')
  assertEquals(mapPrepareErrorResponse(cases[7]).status, 422)
  assertEquals(mapPrepareErrorResponse(cases[7]).body.error, 'variable_unresolved')
  assertEquals(mapPrepareErrorResponse(cases[7]).body.ref, '{$project.x}')
  assertEquals(mapPrepareErrorResponse(cases[8]).body.error, 'variable_ref_invalid')
  assertEquals(mapPrepareErrorResponse(cases[9]).body.error, 'variable_secret_interpolation')
  assertEquals(mapPrepareErrorResponse(cases[10]).body.error, 'storage_location_unavailable')
  assertEquals(mapPrepareErrorResponse(cases[10]).status, 422)
  assertEquals(
    mapPrepareErrorResponse(cases[10]).body.message,
    'Storage "data" (single_writer) has no usable location on this server; primary copy is on srv-primary',
  )

  const aliasUnknown = mapPrepareErrorResponse(cases[15])
  assertEquals(aliasUnknown.status, 422)
  assertEquals(aliasUnknown.body.error, 'principal_alias_unknown')
  assertEquals(aliasUnknown.body.alias, 'ghost')
  assertEquals(
    String(aliasUnknown.body.message).includes('x-turbopanel.principals'),
    true,
  )

  const principalRequired = mapPrepareErrorResponse(cases[16])
  assertEquals(principalRequired.status, 422)
  assertEquals(principalRequired.body.error, 'principal_required_for_service_kind')
  assertEquals(principalRequired.body.serviceKind, 'site')

  const variableWithContext = mapPrepareErrorResponse({
    kind: 'variable_unresolved',
    message: 'missing {$project.x}',
    ref: '{$project.x}',
    composeServiceName: 'web',
    envKey: 'DATABASE_URL',
  })
  assertEquals(variableWithContext.body.composeServiceName, 'web')
  assertEquals(variableWithContext.body.envKey, 'DATABASE_URL')

  const storageWithoutPrimary = mapPrepareErrorResponse({
    kind: 'storage_location_unavailable',
    storageId: 'st-1',
    storageName: 'data',
    accessMode: 'single_writer',
    primaryServerId: null,
    scheduledServerId: 'srv-other',
    serviceId: 'svc-1',
  })
  assertEquals(
    storageWithoutPrimary.body.message,
    'Storage "data" (single_writer) has no usable location on this server',
  )

  assertEquals(mapPrepareErrorResponse(cases[11]).body.error, 'site_cron_unowned')
  assertEquals(mapPrepareErrorResponse(cases[11]).status, 422)
  assertEquals(mapPrepareErrorResponse(cases[12]).body.error, 'site_managed_directory_unowned')
  assertEquals(mapPrepareErrorResponse(cases[13]).body.error, 'source_principal_ambiguous')
  const unresolved = mapPrepareErrorResponse(cases[14])
  assertEquals(unresolved.body.error, 'source_ref_unresolved')
  assertEquals(unresolved.body.sourceId, 'src-1')
  assertEquals(unresolved.body.ref, 'missing-branch')

  // Distinct from `compose_invalid`: the document parses, TurboPanel just does
  // not implement what it names — and the message has to name the field, since
  // the whole point of the code is that it is no longer dropped in silence.
  const unsupportedField = mapPrepareErrorResponse(cases[17])
  assertEquals(unsupportedField.status, 422)
  assertEquals(unsupportedField.body.error, 'compose_field_unsupported')
  assertEquals(
    String(unsupportedField.body.message).includes(
      'services.web.deploy.update_config',
    ),
    true,
  )

  // Its own code, and its own sentence: no stored layer is wrong, so an
  // operator sent looking for the mistake inside one would not find it.
  const mergedInvalid = mapPrepareErrorResponse({
    kind: 'compose_merged_invalid',
    issues: [{
      path: 'services.web',
      message: 'Service "web" must define image or build',
      level: 'error',
      line: 2,
    }],
  })
  assertEquals(mergedInvalid.status, 422)
  assertEquals(mergedInvalid.body.error, 'compose_merged_invalid')
  assertEquals(
    String(mergedInvalid.body.message).includes('services.web'),
    true,
  )
  assertEquals(
    String(mergedInvalid.body.message).includes('overlay changes the base'),
    true,
  )
})

test('parseDeployRequestFlags defaults flags to false', () => {
  assertEquals(parseDeployRequestFlags(null), 'invalid')
  assertEquals(parseDeployRequestFlags([]), 'invalid')
  assertEquals(parseDeployRequestFlags({}), {
    acknowledgeHealthCheckWarnings: false,
    noCache: false,
    ref: null,
  })
  assertEquals(
    parseDeployRequestFlags({
    acknowledgeHealthCheckWarnings: true,
    noCache: true,
    }),
    {
    acknowledgeHealthCheckWarnings: true,
    noCache: true,
      ref: null,
    },
  )
})

test('parseDeployRequestFlags accepts a ref and rejects unsafe ones', () => {
  assertEquals(parseDeployRequestFlags({ ref: '  main  ' }), {
    acknowledgeHealthCheckWarnings: false,
    noCache: false,
    ref: 'main',
  })
  assertEquals(parseDeployRequestFlags({ ref: '' }), {
    acknowledgeHealthCheckWarnings: false,
    noCache: false,
    ref: null,
  })
  assertEquals(parseDeployRequestFlags({ ref: 'feature/a-b_1' }), {
    acknowledgeHealthCheckWarnings: false,
    noCache: false,
    ref: 'feature/a-b_1',
  })
  assertEquals(parseDeployRequestFlags({ ref: 'main; rm -rf /' }), 'invalid')
  assertEquals(parseDeployRequestFlags({ ref: 'refs/heads/..' }), 'invalid')
  assertEquals(parseDeployRequestFlags({ ref: '--upload-pack=x' }), 'invalid')
  assertEquals(parseDeployRequestFlags({ ref: 42 }), 'invalid')
})

test('parseDeployRef normalizes absent and blank values to null', () => {
  assertEquals(parseDeployRef(undefined), null)
  assertEquals(parseDeployRef(null), null)
  assertEquals(parseDeployRef('   '), null)
  assertEquals(parseDeployRef('v1.2.3'), 'v1.2.3')
  assertEquals(parseDeployRef('a'.repeat(256)), DEPLOY_REF_INVALID)
  // `invalid` is a legal ref name, and must not read as the rejection sentinel.
  assertEquals(parseDeployRef('invalid'), 'invalid')
})

test('parseLifecycleAction accepts start stop restart only', () => {
  assertEquals(parseLifecycleAction({ action: 'start' }), 'start')
  assertEquals(parseLifecycleAction({ action: 'stop' }), 'stop')
  assertEquals(parseLifecycleAction({ action: 'restart' }), 'restart')
  assertEquals(parseLifecycleAction({ action: 'pause' }), 'invalid')
  assertEquals(parseLifecycleAction(null), 'invalid')
  assertEquals(parseLifecycleAction([]), 'invalid')
  assertEquals(parseLifecycleAction({}), 'invalid')
})

test('isPlainObject rejects arrays and null', () => {
  assertEquals(isPlainObject({ a: 1 }), true)
  assertEquals(isPlainObject(null), false)
  assertEquals(isPlainObject([]), false)
  assertEquals(isPlainObject('x'), false)
})

test('expandHostingsForComposeInstances fans out clone keys', () => {
  const hosting = {
    hostingId: 'h1',
    serviceId: 'svc',
    composeServiceName: 'web',
    hostnames: ['app.example.com'],
  }
  const expanded = expandHostingsForComposeInstances(
    [hosting],
    { web: ['web-1', 'web-2'] },
  )
  assertEquals(expanded.length, 2)
  assertEquals(expanded.map((row) => row.composeServiceName), ['web-1', 'web-2'])

  const kept = expandHostingsForComposeInstances([hosting], { web: [] })
  assertEquals(kept, [hosting])
  assertEquals(expandHostingsForComposeInstances([hosting], {}), [hosting])
})

test('hosting option readers filter invalid values', () => {
  assertEquals(readHostnames(null), [])
  assertEquals(readHostnames({ hostnames: ['a.example.com', '', 3] }), ['a.example.com'])
  assertEquals(readPathPrefix({ pathPrefix: '/api' }), '/api')
  assertEquals(readTargetPort({ targetPort: 8080 }), 8080)
  assertEquals(readTargetPort({ targetPort: Number.NaN }), undefined)
  assertEquals(readHostingProtocol({ protocol: 'tcp' }), 'tcp')
  assertEquals(readHostingProtocol({ protocol: 'http' }), 'http')
  assertEquals(
    readHostingPorts({ ports: [{ published: 5432, target: 5432 }, { published: 0, target: 1 }] }),
    [{ published: 5432, target: 5432 }],
  )
})

test('preferredListenPortsFromHostings collects target ports', () => {
  const ports = preferredListenPortsFromHostings([
    {
      hostingId: 'h1',
      serviceId: 'svc',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
      targetPort: 3000,
    },
  ])
  assertEquals(ports.get('web'), 3000)
})

test('hostingsNeedSharedHttpIngress requires HTTP hostnames', () => {
  assertEquals(hostingsNeedSharedHttpIngress([]), false)
  assertEquals(
    hostingsNeedSharedHttpIngress([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'web',
      hostnames: [],
      protocol: 'tcp',
      ports: [{ published: 5432, target: 5432 }],
    }]),
    false,
  )
  assertEquals(
    hostingsNeedSharedHttpIngress([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'web',
      hostnames: [],
    }]),
    false,
  )
  assertEquals(
    hostingsNeedSharedHttpIngress([{
      hostingId: 'h1',
      serviceId: 's1',
      composeServiceName: 'web',
      hostnames: ['app.example.test'],
    }]),
    true,
  )
})

test('buildDeployPreviewContainers merges app and ingress rows', () => {
  const rows = buildDeployPreviewContainers({
    appContainers: [{
      serviceId: 'svc',
      cloneComposeServiceName: 'web-1',
      containerName: 'c1',
      ordinal: 1,
    }],
    ingressServices: [{
      serviceId: 'svc',
      composeServiceName: 'web-in',
      containerName: 'in',
    }],
  })
  assertEquals(rows.length, 2)
  assertEquals(rows[0]?.role, 'service')
  assertEquals(rows[1]?.role, 'ingress')
})

test('validateDeployMaterials rejects tcp hostings without ports', () => {
  const error = validateDeployMaterials(
    [{
      hostingId: 'h1',
      serviceId: 'svc',
      composeServiceName: 'db',
      hostnames: [],
      protocol: 'tcp',
      ports: [],
    }],
    [],
  )
  if (!error) throw new TypeError('expected invalid deploy hosting')
  assertEquals(error.error, 'invalid_deploy_hosting')
})

test('validateDeployMaterials rejects invalid storage material', () => {
  const error = validateDeployMaterials([], [{
    storageId: 'st-1',
    locationId: 'loc-1',
    kind: 'volume',
    name: 'data',
    provider: 'path',
    serverId: 'srv-1',
    mounts: [{
      composeServiceName: 'web',
      destinationPath: '/data',
      readOnly: false,
    }],
  }])
  if (!error) throw new TypeError('expected invalid deploy storage')
  assertEquals(error.error, 'invalid_deploy_storage')
})

test('deployMaterialsErrorResponse returns 400 for invalid materials', async () => {
  assertEquals(deployMaterialsErrorResponse([], []), null)
  const denied = deployMaterialsErrorResponse(
    [{
      hostingId: 'h1',
      serviceId: 'svc',
      composeServiceName: 'db',
      hostnames: [],
      protocol: 'udp',
      ports: [],
    }],
    [],
  )
  assertEquals(denied?.status, 400)
  assertEquals(
    ((await denied?.json()) as { error?: string } | undefined)?.error,
    'invalid_deploy_hosting',
  )
})

test('scheduleErrorResponse maps placement and other schedule failures', () => {
  assertEquals(scheduleErrorResponse('no_eligible_server', 'none'), {
    status: 409,
    body: { error: 'server_placement_required' },
  })
  assertEquals(
    scheduleErrorResponse('host_port_conflict', 'port 80 taken'),
    {
      status: 422,
      body: { error: 'host_port_conflict', message: 'port 80 taken' },
    },
  )
  assertEquals(
    scheduleErrorResponse('turbofabric_required', 'need mesh'),
    {
      status: 422,
      body: { error: 'turbofabric_required', message: 'need mesh' },
    },
  )
  // The cap is the document's arithmetic, not a missing host, so it keeps its
  // own code and the scheduler's own sentence rather than collapsing into
  // `server_placement_required`.
  assertEquals(
    scheduleErrorResponse(
      'max_replicas_per_node_exceeded',
      'web requires more replicas than max_replicas_per_node allows',
    ),
    {
      status: 422,
      body: {
        error: 'max_replicas_per_node_exceeded',
        message: 'web requires more replicas than max_replicas_per_node allows',
      },
    },
  )
})

test('queuedCommandsResponseBody shapes empty and multi-command payloads', () => {
  assertEquals(queuedCommandsResponseBody([]), {
    ok: true,
    commandId: '',
    status: 'queued',
    commands: [],
  })
  assertEquals(
    queuedCommandsResponseBody([
      { commandId: 'c1', serverId: 's1', status: 'queued' },
      { commandId: 'c2', serverId: 's2', status: 'queued' },
    ]),
    {
      ok: true,
      commandId: 'c1',
      status: 'queued',
      serverId: 's1',
      commands: [
        { commandId: 'c1', serverId: 's1', status: 'queued' },
        { commandId: 'c2', serverId: 's2', status: 'queued' },
      ],
    },
  )
})

test('mapPrepareErrorResponse health_check is the deploy ack conflict shape', () => {
  assertEquals(
    mapPrepareErrorResponse({
      kind: 'health_check',
      required: false,
      services: ['web', 'api'],
    }),
    {
      status: 409,
      body: {
        error: 'health_check_missing',
        required: false,
        services: ['web', 'api'],
      },
    },
  )
})

test('buildSitesForDeploy attaches listen ports from hostings', () => {
  const sites = buildSitesForDeploy(
    [{
      composeServiceName: 'static',
      engine: 'nginx',
      root: 'public',
      listenPort: 8080,
    }],
    [{
      hostingId: 'h1',
      serviceId: 'svc',
      composeServiceName: 'static',
      hostnames: ['site.example.com'],
      targetPort: 8080,
    }],
  )
  assertEquals(sites[0]?.listenPort, 8080)
})

test('deployPreviewServerLabel prefers name then hostname', () => {
  const serverId = '01989d42-9adb-7e65-bc2e-f38792c53691'
  assertEquals(deployPreviewServerLabel('au1', 'host.lan', serverId), 'au1')
  assertEquals(deployPreviewServerLabel('  ', 'host.lan', serverId), 'host.lan')
  assertEquals(deployPreviewServerLabel(null, null, serverId), serverId)
})

test('buildDeployPreviewServers omits a single-server plan', () => {
  const serverId = '01989d42-9adb-7e65-bc2e-f38792c53691'
  const files = [{
    filename: 'compose.yaml',
    role: 'runtime' as const,
    source: 'inline' as const,
    content: 'services: {}\n',
  }]
  assertEquals(
    buildDeployPreviewServers(
      [{ serverId, prepared: { composeFiles: files, replicaCounts: { web: 1 } } }],
      new Map([[serverId, { name: 'au1', hostname: 'host.lan' }]]),
    ),
    undefined,
  )
})

test('buildDeployPreviewServers emits per-host blocks when split', () => {
  const alpha = '01989d42-9adb-7e65-bc2e-f38792c53691'
  const bravo = '01989d42-9adb-7e65-bc2e-f38792c53692'
  const files = [{
    filename: 'compose.yaml',
    role: 'runtime' as const,
    source: 'inline' as const,
    content: 'services: {}\n',
  }]
  const rows = buildDeployPreviewServers(
    [
      { serverId: alpha, prepared: { composeFiles: files, replicaCounts: { web: 1 } } },
      { serverId: bravo, prepared: { composeFiles: files, replicaCounts: { api: 1 } } },
    ],
    new Map([
      [alpha, { name: 'au1', hostname: 'au1.lan' }],
      [bravo, { name: '  ', hostname: 'bravo.lan' }],
    ]),
  )
  assertEquals(rows?.map((row) => ({ name: row.name, services: row.services })), [
    { name: 'au1', services: ['web'] },
    { name: 'bravo.lan', services: ['api'] },
  ])
})

test('resolveDeployReleaseServiceId prefers hosting, then ingress, then compose key', () => {
  assertEquals(
    resolveDeployReleaseServiceId('web', [{
      hostingId: 'h1',
      serviceId: 'svc-hosting',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
    }], []),
    'svc-hosting',
  )
  assertEquals(
    resolveDeployReleaseServiceId('web', [{
      hostingId: 'h1',
      serviceId: '',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
    }], [{
      serviceId: 'svc-ingress',
      composeServiceName: 'web',
      containerName: 'web-in',
    }]),
    'svc-ingress',
  )
  assertEquals(
    resolveDeployReleaseServiceId('worker', [], [{
      serviceId: 'svc-other',
      composeServiceName: 'api',
      containerName: 'api-in',
    }]),
    'worker',
  )
})

test('buildNativeAppServicesForDeploy returns empty when no apps', () => {
  assertEquals(buildNativeAppServicesForDeploy([], [], []), [])
})

test('native app rows resolve the release serviceId from hostings', () => {
  const apps = buildNativeAppServicesForDeploy(
    [{ composeServiceName: 'web', framework: 'next', listenPort: 0 }],
    [{
      hostingId: 'h1',
      serviceId: 'svc-web',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
    }],
    [],
  )
  assertEquals(apps[0]?.serviceId, 'svc-web')
})

test('a hosting targetPort never moves a native app listen port', () => {
  const apps = buildNativeAppServicesForDeploy(
    [{ composeServiceName: 'web', framework: 'next', listenPort: 0 }],
    [{
      hostingId: 'h1',
      serviceId: 'svc-web',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
      targetPort: 3000,
    }],
    [],
  )
  // The port is TurboPanel's allocation; the daemon reads it off
  // nativeAppServices[] and never off the hosting.
  assertEquals(apps[0]?.listenPort === 3000, false)
})

test('a native app port comes out of the shared ledger, not the route', () => {
  const used = new Set<number>()
  const first = buildNativeAppServicesForDeploy(
    [{ composeServiceName: 'web', framework: 'next', listenPort: 0 }],
    [{
      hostingId: 'h1',
      serviceId: 'svc-web',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
      targetPort: 3000,
    }],
    [],
    used,
  )
  const second = buildNativeAppServicesForDeploy(
    [{ composeServiceName: 'api', framework: 'next', listenPort: 0 }],
    [{
      hostingId: 'h2',
      serviceId: 'svc-api',
      composeServiceName: 'api',
      hostnames: ['api.example.com'],
      targetPort: 3000,
    }],
    [],
    used,
  )
  assertEquals(first[0]?.listenPort === second[0]?.listenPort, false)
})

test('a native app with no hosting or ingress falls back to the compose key', () => {
  // Same precedence the daemon's resolveReleaseServiceId uses — a worker that
  // publishes nothing still needs a stable release-tree segment.
  const apps = buildNativeAppServicesForDeploy(
    [{ composeServiceName: 'worker', framework: 'auto', listenPort: 0 }],
    [],
    [],
  )
  assertEquals(apps[0]?.serviceId, 'worker')
})

test('a native app never gets the port a site already took', () => {
  const used = new Set<number>()
  const hostings = [{
    hostingId: 'h1',
    serviceId: 'svc-site',
    composeServiceName: 'static',
    hostnames: ['site.example.com'],
    targetPort: 18080,
  }]
  const sites = buildSitesForDeploy(
    [{
      composeServiceName: 'static',
      engine: 'nginx' as const,
      root: 'public',
      listenPort: 0,
    }],
    hostings,
    used,
  )
  const apps = buildNativeAppServicesForDeploy(
    [{ composeServiceName: 'web', framework: 'auto', listenPort: 0 }],
    hostings,
    [],
    used,
  )
  assertEquals(sites[0]?.listenPort, 18080)
  assertEquals(apps[0]?.listenPort === sites[0]?.listenPort, false)
})
