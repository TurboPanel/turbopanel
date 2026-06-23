export const websocketPaths: Record<string, unknown> = {
  "/ws/daemon/v1": {
    get: {
      tags: ["daemon"],
      summary: "Daemon WebSocket",
      description:
        "WebSocket upgrade endpoint for managed daemons. Authenticate by passing a valid " +
        "short-lived daemon JWT in the Authorization header: Authorization: Bearer <daemon-jwt>. " +
        "Obtain the JWT via POST /api/daemon/v1/auth/session. " +
        "Invalid or missing JWTs are rejected with HTTP 401 before the upgrade completes. " +
        "Once connected, the socket is used exclusively for live streaming (logs, terminal, " +
        "command output). No hello handshake is required after upgrade.",
      security: [{ bearerAuth: [] }],
      responses: {
        "101": {
          description: "Switching Protocols — WebSocket upgrade",
        },
      },
    },
  },
};
