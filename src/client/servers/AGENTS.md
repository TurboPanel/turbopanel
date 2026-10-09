# Server client routes (`src/client/servers`)

Delete and leftover-row forget live in `delete-guards.ts` and
`routes.ts`. Keep this note next to those files.

## Deleting a gone host

`DELETE /api/client/v1/servers/:id` still answers **409** `server_has_blockers`
when leftover rows point at the server. An offline daemon cannot clear those
rows, so the owner would be stuck.

## Every refusal names what is blocking it

A count is not actionable: "3 app environments are still placed on this server"
left the owner with nothing to go look for. So every blocker that can be named
carries its rows, in `blockers[]` on the preview and on the 409, and in
`removal.reasons[]` on the Services tab:

- `kind: 'environment'` →
  `items: { id, name, projectId, projectName, hasDatabase }[]`, sorted by
  project then environment name, capped at 50 with `more`. It is **every**
  environment the blocker count query counts — including the ones that carry a
  database, which the Services tab app list does not show. That gap is the
  reason the owner could not find the blocker in the first place, so do not
  filter this list down to what forget would remove (`environments` on the
  preview is that narrower list).
- `kind: 'managed'` / `kind: 'replica'` → `items: { id, name }[]`, one entry per
  database, so a blocked or forgettable member is findable by name. `count`
  stays the row count, so a database with two members here is `count: 2` with
  one item; `more` always describes `items`, never `count`.

`planServerForget` attaches them from the rows it already loads — it does not
add a query, and `listServerDeleteBlockers` stays counts-only. Reason messages
on the Services tab spell out up to three names (`"Project / Environment"`) and
then say "and N more" (`serverServicesRemovalNames`).

`GET /servers/:id/delete-preview` uses the same rights as delete (organization
scope plus manage on the server). It returns whether the server is connected
(`online` = live cell snapshot via `isSnapshotConnected`, or stored
`is_connected`), whether leftover rows may be forgotten (`canForget` = offline,
not the co-located control plane host, and no database still has its only copy
or its primary on this server), that colocated flag, blocker counts, leftover
containers / networks / addresses, app environments that will be removed,
database members that will be forgotten, and blocked databases (each list
capped at 50 plus `more`). System-workspace containers (and other
system-workspace RESTRICT rows torn down by `deleteSystemEnvironmentSubtree`)
are omitted the same way as the blocker scan. `GET /servers/:id/services` uses
the same `planServerForget` function so the Services tab and this preview cannot
disagree; blocked-database reasons name the database.

`DELETE` accepts an explicit `forgetResources=true` query flag (or JSON body
`{ forgetResources: true }`, same style as managed `detach=true`). Anything else
leaves the 409 blockers check unchanged. With the flag:

- a connected server answers **409** `server_online` (live snapshot or stored
  flag; the delete transaction re-reads `is_connected` `FOR UPDATE` and refuses
  if it became true)
- a database whose only copy is here, whose managed placement is here, or whose
  primary member is here answers **409** `server_has_blockers` with
  `blockedDatabases` (`only_member` or `primary_here`)
- the co-located control plane host is still **403**
- otherwise the same transaction drops non-system app environments (via the
  environment-cascade helper, without the running-container refusal), then
  forgettable member rows, leftover deployments / slots / copies, then
  container, address, and network rows, then continues the ordinary delete
  (system subtree, fabric membership, row, cell purge, license revoke, grant
  sync)

The `server.delete` audit context gains
`forgotten: { containers, networks, ips, environments, members, deployments, slots, copies }`
when that flag was used. Step-up stays `server.delete`.
