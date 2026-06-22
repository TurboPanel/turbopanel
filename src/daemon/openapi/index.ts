import { caPaths } from './ca.ts'
import { readinessPaths, readinessSchemas } from './readiness.ts'
import { versionPaths, versionSchemas } from './version.ts'
import { websocketPaths } from './websocket.ts'

/** Hand-authored OpenAPI 3.1 spec for documented daemon REST/WS routes. */
export function getDaemonOpenApiSpec(serverUrl: string): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Daemon API',
      version: '0.1.0',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        licenseAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'License credentials as `licenseId:licenseToken`. On the WebSocket surface, ' +
            'send `licenseId` and `licenseToken` in the first `hello` JSON message after ' +
            'upgrade — not in HTTP Authorization headers.',
        },
      },
      schemas: {
        ...readinessSchemas,
        ...versionSchemas,
      },
    },
    paths: {
      ...readinessPaths,
      ...caPaths,
      ...versionPaths,
      ...websocketPaths,
    },
  }
}
