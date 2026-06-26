export const caPaths: Record<string, unknown> = {
  "/api/daemon/v1/instance/ca": {
    get: {
      tags: ["Daemon"],
      summary: "Platform TLS CA certificate",
      description:
        "Returns the PEM-encoded platform CA for daemon trust stores.",
      responses: {
        "200": {
          description: "PEM certificate",
          content: {
            "application/x-pem-file": {
              schema: { type: "string", format: "byte" },
            },
          },
        },
        "500": {
          description: "CA unavailable",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonErrorResponse" },
            },
          },
        },
      },
    },
  },
};
