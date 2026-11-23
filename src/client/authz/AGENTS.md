# Authorization (`src/client/authz/`)

- `src/client/authz/` — seven-key permission catalog (`organization:own` /
  `organization:manage`, `team:own` / `team:manage`, `system:read` /
  `system:operate` / `system:manage`), `can`/`listVisible`, grant management.
  Org owner/manager grants never satisfy `system:*`; platform-admin bypass
  covers read/operate but `system:manage` is superadmin-only. Explicit
  `system:manage` grants are rejected at create time and ignored by `can()`.
  `GET /permissions` lists grantable keys only. Organization-wide subject grants
  (`actor_type=organization`) apply to every teammate in that org. Mutation
  routes on workspace-tree entities call `assertNotSystemOwnedOr403` after the
  org check (`403` `system_resource_immutable`); that guard keys on **workspace
  kind**, never on project type. Client workspace responses include
  `workspace.kind` (`user` \| `turbopanel`). `project.kind = 'system'` is a
  presentation/classification stamp only — never an authorization source.
- Who owns an organization: ask `can(db, uid, 'organization:own', 'organization', id)`
  (or `canOwnOrganization`, which adds the platform-admin bypass). Never read
  `grant` rows with `actor_type = 'user'` to decide it: ownership also arrives
  through a team grant and through an organization-wide grant. Last-owner
  guards (`org-owners.ts`: `assertNotLastOrgOwner`, `organizationWouldLoseAllOwners`)
  count distinct active (not disabled) people who own directly or through team
  membership, never grant rows, because an empty team or the organization actor
  holds a row but is nobody. Run the guard in the same transaction as the change,
  after `lockOrganizationOwnerGrants`. `assertNotLastTeamOwner` still counts
  rows (team ownership is direct grants only).
