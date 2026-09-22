/**
 * Dev-mode detection for the Deno instance.
 *
 * The developer surface (fleet/diagnostics/shell/dev-sync/tunnel under
 * `/api/developer/v1` + `/ws/developer/v1`) exists only to help a developer
 * babysit a development instance and its development nodes. It must never be
 * exposed by a production deployment.
 *
 * The surface is gated behind a **single explicit** flag — it never fails
 * open: `TURBOPANEL_DEV_SURFACE=1`. See {@link isExplicitDevelopmentMode}.
 */
export { isExplicitDevelopmentMode } from '../lib/dev-mode.ts'
import { isExplicitDevelopmentMode } from '../lib/dev-mode.ts'

export function isDeveloperSurfaceEnabled(): boolean {
  return isExplicitDevelopmentMode()
}
