# Organizations (`src/client/organizations/`)

- Member removal (`members.ts`, `DELETE /organizations/:id/members/:memberId`):
  "is this person an owner" is `holdsOrganizationOwnership` (the
  `organization:own` reading of `can()` without the platform-admin bypass), so
  an owner through a team or the organization actor is protected from managers
  and may remove other owners.
  The last-owner refusal (409) counts distinct active owners after the change
  (`../authz/org-owners.ts`), inside the removal transaction with the owner
  grants locked. Grant revocation (`DELETE /access/:id`) uses the same guard.
- No route here disables users, edits roles, or removes team members yet; the
  one that does must reuse the same guard.
