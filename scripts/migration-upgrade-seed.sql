-- Representative rows for scripts/check-migration-upgrade.mjs.
--
-- Runs against the PREVIOUS release's schema (the newest stable tag on
-- `live`), before this branch's migrations are applied on top, so every
-- column named here must exist in that release. Columns the release fills
-- with a default are left out on purpose: a later migration that tightens or
-- backfills them is exactly what the upgrade check is for.
--
-- When a release ships a migration that makes this seed invalid for the next
-- previous release (a new required column on a seeded table), extend the seed
-- in the same PR that bumps past that release.
--
-- Fixed ids keep failures readable; the check compares these rows column by
-- column after the upgrade.

INSERT INTO "user" (id, email, name, role, is_email_verified, is_2fa_enabled, is_disabled)
VALUES ('00000000-0000-7000-8000-000000000001', 'upgrade-owner@example.test', 'Upgrade Owner', 'superadmin', true, false, false);

INSERT INTO organization (id, name) VALUES
  ('00000000-0000-7000-8000-000000000101', 'Upgrade Org');

INSERT INTO team (id, organization_id, name) VALUES
  ('00000000-0000-7000-8000-000000000111', '00000000-0000-7000-8000-000000000101', 'Owners');

INSERT INTO teammate (id, team_id, user_id) VALUES
  ('00000000-0000-7000-8000-000000000121', '00000000-0000-7000-8000-000000000111', '00000000-0000-7000-8000-000000000001');

INSERT INTO workspace (id, organization_id, name, kind) VALUES
  ('00000000-0000-7000-8000-000000000201', '00000000-0000-7000-8000-000000000101', 'Main', 'user');

INSERT INTO project (id, workspace_id, organization_id, name, slug) VALUES
  ('00000000-0000-7000-8000-000000000301', '00000000-0000-7000-8000-000000000201', '00000000-0000-7000-8000-000000000101', 'Upgrade Project', 'upgrade-project');

INSERT INTO datacenter (id, organization_id, name) VALUES
  ('00000000-0000-7000-8000-000000000401', '00000000-0000-7000-8000-000000000101', 'Rack One');

-- server-a carries addresses; server-b has none (the empty case a backfill
-- must also survive).
INSERT INTO server (id, organization_id, name, hostname, machine_key, os_id, os_family, os_version, os_architecture, machine_class, timezone, is_connected, is_hosting_enabled) VALUES
  ('00000000-0000-7000-8000-000000000501', '00000000-0000-7000-8000-000000000101', 'server-a', 'server-a.example.test', 'upgrade-machine-key-a', 'ubuntu', 'debian', '24.04', 'amd64', 'virtual', 'UTC', true, true),
  ('00000000-0000-7000-8000-000000000502', '00000000-0000-7000-8000-000000000101', 'server-b', 'server-b.example.test', 'upgrade-machine-key-b', 'debian', 'debian', '13', 'arm64', 'physical', 'UTC', false, false);

INSERT INTO environment (id, project_id, server_id, name) VALUES
  ('00000000-0000-7000-8000-000000000601', '00000000-0000-7000-8000-000000000301', '00000000-0000-7000-8000-000000000501', 'production');

INSERT INTO service (id, environment_id, compose_service_name, name) VALUES
  ('00000000-0000-7000-8000-000000000701', '00000000-0000-7000-8000-000000000601', 'web', 'web');

INSERT INTO network (id, organization_id, kind, datacenter_id, server_id, environment_id, cidr, name) VALUES
  ('00000000-0000-7000-8000-000000000801', '00000000-0000-7000-8000-000000000101', 'datacenter', '00000000-0000-7000-8000-000000000401', NULL, NULL, '10.40.0.0/24', 'rack-one'),
  ('00000000-0000-7000-8000-000000000802', '00000000-0000-7000-8000-000000000101', 'docker', NULL, '00000000-0000-7000-8000-000000000501', NULL, '172.30.0.0/16', 'docker-a');

INSERT INTO subnet (id, network_id, server_id, cidr) VALUES
  ('00000000-0000-7000-8000-000000000811', '00000000-0000-7000-8000-000000000802', '00000000-0000-7000-8000-000000000501', '172.30.1.0/24');

-- A public address bound to server-a, an unbound public address, and a
-- datacenter-scoped address on server-a.
INSERT INTO ip (id, organization_id, address, allocation, scope, server_id, datacenter_id, network_id, description) VALUES
  ('00000000-0000-7000-8000-000000000901', '00000000-0000-7000-8000-000000000101', '203.0.113.10', 'dedicated', 'public', '00000000-0000-7000-8000-000000000501', NULL, NULL, 'server-a public'),
  ('00000000-0000-7000-8000-000000000902', '00000000-0000-7000-8000-000000000101', '2001:db8::20', 'shared', 'public', NULL, NULL, NULL, 'unbound public'),
  ('00000000-0000-7000-8000-000000000903', '00000000-0000-7000-8000-000000000101', '10.40.0.11', 'dedicated', 'datacenter', '00000000-0000-7000-8000-000000000501', '00000000-0000-7000-8000-000000000401', '00000000-0000-7000-8000-000000000801', 'server-a rack');

INSERT INTO hosting (id, service_id, ip_id, name, protocol) VALUES
  ('00000000-0000-7000-8000-000000000a01', '00000000-0000-7000-8000-000000000701', '00000000-0000-7000-8000-000000000901', 'web', 'http');

INSERT INTO hostname (id, hosting_id, routing_organization_id, hostname) VALUES
  ('00000000-0000-7000-8000-000000000a11', '00000000-0000-7000-8000-000000000a01', '00000000-0000-7000-8000-000000000101', 'app.example.test');

INSERT INTO managed (id, environment_id, server_id, engine, name, status) VALUES
  ('00000000-0000-7000-8000-000000000b01', '00000000-0000-7000-8000-000000000601', '00000000-0000-7000-8000-000000000501', 'postgres', 'main-db', 'ready');

INSERT INTO replica (id, managed_id, server_id, role, ordinal, status) VALUES
  ('00000000-0000-7000-8000-000000000b11', '00000000-0000-7000-8000-000000000b01', '00000000-0000-7000-8000-000000000501', 'primary', 1, 'ready'),
  ('00000000-0000-7000-8000-000000000b12', '00000000-0000-7000-8000-000000000b01', '00000000-0000-7000-8000-000000000502', 'replica', 2, 'provisioning');

INSERT INTO principal (id, organization_id, project_id, managed_id, kind, provider, username, applied_username) VALUES
  ('00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000101', '00000000-0000-7000-8000-000000000301', NULL, 'system', 'server', 'siteowner', 'siteowner');

INSERT INTO placement (id, principal_id, server_id, state, home, source) VALUES
  ('00000000-0000-7000-8000-000000000c11', '00000000-0000-7000-8000-000000000c01', '00000000-0000-7000-8000-000000000501', 'present', '/home/siteowner', 'manual');

INSERT INTO login (id, managed_id, principal_id, role, applied_username) VALUES
  ('00000000-0000-7000-8000-000000000c21', '00000000-0000-7000-8000-000000000b01', '00000000-0000-7000-8000-000000000c01', 'user', 'siteowner');
