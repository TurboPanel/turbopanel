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
  `workspace.kind` (`user` \| `turbopanel`; `WORKSPACE_KIND_SYSTEM` is only a
  deprecated alias). `project.kind = 'system'` is a
  presentation/classification stamp only — never an authorization source.
