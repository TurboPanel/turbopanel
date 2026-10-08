# Server client routes (`src/client/servers`)

Delete and leftover-row forget live in `delete-guards.ts` and
`routes.ts`. Keep this note next to those files.

## Deleting a gone host

`DELETE /api/client/v1/servers/:id` still answers **409** `server_has_blockers`
when leftover container, network, or address rows point at the server. An
offline daemon cannot clear those rows, so the owner would be stuck.

`GET /servers/:id/delete-preview` uses the same rights as delete (organization
scope plus manage on the server). It returns whether the server is connected
(`online` = live cell snapshot via `isSnapshotConnected`, or stored
`is_connected`), whether leftover rows may be forgotten (`canForget` = offline,
not the co-located control plane host, and leftover blockers are only
container / network / address rows), that colocated flag, blocker counts, and
up to 50 leftover containers / networks / addresses plus a `more` count.
System-workspace containers (and other system-workspace RESTRICT rows torn down
by `deleteSystemEnvironmentSubtree`) are omitted the same way as the blocker
scan. `GET /servers/:id/services` uses the same exclusion and the same
`online` / `canForget` rule so the Services tab and this preview cannot
disagree.

`DELETE` accepts an explicit `forgetResources=true` query flag (or JSON body
`{ forgetResources: true }`, same style as managed `detach=true`). Anything else
leaves the 409 blockers check unchanged. With the flag:

- a connected server answers **409** `server_online` (live snapshot or stored
  flag; the delete transaction re-reads `is_connected` `FOR UPDATE` and refuses
  if it became true)
- leftover app environments, managed databases, database members, deployments,
  service slots, or storage copies still answer **409** `server_has_blockers`
- the co-located control plane host is still **403**
- otherwise the same transaction drops non-system container rows, then address
  rows, then network rows, then continues the ordinary delete (system subtree,
  fabric membership, row, cell purge, license revoke, grant sync)

The `server.delete` audit context gains `forgotten: { containers, networks, ips }`
when that flag was used. Step-up stays `server.delete`.
