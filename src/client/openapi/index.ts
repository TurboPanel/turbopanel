import { INSTANCE_VERSION } from '../../app/version.ts'
import { resolveSessionCookieNameFromUrl } from '../authn/crypto.ts'
import { sharedSchemas } from './shared.ts'
import { accessPaths, accessSchemas } from './access.ts'
import { authPaths, buildAuthSchemas } from './auth.ts'
import { environmentPaths, environmentSchemas } from './environments.ts'
import { containerPaths, containerSchemas } from './containers.ts'
import { dockerRunPaths, dockerRunSchemas } from './docker-run.ts'
import { hostingPaths, hostingSchemas } from './hostings.ts'
import { tlsPaths, tlsSchemas } from './tls.ts'
import { installOpenApiPaths, installOpenApiSchemas } from './install.ts'
import { networkPaths, networkSchemas } from './networks.ts'
import { datacenterPaths, datacenterSchemas } from './datacenters.ts'
import { ipPaths, ipSchemas } from './ips.ts'
import { buildLicensePaths, buildLicenseSchemas } from './licenses.ts'
import { organizationPaths, organizationSchemas } from './organizations.ts'
import { phpModePaths, phpModeSchemas } from './php-modes.ts'
import { projectPaths, projectSchemas } from './projects.ts'
import { serverPaths, serverSchemas } from './servers.ts'
import { servicePaths, serviceSchemas } from './services.ts'
import { variablePaths, variableSchemas } from './variables.ts'
import { tagPaths, tagSchemas } from './tags.ts'
import { taskPaths, taskSchemas } from './tasks.ts'
import { bindingPaths, bindingSchemas } from './bindings.ts'
import { workspacePaths, workspaceSchemas } from './workspaces.ts'
import { storagePaths, storageSchemas } from './storage.ts'
import { storageBackupPaths, storageBackupSchemas } from './storage-backups.ts'
import { firewallPaths, firewallSchemas } from './firewall.ts'
import { activityPaths, activitySchemas } from './activity.ts'
import { organizationMemberPaths, organizationMemberSchemas } from './organization-members.ts'
import { repositoryPaths, repositorySchemas } from './repositories.ts'
import { principalPaths, principalSchemas } from './principals.ts'
import { deployPaths, deploySchemas } from './deploy.ts'
import { managedPaths, managedSchemas } from './managed.ts'
import { metricsPaths, metricsSchemas } from './metrics.ts'
import { systemPaths, systemSchemas } from './system.ts'
import { commandPaths, commandSchemas } from './commands.ts'

/** Hand-authored OpenAPI 3.1 spec for documented client/install/health routes. */
export type ClientOpenApiOptions = {
  runtime?: 'deno' | 'workers'
}

export function getClientOpenApiSpec(serverUrl: string, options?: ClientOpenApiOptions): object {
  const includeInstall = options?.runtime === 'deno'
  const installCommandDescription = includeInstall
    ? 'Shell command to install a daemon with this license via the instance install wrapper.'
    : 'Shell command to install a daemon with this license via the CDN installer (Workers does not expose /api/install/v1).'
  const sessionCookieName = resolveSessionCookieNameFromUrl(serverUrl)

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Client API',
      version: INSTANCE_VERSION,
      description:
        'Mutating requests (POST, PUT, PATCH, DELETE) pass three gates before a route runs. ' +
        'Browser writes must be same-origin: a cross-site Sec-Fetch-Site or a foreign Origin answers 403 Forbidden, ' +
        'while clients that send no Origin, Referer or Sec-Fetch headers (CLI, native apps) are unaffected. ' +
        'Bodies over 1 MiB (4 MiB on project, environment and docker-run import routes) answer 413 with code request_body_too_large. ' +
        'More than 120 writes per minute per session (per IP when anonymous) answers 429 with code rate_limited and a Retry-After header.',
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: 'Health', description: 'Liveness and status probes' },
      {
        name: 'Authentication',
        description: 'Sign-in, sign-up, OTP, and password reset flows',
      },
      {
        name: 'Authorization',
        description: 'Session, organizations, access grants, and permission catalog',
      },
      { name: 'Workspaces', description: 'Workspace CRUD' },
      { name: 'Projects', description: 'Project CRUD' },
      { name: 'Environments', description: 'Environment CRUD' },
      { name: 'Variables', description: 'Environment variable and secret management' },
      { name: 'Tags', description: 'Organization tag registry and entity tagging' },
      {
        name: 'Tasks',
        description: 'Scheduled tasks (cron) — configuration only; execution is not implemented',
      },
      {
        name: 'Bindings',
        description:
          'Managed-database principal → compose-service credential bindings (materialized variables)',
      },
      { name: 'Storage', description: 'Volumes, bind mounts, and file storage' },
      {
        name: 'Repositories',
        description: 'Git repository bindings and Git provider App installations',
      },
      { name: 'Principals', description: 'Project runtime principals' },
      { name: 'Resource limits', description: 'Organization and server deploy quotas' },
      { name: 'Services', description: 'Service CRUD' },
      { name: 'Hostings', description: 'Hosting CRUD' },
      { name: 'Containers', description: 'Container CRUD' },
      {
        name: 'Docker run import',
        description:
          'Translate a `docker run` command into a compose fragment (compute only — nothing is persisted)',
      },
      { name: 'TLS', description: 'Organization TLS certificate library' },
      { name: 'Servers', description: 'Servers and update management' },
      { name: 'Commands', description: 'Command lifecycle status polling' },
      { name: 'Networks', description: 'Organization network registry' },
      { name: 'Datacenters', description: 'Datacenter CRUD' },
      { name: 'IPs', description: 'Managed IP address registry' },
      { name: 'Licenses', description: 'License lifecycle' },
      { name: 'System', description: 'Platform-managed system components' },
      ...(includeInstall
        ? [{ name: 'Install', description: 'Self-hosted install wizard (Deno only)' }]
        : []),
    ],
    'x-tagGroups': [
      { name: 'Authentication & Authorization', tags: ['Authentication', 'Authorization'] },
      {
        name: 'Resources',
        tags: [
          'Workspaces',
          'Projects',
          'Environments',
          'Managed services',
          'Variables',
          'Tags',
          'Tasks',
          'Bindings',
          'Storage',
          'Repositories',
          'Principals',
          'Resource limits',
          'Services',
          'Hostings',
          'Containers',
          'TLS',
          'Docker run import',
        ],
      },
      {
        name: 'Infrastructure',
        tags: ['Servers', 'Commands', 'Networks', 'Datacenters', 'IPs', 'Licenses'],
      },
      { name: 'Platform', tags: ['Health', 'System', ...(includeInstall ? ['Install'] : [])] },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: sessionCookieName,
        },
      },
      schemas: {
        ...sharedSchemas,
        ...buildAuthSchemas(options?.runtime),
        ...serverSchemas,
        ...metricsSchemas,
        ...networkSchemas,
        ...datacenterSchemas,
        ...ipSchemas,
        ...buildLicenseSchemas(installCommandDescription),
        ...accessSchemas,
        ...organizationSchemas,
        ...phpModeSchemas,
        ...workspaceSchemas,
        ...environmentSchemas,
        ...projectSchemas,
        ...variableSchemas,
        ...tagSchemas,
        ...taskSchemas,
        ...bindingSchemas,
        ...storageSchemas,
        ...storageBackupSchemas,
        ...firewallSchemas,
        ...organizationMemberSchemas,
        ...activitySchemas,
        ...repositorySchemas,
        ...principalSchemas,
        ...deploySchemas,
        ...managedSchemas,
        ...systemSchemas,
        ...commandSchemas,
        ...serviceSchemas,
        ...hostingSchemas,
        ...containerSchemas,
        ...dockerRunSchemas,
        ...tlsSchemas,
        ...(includeInstall ? installOpenApiSchemas : {}),
      },
    },
    paths: {
      ...authPaths,
      ...serverPaths,
      ...metricsPaths,
      ...networkPaths,
      ...datacenterPaths,
      ...ipPaths,
      ...buildLicensePaths(installCommandDescription),
      ...accessPaths,
      ...organizationPaths,
      ...phpModePaths,
      ...workspacePaths,
      ...environmentPaths,
      ...projectPaths,
      ...variablePaths,
      ...tagPaths,
      ...taskPaths,
      ...bindingPaths,
      ...storagePaths,
      ...storageBackupPaths,
      ...firewallPaths,
      ...organizationMemberPaths,
      ...activityPaths,
      ...repositoryPaths,
      ...principalPaths,
      ...deployPaths,
      ...managedPaths,
      ...systemPaths,
      ...commandPaths,
      ...servicePaths,
      ...hostingPaths,
      ...containerPaths,
      ...dockerRunPaths,
      ...tlsPaths,
      ...(includeInstall ? installOpenApiPaths : {}),
    },
  }
}
