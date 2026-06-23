import { authPaths, authSchemas } from "./auth.ts";
import { caPaths } from "./ca.ts";
import { readinessPaths, readinessSchemas } from "./readiness.ts";
import { versionPaths, versionSchemas } from "./version.ts";
import { websocketPaths } from "./websocket.ts";

/** Hand-authored OpenAPI 3.1 spec for documented daemon REST/WS routes. */
export function getDaemonOpenApiSpec(serverUrl: string): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "TurboPanel Daemon API",
      version: "0.1.0",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Short-lived daemon JWT for authenticated daemon API and WebSocket access. " +
            "Send as `Authorization: Bearer <daemon-jwt>`.",
        },
      },
      schemas: {
        ...authSchemas,
        ...readinessSchemas,
        ...versionSchemas,
      },
    },
    paths: {
      ...authPaths,
      ...readinessPaths,
      ...caPaths,
      ...versionPaths,
      ...websocketPaths,
    },
  };
}
