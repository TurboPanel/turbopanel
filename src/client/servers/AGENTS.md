# Server client routes (`src/client/servers`)

Delete and leftover-row forget live in `delete-guards.ts` and
`routes.ts`. Keep this note next to those files.

## Deleting a gone host

`DELETE /api/client/v1/servers/:id` still answers **409** `server_has_blockers`
when leftover container, network, or address rows point at the server. An
offline daemon cannot clear those rows, so the owner would be stuck.

`GET /servers/:id/delete-preview` uses the same rights as delete (organization
scope plus manage on the server). It returns whether the server is connected
(`online` = `is_connected`), whether leftover rows may be forgotten
(`canForget` = offline and not the co-located control plane host), that
colocated flag, blocker counts, and up to 50 leftover containers / networks /
addresses plus a `more` count. System-workspace containers are omitted the same
way as the blocker scan — `deleteSystemEnvironmentSubtree` still tears those
down.

`DELETE` accepts an explicit `forgetResources=true` query flag (or JSON body
`{ forgetResources: true }`, same style as managed `detach=true`). Anything else
leaves the 409 blockers check unchanged. With the flag:

- a connected server answers **409** `server_online`
- the co-located control plane host is still **403**
- otherwise the same transaction drops non-system container rows, then address
  rows, then network rows, then continues the ordinary delete (system subtree,
  fabric membership, row, cell purge, license revoke, grant sync)

The `server.delete` audit context gains `forgotten: { containers, networks, ips }`
when that flag was used. Step-up stays `server.delete`.
