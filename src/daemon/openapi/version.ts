export const versionSchemas = {
  DaemonVersion: {
    type: "object",
    required: ["commit", "branch"],
    properties: {
      commit: {
        type: "string",
        description: "Daemon checkout HEAD commit (git rev-parse HEAD).",
      },
      branch: {
        type: "string",
        description:
          "Daemon checkout branch (git rev-parse --abbrev-ref HEAD).",
      },
    },
  },
};

export const versionPaths: Record<string, unknown> = {
  "/api/daemon/v1/version": {
    get: {
      tags: ["Daemon"],
      summary: "Co-located daemon checkout version",
      description:
        "Informational daemon repo commit and branch on this host (Deno self-hosted only). " +
        "Daemons may fetch this at connect time; connected daemons do not auto-sync from this value.",
      responses: {
        "200": {
          description: "Daemon checkout HEAD",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DaemonVersion" },
            },
          },
        },
      },
    },
  },
};
