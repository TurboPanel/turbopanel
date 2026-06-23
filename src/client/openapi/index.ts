import { resolveSessionCookieName } from '../authn/crypto.ts'
import { accessPaths, accessSchemas } from './access.ts'
import { authPaths, buildAuthSchemas } from './auth.ts'
import { environmentPaths, environmentSchemas } from './environments.ts'
import { hostingPaths, hostingSchemas } from './hostings.ts'
import { installOpenApiPaths, installOpenApiSchemas } from './install.ts'
import { buildLicensePaths, buildLicenseSchemas } from './licenses.ts'
import { projectPaths, projectSchemas } from './projects.ts'
import { serverPaths, serverSchemas } from './servers.ts'
import { servicePaths, serviceSchemas } from './services.ts'
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
  const sessionCookieName = resolveSessionCookieName(serverUrl)

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Client API',
      version: '0.1.0',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: sessionCookieName,
        },
      },
      schemas: {
        ...buildAuthSchemas(options?.runtime),
        ...serverSchemas,
        ...buildLicenseSchemas(installCommandDescription),
        ...accessSchemas,
        ...workspaceSchemas,
        ...environmentSchemas,
        ...projectSchemas,
        ...serviceSchemas,
        ...hostingSchemas,
        ...(includeInstall ? installOpenApiSchemas : {}),
      },
    },
    paths: {
      ...authPaths,
      ...serverPaths,
      ...buildLicensePaths(installCommandDescription),
      ...accessPaths,
      ...workspacePaths,
      ...environmentPaths,
      ...projectPaths,
      ...servicePaths,
      ...hostingPaths,
      ...(includeInstall ? installOpenApiPaths : {}),
    },
  }
}
