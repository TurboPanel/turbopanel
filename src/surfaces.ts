/**
 * Versioned API/WS surface prefixes.
 *
 * Three audiences, each with its own REST and WebSocket namespace:
 *   - client : the end-user UI
 *   - admin  : the admin UI (inside the same UI app)
 *   - daemon : agent nodes connecting in
 *
 * `GET /api/health` is the single deliberately-unversioned probe shared by all.
 */
export const HEALTH_PATH = '/api/health'

export const CLIENT_API_PREFIX = '/api/client/v1'
export const ADMIN_API_PREFIX = '/api/admin/v1'
export const DAEMON_API_PREFIX = '/api/daemon/v1'

export const CLIENT_WS_PATH = '/ws/client/v1'
export const ADMIN_WS_PATH = '/ws/admin/v1'
export const DAEMON_WS_PATH = '/ws/daemon/v1'
