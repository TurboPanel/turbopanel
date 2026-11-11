/**
 * What a server is for. `witness` only votes in database failover and holds no
 * data. Pinned to `server_role_check` by `src/db/enum-checks.test.ts`.
 */
export const SERVER_ROLES = ['server', 'witness'] as const

export type ServerRole = (typeof SERVER_ROLES)[number]
