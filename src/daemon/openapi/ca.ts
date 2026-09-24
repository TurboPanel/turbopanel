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
  "/api/daemon/v1/instance/uploaded-trust": {
    get: {
      tags: ["Daemon"],
      summary: "Private uploaded issuer for the dialed hostname",
      description:
        "Returns the PEM issuer that signed the private uploaded leaf for this hostname. Distinct from the Platform CA bundle. Publicly trusted uploads, Let's Encrypt, and Platform CA names answer 404 so the daemon keeps the system roots or the Platform CA. The installer verifies this issuer against the presented leaf and the dialed name before storing it. Bootstrap insecure TLS is not runtime trust.",
      responses: {
        "200": {
          description: "PEM issuer certificates",
          content: {
            "application/x-pem-file": {
              schema: { type: "string" },
            },
          },
        },
        "404": {
          description: "No private uploaded issuer for this hostname",
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
