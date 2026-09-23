import { ADMIN_API_PREFIX } from "../../app/surfaces.ts";

const cookieSecurity = [{ cookieAuth: [] }] as const;

/**
 * Control-plane and co-located daemon versions, plus the two upgrade
 * dispatches. The UI package target is reported on the control-plane unit
 * and installed by the same upgrade.
 */
export const INSTANCE_UPDATES_PATHS = {
  [`${ADMIN_API_PREFIX}/instance/updates`]: {
    get: {
      tags: ["Instance"],
      summary: "Read control-plane and co-located daemon update status",
      description:
        "Returns the installed `INSTANCE_VERSION` and commit (the same " +
        "values as `/api/health`) and the co-located daemon's reported " +
        "version, each beside the channel manifest target. The UI package " +
        "target is included on the control-plane unit and is installed by " +
        "the same upgrade.",
      security: [...cookieSecurity],
      responses: {
        "200": { description: "Installed versions and channel targets" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/instance`]: {
    post: {
      tags: ["Instance"],
      summary: "Queue a control-plane update on the co-located daemon",
      description:
        "Enqueues `instance-update` and returns 202 as soon as the message " +
        "is queued. The install restarts the control plane. Workers answers " +
        "422. A channel other than canary, rc, or release answers 422. No " +
        "connected co-located daemon answers 503.",
      security: [...cookieSecurity],
      responses: {
        "202": { description: "`{ ok: true, dispatched: true }`" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
        "422": { description: "Not applicable on this runtime or channel" },
        "503": { description: "No connected co-located daemon" },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/updates/daemon`]: {
    post: {
      tags: ["Instance"],
      summary: "Queue a daemon update on the co-located host",
      description:
        "Enqueues the existing daemon `update` for the co-located host. " +
        "The per-server update route refuses that host. Returns 202 once " +
        "queued. No connected co-located daemon answers 503.",
      security: [...cookieSecurity],
      responses: {
        "202": { description: "`{ ok: true, dispatched: true }`" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden — requires admin or superadmin role" },
        "503": { description: "No connected co-located daemon" },
      },
    },
  },
};
