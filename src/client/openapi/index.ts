import { resolveSessionCookieNameFromUrl } from '../authn/crypto.ts'
import { sharedSchemas } from './shared.ts'
import { accessPaths, accessSchemas } from './access.ts'
import { authPaths, buildAuthSchemas } from './auth.ts'
import { environmentPaths, environmentSchemas } from './environments.ts'
import { containerPaths, containerSchemas } from './containers.ts'
import { hostingPaths, hostingSchemas } from './hostings.ts'
import { tlsPaths, tlsSchemas } from './tls.ts'
import { installOpenApiPaths, installOpenApiSchemas } from './install.ts'
import { networkPaths, networkSchemas } from './networks.ts'
import { buildLicensePaths, buildLicenseSchemas } from './licenses.ts'
import { organizationPaths, organizationSchemas } from './organizations.ts'
import { projectPaths, projectSchemas } from './projects.ts'
import { serverPaths, serverSchemas } from './servers.ts'
import { servicePaths, serviceSchemas } from './services.ts'
import { variablePaths, variableSchemas } from './variables.ts'
import { workspacePaths, workspaceSchemas } from './workspaces.ts'

/** Hand-authored OpenAPI 3.1 spec for documented client/install/health routes. */
export type ClientOpenApiOptions = {
  runtime?: 'deno' | 'workers'
}

export function getClientOpenApiSpec(
  serverUrl: string,
  options?: ClientOpenApiOptions,
): object {
  const includeInstall = options?.runtime === 'deno'
  const installCommandDescription = includeInstall
    ? 'Shell command to install a daemon with this license via the instance install wrapper.'
    : 'Shell command to install a daemon with this license via the CDN installer (Workers does not expose /api/install/v1).'
  const sessionCookieName = resolveSessionCookieNameFromUrl(serverUrl)

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Client API',
      version: '0.1.0',
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
      { name: 'Services', description: 'Service CRUD' },
      { name: 'Hostings', description: 'Hosting CRUD' },
      { name: 'Containers', description: 'Container CRUD' },
      { name: 'TLS', description: 'Organization TLS certificate library' },
      { name: 'Servers', description: 'Server fleet and update management' },
      { name: 'Networks', description: 'Server network management' },
      { name: 'Licenses', description: 'License lifecycle' },
      ...(includeInstall
        ? [{ name: 'Install', description: 'Self-hosted install wizard (Deno only)' }]
        : []),
    ],
    'x-tagGroups': [
      { name: 'Authentication & Authorization', tags: ['Authentication', 'Authorization'] },
      { name: 'Resources', tags: ['Workspaces', 'Projects', 'Environments', 'Variables', 'Services', 'Hostings', 'Containers', 'TLS'] },
      { name: 'Infrastructure', tags: ['Servers', 'Networks', 'Licenses'] },
      { name: 'Platform', tags: ['Health', ...(includeInstall ? ['Install'] : [])] },
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
        ...networkSchemas,
        ...buildLicenseSchemas(installCommandDescription),
        ...accessSchemas,
        ...organizationSchemas,
        ...workspaceSchemas,
        ...environmentSchemas,
        ...projectSchemas,
        ...variableSchemas,
        ...serviceSchemas,
        ...hostingSchemas,
        ...containerSchemas,
        ...tlsSchemas,
        ...(includeInstall ? installOpenApiSchemas : {}),
      },
    },
    paths: {
      ...authPaths,
      ...serverPaths,
      ...networkPaths,
      ...buildLicensePaths(installCommandDescription),
      ...accessPaths,
      ...organizationPaths,
      ...workspacePaths,
      ...environmentPaths,
      ...projectPaths,
      ...variablePaths,
      ...servicePaths,
      ...hostingPaths,
      ...containerPaths,
      ...tlsPaths,
      ...(includeInstall ? installOpenApiPaths : {}),
    },

  }
}
