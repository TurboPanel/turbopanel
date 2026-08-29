# Schema cutover ledger (phase 1) — historical archive

> **Executed.** This ledger drove phase 2 (`Schema cutover and squashed
> baseline`). Every rename/drop below is live in `schema.ts` and the squashed
> `migrations/0000_init.sql`, and the retired names are rejected by
> `table-naming.test.ts`. Nothing in this file is pending — keep it only for
> the **Reason** columns (why each table/column/constraint was kept, renamed,
> or dropped). Living schema docs are in `AGENTS.md` in this directory.

## Schema cutover ledger (phase 1)

This ledger is the **single source** the next phase (`Schema cutover and
squashed baseline`) executes against. Identifiers below are **current**
(`schema.ts` as of this writing) so phase 2 can apply them mechanically —
no re-derivation. Phase 2 may implement **only** what this ledger
authorizes: the locked table renames, the listed FK/constraint/index
renames, the listed column renames/drops, and the two name-format CHECK
drops. No `schema.ts` edits, no `drizzle-kit generate`, and no
route/record-helper changes belong to **this** phase.

`schema.ts` currently exports **51** `pgTable` definitions in declaration
order (not 60 — that figure was a planning estimate; the declaration list
below is complete). Physical names follow the single-lowercase-word rule
guarded by `table-naming.test.ts`.

### Step 1 — Inventory (current `schema.ts`)

Declaration order. Physical name, Drizzle export, full column list, and
every named CHECK / unique / index / FK constraint.

1. **`invitation`** (Drizzle export `invitation`)
   - Columns: `id`, `created_at`, `user_id`, `team_id`, `expires_at`, `email`, `status`, `grants`
   - Constraints: `idx_invitation_email` (index), `idx_invitation_user_id` (index), `idx_invitation_team_id` (index), `invitation_user_id_user_id_fk` (fk), `invitation_team_id_team_id_fk` (fk)

2. **`organization`** (Drizzle export `organization`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `name`, `slug`
   - Constraints: `organization_slug_unique` (unique)

3. **`tls`** (Drizzle export `tls`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`, `source`, `certificate_pem`, `private_key_pem`, `status`, `not_after`, `fingerprint_sha256`, `ca_state`, `ca_generation`
   - Constraints: `idx_tls_organization_id` (index), `idx_tls_not_after` (index), `idx_tls_organization_ca_generation` (index), `uniq_tls_organization_fingerprint_sha256` (uniqueIndex), `uniq_tls_organization_active_ca` (uniqueIndex), `tls_source_check` (check), `tls_name_format_check` (check), `tls_ca_state_check` (check), `tls_ca_lifecycle_source_check` (check), `tls_ca_generation_source_check` (check), `tls_ca_generation_required_check` (check), `tls_organization_id_organization_id_fk` (fk)

4. **`rotation`** (Drizzle export `rotation`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `from_ca_generation`, `to_ca_generation`, `state`, `started_at`, `completed_at`, `results`
   - Constraints: `idx_rotation_organization_id` (index), `uniq_rotation_inflight_organization` (uniqueIndex), `rotation_state_check` (check), `rotation_organization_id_organization_id_fk` (fk)

5. **`passkey`** (Drizzle export `passkey`)
   - Columns: `id`, `created_at`, `user_id`, `aaguid`, `name`, `public_key`, `credential_id`, `counter`, `device_type`, `is_backed_up`, `transports`
   - Constraints: `idx_passkey_credential_id` (index), `idx_passkey_user_id` (index), `passkey_user_id_user_id_fk` (fk)

6. **`datacenter`** (Drizzle export `datacenter`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`, `description`
   - Constraints: `idx_datacenter_organization_id` (index), `datacenter_name_format_check` (check), `datacenter_organization_id_organization_id_fk` (fk)

7. **`server`** (Drizzle export `server`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`, `hostname`, `machine_key`, `os_id`, `os_family`, `os_version`, `os_codename`, `os_pretty_name`, `os_architecture`, `timezone`, `is_time_sync_enabled`, `ntp_servers`, `ntp_last_synced_at`, `is_connected`, `status_changed_at`, `daemon`
   - Constraints: `idx_server_organization_id` (index), `idx_server_machine_key` (index), `idx_server_hostname` (index), `idx_server_connected` (index), `server_organization_id_organization_id_fk` (fk)

8. **`license`** (Drizzle export `license`)
   - Columns: `id`, `created_at`, `updated_at`, `organization_id`, `server_id`, `name`, `token`, `revoked_at`
   - Constraints: `idx_license_organization_id` (index), `uniq_license_server_id` (uniqueIndex), `license_organization_id_organization_id_fk` (fk), `license_server_id_server_id_fk` (fk)

9. **`command`** (Drizzle export `command`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `server_id`, `actor_type`, `actor_id`, `name`, `status`, `attempts`, `context`, `result_summary`, `error_code`, `error_message`, `queued_at`, `dispatch_started_at`, `sent_at`, `acked_at`, `started_at`, `finished_at`, `expires_at`
   - Constraints: `idx_command_server_id_created_at` (index), `idx_command_status` (index), `idx_command_deploy_environment_created` (index), `command_server_id_server_id_fk` (fk)

10. **`dispatch`** (Drizzle export `dispatch`)
   - Columns: `command_id`, `created_at`, `payload`, `expires_at`
   - Constraints: `idx_dispatch_expires_at` (index), `dispatch_command_id_command_id_fk` (fk)

11. **`network`** (Drizzle export `network`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `datacenter_id`, `server_id`, `environment_id`, `kind`, `cidr`, `name`
   - Constraints: `idx_network_server_id` (index), `idx_network_organization_id` (index), `idx_network_datacenter_id` (index), `idx_network_environment_id` (index), `uniq_network_datacenter_cidr` (uniqueIndex), `uniq_network_organization_managed` (uniqueIndex), `network_kind_check` (check), `network_single_scope_check` (check), `network_name_format_check` (check), `network_organization_id_organization_id_fk` (fk), `network_datacenter_id_datacenter_id_fk` (fk), `network_server_id_server_id_fk` (fk)

12. **`fabric`** (Drizzle export `fabric`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `cidr`, `name`
   - Constraints: `idx_fabric_organization_id` (index), `uniq_fabric_organization_id` (uniqueIndex), `fabric_name_format_check` (check), `fabric_organization_id_organization_id_fk` (fk)

13. **`ip`** (Drizzle export `ip`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `datacenter_id`, `network_id`, `server_id`, `address`, `allocation`, `scope`, `description`
   - Constraints: `idx_ip_organization_id` (index), `idx_ip_datacenter_id` (index), `idx_ip_network_id` (index), `idx_ip_server_id` (index), `idx_ip_scope_server_datacenter` (index), `uniq_ip_org_address` (uniqueIndex), `ip_allocation_check` (check), `ip_scope_check` (check), `ip_datacenter_scope_check` (check), `ip_datacenter_anchor_check` (check), `ip_datacenter_member_network_check` (check), `ip_organization_id_organization_id_fk` (fk), `ip_datacenter_id_datacenter_id_fk` (fk), `ip_network_id_network_id_fk` (fk), `ip_server_id_server_id_fk` (fk)

14. **`relay`** (Drizzle export `relay`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `fabric_id`, `server_id`, `address`, `role`, `keepalive`, `endpoint_address`, `public_key`, `prefix`, `advertised_cidrs`, `preshared_key`
   - Constraints: `idx_relay_fabric_id` (index), `idx_relay_server_id` (index), `relay_fabric_server_unique` (unique), `uniq_relay_fabric_address` (unique), `uniq_relay_fabric_public_key` (unique), `relay_role_check` (check), `relay_keepalive_check` (check), `relay_member_advertised_cidrs_empty_check` (check), `relay_fabric_id_fabric_id_fk` (fk), `relay_server_id_server_id_fk` (fk)

15. **`segment`** (Drizzle export `segment`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `network_id`, `server_id`, `cidr`
   - Constraints: `idx_segment_network_id` (index), `idx_segment_server_id` (index), `segment_network_server_unique` (unique), `segment_network_id_network_id_fk` (fk), `segment_server_id_server_id_fk` (fk)

16. **`workspace`** (Drizzle export `workspace`)
   - Columns: `id`, `created_at`, `updated_at`, `organization_id`, `name`, `description`, `kind`
   - Constraints: `idx_workspace_organization_id` (index), `uniq_workspace_organization_turbopanel` (uniqueIndex), `workspace_name_format_check` (check), `workspace_kind_check` (check), `workspace_organization_id_organization_id_fk` (fk)

17. **`project`** (Drizzle export `project`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `workspace_id`, `repository_id`, `name`, `description`
   - Constraints: `idx_project_workspace_id` (index), `idx_project_repository_id` (index), `uniq_project_workspace_system_component` (uniqueIndex), `project_name_format_check` (check), `project_workspace_id_workspace_id_fk` (fk), `project_repository_id_repository_id_fk` (fk, `ON DELETE RESTRICT`)
   - `repository_id` is the one Git repository this project **is** (null =
     not repository-backed). Every `x-turbopanel.source.sourceId` in the
     project's compose has to name it — see `src/lib/compose/AGENTS.md` →
     "One repository per project".

18. **`environment`** (Drizzle export `environment`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `project_id`, `server_id`, `generation`, `name`, `description`
   - Constraints: `idx_environment_project_id` (index), `idx_environment_server_id` (index), `environment_name_format_check` (check), `environment_project_id_project_id_fk` (fk), `environment_server_id_server_id_fk` (fk)

19. **`managed`** (Drizzle export `managed`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `server_id`, `name`, `engine`, `status`
   - Constraints: `idx_managed_environment_id` (index), `idx_managed_server_id` (index), `idx_managed_engine` (index), `managed_environment_id_unique` (uniqueIndex), `managed_name_format_check` (check), `managed_status_check` (check), `managed_environment_id_environment_id_fk` (fk), `managed_server_id_server_id_fk` (fk)

20. **`node`** (Drizzle export `node`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `managed_id`, `server_id`, `role`, `replica_class`, `is_read_eligible`, `ordinal`, `replication_transport`, `private_port`, `status`
   - Constraints: `idx_node_managed_id` (index), `idx_node_server_id` (index), `uniq_node_primary` (uniqueIndex), `uniq_node_server_private_port` (uniqueIndex), `uniq_node_managed_ordinal` (unique), `uniq_node_managed_server` (unique), `node_role_check` (check), `node_replica_class_check` (check), `node_ordinal_positive_check` (check), `node_transport_check` (check), `node_status_check` (check), `node_managed_id_managed_id_fk` (fk), `node_server_id_server_id_fk` (fk)

21. **`leaf`** (Drizzle export `leaf`)
   - Columns: `id`, `organization_id`, `server_id`, `kind`, `managed_id`, `node_id`, `ca_id`, `ca_generation`, `not_after`, `issued_at`
   - Constraints: `idx_leaf_not_after` (index), `idx_leaf_organization_id` (index), `uniq_leaf_ingress_server` (uniqueIndex), `uniq_leaf_engine_node` (uniqueIndex), `leaf_kind_check` (check), `leaf_kind_keys_check` (check), `leaf_organization_id_organization_id_fk` (fk), `leaf_server_id_server_id_fk` (fk), `leaf_managed_id_managed_id_fk` (fk), `leaf_node_id_node_id_fk` (fk), `leaf_ca_id_tls_id_fk` (fk)

22. **`recovery`** (Drizzle export `recovery`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `managed_id`, `kind`, `source_primary_member_id`, `target_member_id`, `state`, `started_at`, `completed_at`
   - Constraints: `idx_recovery_managed_id` (index), `uniq_recovery_inflight_managed` (uniqueIndex), `recovery_kind_check` (check), `recovery_state_check` (check), `recovery_managed_id_managed_id_fk` (fk)

23. **`variable`** (Drizzle export `variable`)
   - Columns: `id`, `created_at`, `updated_at`, `organization_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `hosting_id`, `server_id`, `binding_id`, `key`, `value`, `is_secret`, `is_literal`, `is_for_build`, `is_for_runtime`, `description`
   - Constraints: `idx_variable_organization_id` (index), `idx_variable_workspace_id` (index), `idx_variable_project_id` (index), `idx_variable_environment_id` (index), `idx_variable_service_id` (index), `idx_variable_hosting_id` (index), `idx_variable_server_id` (index), `idx_variable_binding_id` (index), `uniq_var_org` (uniqueIndex), `uniq_var_workspace` (uniqueIndex), `uniq_var_project` (uniqueIndex), `uniq_var_environment` (uniqueIndex), `uniq_var_service` (uniqueIndex), `uniq_var_hosting` (uniqueIndex), `uniq_var_server` (uniqueIndex), `variable_exactly_one_parent_check` (check), `variable_key_format_check` (check), `variable_organization_id_organization_id_fk` (fk), `variable_workspace_id_workspace_id_fk` (fk), `variable_project_id_project_id_fk` (fk), `variable_environment_id_environment_id_fk` (fk), `variable_service_id_service_id_fk` (fk), `variable_hosting_id_hosting_id_fk` (fk), `variable_server_id_server_id_fk` (fk), `variable_binding_id_binding_id_fk` (fk)

24. **`service`** (Drizzle export `service`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `name`, `description`, `compose_service_name`
   - Constraints: `idx_service_environment_id` (index), `uniq_service_environment_compose_name` (uniqueIndex), `service_name_format_check` (check), `service_environment_id_environment_id_fk` (fk)

25. **`deployment`** (Drizzle export `deployment`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `server_id`, `desired_generation`, `applied_generation`, `desired_hash`, `status`, `last_command_id`, `finished_at`, `duration_ms`, `outcome`
   - Constraints: `idx_deployment_environment_id` (index), `idx_deployment_server_id` (index), `uniq_deployment_environment_server` (unique), `deployment_status_check` (check), `deployment_generation_check` (check), `deployment_outcome_check` (check), `deployment_environment_id_environment_id_fk` (fk), `deployment_server_id_server_id_fk` (fk)

26. **`task`** (Drizzle export `task`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `environment_id`, `service_id`, `server_id`, `address`, `slot`, `generation`, `desired_state`
   - Constraints: `idx_task_environment_generation` (index), `idx_task_server_id` (index), `uniq_task_service_slot` (unique), `task_slot_nonnegative_check` (check), `task_desired_state_check` (check), `task_environment_id_environment_id_fk` (fk), `task_service_id_service_id_fk` (fk), `task_server_id_server_id_fk` (fk)

27. **`label`** (Drizzle export `label`)
   - Columns: `id`, `created_at`, `updated_at`, `server_id`, `key`, `value`
   - Constraints: `idx_label_server_id` (index), `uniq_label_server_key` (unique), `label_key_format_check` (check), `label_server_id_server_id_fk` (fk)

28. **`hosting`** (Drizzle export `hosting`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `service_id`, `tls_id`, `ip_id`, `name`, `description`
   - Constraints: `idx_hosting_service_id` (index), `idx_hosting_tls_id` (index), `idx_hosting_ip_id` (index), `hosting_name_format_check` (check), `hosting_service_id_service_id_fk` (fk), `hosting_tls_id_tls_id_fk` (fk), `hosting_ip_id_ip_id_fk` (fk)

29. **`container`** (Drizzle export `container`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `service_id`, `server_id`, `container_id`, `container_name`, `status`, `role`, `compose_service_name`, `ordinal`
   - Constraints: `idx_container_service_id` (index), `idx_container_server_id` (index), `idx_container_status` (index), `uniq_container_server_container_id` (uniqueIndex), `uniq_container_service_role_ordinal` (uniqueIndex), `container_ordinal_positive_check` (check), `container_role_check` (check), `container_service_id_service_id_fk` (fk), `container_server_id_server_id_fk` (fk)

30. **`principal`** (Drizzle export `principal`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `kind`, `provider`, `username`, `password`, `project_id`, `managed_id`
   - Constraints: `idx_principal_project_id` (index), `idx_principal_managed_id` (index), `principal_kind_check` (check), `principal_provider_check` (check), `principal_username_format_check` (check), `principal_project_id_project_id_fk` (fk), `principal_managed_id_managed_id_fk` (fk)

31. **`entitlement`** (Drizzle export `entitlement`)
   - Columns: `id`, `created_at`, `updated_at`, `principal_id`, `runtime`, `series`, `granted_by`
   - Constraints: `idx_entitlement_principal_id` (index), `entitlement_unique` (unique), `entitlement_runtime_check` (check), `entitlement_series_check` (check), `entitlement_granted_by_check` (check), `entitlement_principal_id_principal_id_fk` (fk)

32. **`ssh`** (Drizzle export `sshKey`)
   - Columns: `id`, `created_at`, `updated_at`, `principal_id`, `name`, `key_type`, `public_key`, `fingerprint`, `comment`, `user_id`, `bits`
   - Constraints: `idx_ssh_principal_id` (index), `idx_ssh_fingerprint` (index), `ssh_fingerprint_unique` (unique), `ssh_type_check` (check), `ssh_fingerprint_check` (check), `ssh_public_key_check` (check), `ssh_name_check` (check), `ssh_principal_id_principal_id_fk` (fk), `ssh_user_id_user_id_fk` (fk)

33. **`tenancy`** (Drizzle export `tenancy`)
   - Columns: `id`, `created_at`, `updated_at`, `principal_id`, `service_id`
   - Constraints: `idx_steward_principal_id` (index), `idx_steward_service_id` (index), `steward_principal_service_unique` (unique), `steward_principal_id_principal_id_fk` (fk), `steward_service_id_service_id_fk` (fk)

34. **`binding`** (Drizzle export `binding`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `principal_id`, `service_id`, `database_name`, `key_prefix`, `is_emit_engine_defaults`
   - Constraints: `idx_binding_principal_id` (index), `idx_binding_service_id` (index), `uniq_binding_service_engine_defaults` (uniqueIndex), `uniq_binding_service_prefix` (unique), `binding_key_prefix_format_check` (check), `binding_database_name_format_check` (check), `binding_principal_id_principal_id_fk` (fk), `binding_service_id_service_id_fk` (fk)

35. **`secret`** (Drizzle export `secret`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `principal_id`, `provider`, `name`, `secret_envelope`, `expires_at`
   - Constraints: `idx_credential_organization_id` (index), `idx_credential_principal_id` (index), `credential_provider_check` (check), `credential_organization_id_organization_id_fk` (fk), `credential_principal_id_principal_id_fk` (fk)

36. **`storage`** (Drizzle export `storage`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `workspace_id`, `project_id`, `environment_id`, `service_id`, `kind`, `name`, `access_mode`, `retention`, `generation`, `principal_id`, `content_envelope`
   - Constraints: `idx_storage_organization_id` (index), `idx_storage_workspace_id` (index), `idx_storage_project_id` (index), `idx_storage_environment_id` (index), `idx_storage_service_id` (index), `uniq_storage_environment_compose_volume_key` (uniqueIndex), `storage_kind_check` (check), `storage_access_mode_check` (check), `storage_retention_check` (check), `storage_at_most_one_parent_check` (check), `storage_organization_id_organization_id_fk` (fk), `storage_workspace_id_workspace_id_fk` (fk), `storage_project_id_project_id_fk` (fk), `storage_environment_id_environment_id_fk` (fk), `storage_service_id_service_id_fk` (fk), `storage_principal_id_principal_id_fk` (fk)

37. **`copy`** (Drizzle export `storageCopy`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `storage_id`, `server_id`, `credential_id`, `provider`, `role`, `state`, `path`, `endpoint`, `generation`
   - Constraints: `idx_location_storage_id` (index), `idx_location_server_id` (index), `idx_location_credential_id` (index), `uniq_location_storage_primary` (uniqueIndex), `uniq_location_storage_server_provider` (uniqueIndex), `location_provider_check` (check), `location_role_check` (check), `location_state_check` (check), `location_storage_id_storage_id_fk` (fk), `location_server_id_server_id_fk` (fk), `location_credential_id_credential_id_fk` (fk)

38. **`mount`** (Drizzle export `mount`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `storage_id`, `service_id`, `destination_path`, `subpath`, `is_read_only`
   - Constraints: `idx_mount_storage_id` (index), `idx_mount_service_id` (index), `uniq_mount_service_destination` (unique), `mount_storage_id_storage_id_fk` (fk), `mount_service_id_service_id_fk` (fk)

39. **`gitapp`** (Drizzle export `forge`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `provider`, `name`, `base_url`, `api_url`, `external_app_id`, `app_slug`, `client_id`, `redirect_uri`, `webhook_origin`, `is_public`, `custom_git_user`, `custom_git_port`, `synced_at`, `envelopes`, `webhook_ref`, `webhook_token_hash`
   - Constraints: `idx_gitapp_organization_id` (index), `idx_gitapp_provider` (index), `uniq_gitapp_webhook_ref` (unique), `uniq_gitapp_provider_base_external` (unique), `uniq_gitapp_webhook_token_hash` (unique), `gitapp_provider_check` (check), `gitapp_organization_id_organization_id_fk` (fk)

40. **`installation`** (Drizzle export `gitConnection`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `app_id`, `provider`, `external_installation_id`, `account_login`, `account_type`, `suspended_at`, `oauth_envelope`
   - Constraints: `idx_installation_organization_id` (index), `idx_installation_app_id` (index), `uniq_installation_organization_app_external` (unique), `installation_provider_check` (check), `installation_organization_id_organization_id_fk` (fk), `installation_app_id_gitapp_id_fk` (fk)

41. **`source`** (Drizzle export `repository`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `installation_id`, `service_id`, `environment_id`, `credential_id`, `provider`, `repository_url`, `repository_external_id`, `default_branch`, `subdirectory`, `auto_deploy`
   - Constraints: `idx_source_organization_id` (index), `idx_source_installation_id` (index), `idx_source_service_id` (index), `idx_source_environment_id` (index), `idx_source_credential_id` (index), `uniq_source_organization_installation_repository` (unique), `source_provider_check` (check), `source_auto_deploy_check` (check), `source_at_most_one_parent_check` (check), `source_organization_id_organization_id_fk` (fk), `source_installation_id_installation_id_fk` (fk), `source_service_id_service_id_fk` (fk), `source_environment_id_environment_id_fk` (fk), `source_credential_id_credential_id_fk` (fk)

42. **`delivery`** (Drizzle export `webhookDelivery`)
   - Columns: `id`, `created_at`, `provider`, `external_delivery_id`, `event`
   - Constraints: `idx_delivery_created_at` (index), `uniq_delivery_provider_external` (unique), `delivery_provider_check` (check)

43. **`grant`** (Drizzle export `grant`)
   - Columns: `id`, `created_at`, `actor_type`, `actor_id`, `entity_type`, `entity_id`, `permission`
   - Constraints: `idx_grant_entity` (index), `idx_grant_actor` (index), `grant_unique` (unique)

44. **`session`** (Drizzle export `session`)
   - Columns: `id`, `created_at`, `updated_at`, `user_id`, `expires_at`, `token`, `ip_address`, `user_agent`
   - Constraints: `idx_session_user_id` (index), `session_token_unique` (unique), `session_user_id_user_id_fk` (fk)

45. **`setting`** (Drizzle export `setting`)
   - Columns: `id`, `created_at`, `updated_at`, `key`, `value`
   - Constraints: `setting_key_unique` (unique)

46. **`account`** (Drizzle export `account`)
   - Columns: `id`, `created_at`, `updated_at`, `user_id`, `provider_id`, `provider_user_id`, `access_token`, `refresh_token`, `id_token`, `access_token_expires_at`, `refresh_token_expires_at`, `scope`, `password`
   - Constraints: `idx_account_user_id` (index), `account_user_id_user_id_fk` (fk)

47. **`teammate`** (Drizzle export `teammate`)
   - Columns: `id`, `created_at`, `team_id`, `user_id`
   - Constraints: `idx_teammate_team_id` (index), `idx_teammate_user_id` (index), `teammate_team_user_unique` (unique), `teammate_team_id_team_id_fk` (fk), `teammate_user_id_user_id_fk` (fk)

48. **`team`** (Drizzle export `team`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `organization_id`, `name`
   - Constraints: `idx_team_organization_id` (index), `team_name_format_check` (check), `team_organization_id_organization_id_fk` (fk)

49. **`user`** (Drizzle export `user`)
   - Columns: `id`, `created_at`, `updated_at`, `metadata`, `options`, `name`, `email`, `is_email_verified`, `is_2fa_enabled`, `is_disabled`, `role`
   - Constraints: `user_email_unique` (unique), `user_name_format_check` (check)

50. **`2fa`** (Drizzle export `twoFactor`)
   - Columns: `id`, `created_at`, `user_id`, `secret`, `is_verified`, `backup_codes`
   - Constraints: `idx_2fa_user_id` (index), `2fa_user_id_user_id_fk` (fk)

51. **`verification`** (Drizzle export `verification`)
   - Columns: `id`, `created_at`, `updated_at`, `expires_at`, `identifier`, `value`
   - Constraints: `verification_identifier_unique` (unique)

#### Step 1 usage cross-reference

Complete per-column read/write evidence for every inventoried column.
Scope is first-party TypeScript under `turbopanel/src/` excluding
`schema.ts` itself. A **read** is a table-qualified `export.column`
select / `eq` / `.returning({ column })`, a whole-row
`select().from(table)` / `getTableColumns(table)`, or a tagged-SQL
`physical.column` fragment. A **write** is `.insert(table).values({`
column `})`, `.update(table).set({` column `})`, or a Postgres
default (`uuidv7()`, `defaultNow()`) applied on those inserts.
Coarse identifier matches (`expiresAt` on a different table) do
**not** count. `no` / `no` is an explicit no-reader/no-writer
finding, not an omitted row.

A column is a **drop candidate** only when a table-qualified
read **and** write are both absent **and** Step 3 authorizes the
drop. Unused pairing / Better Auth / reserved columns stay **Keep**.

**1. `invitation`** (export `invitation`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/access/routes.ts` |
| `created_at` | yes | no | Whole-row accept select; no first-party insert. |
| `user_id` | yes | no | Present on the accept select; no first-party insert. |
| `team_id` | yes | no | Present on the accept select; no first-party insert. |
| `expires_at` | yes | yes | `client/access/routes.ts` |
| `email` | yes | no | Read on accept (`client/access/routes.ts`). **No first-party `insert(invitation)`**. |
| `status` | yes | yes | `client/access/routes.ts` |
| `grants` | yes | no | Read on accept; no first-party insert. |

**2. `organization`** (export `organization`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `client/org-context.ts` (+1) |
| `updated_at` | no | yes | Touched by org PATCH (`client/organizations/routes.ts`); no qualified select. |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `name` | yes | yes | `client/authn/install-state.ts` (+3) |
| `slug` | yes | no | Selected in `developer/routes-core.ts`; install never populates it. |

**3. `tls`** (export `tls`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/tls/organization-ca.ts` (+1) |
| `updated_at` | yes | yes | `client/tls/organization-ca.ts` (+1) |
| `metadata` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `options` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `name` | yes | yes | `client/tls/organization-ca.ts` (+1) |
| `source` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+3) |
| `certificate_pem` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `private_key_pem` | yes | yes | `admin/reencrypt-secrets.ts` (+2) |
| `status` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `not_after` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `fingerprint_sha256` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `ca_state` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+2) |
| `ca_generation` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+2) |

**4. `rotation`** (export `rotation`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/tls/changeover-lease.ts` |
| `created_at` | yes | yes | `client/tls/changeover-lease.ts` |
| `updated_at` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `metadata` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `options` | yes | no | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `organization_id` | yes | yes | `client/tls/changeover-lease.ts` |
| `from_ca_generation` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `to_ca_generation` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `state` | yes | yes | `client/tls/changeover-lease.ts` |
| `started_at` | yes | yes | `client/tls/changeover-lease.ts` |
| `completed_at` | yes | yes | `admin/reencrypt-secrets.ts` (insert/select on this table). |
| `results` | yes | yes | `client/tls/changeover-fanout.ts` |

**5. `passkey`** (export `passkey`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `created_at` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `user_id` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `aaguid` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `name` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `public_key` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `credential_id` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `counter` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `device_type` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `is_backed_up` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |
| `transports` | no | no | Better Auth–compat reserved table; zero first-party `passkey` imports in `src/`. |

**6. `datacenter`** (export `datacenter`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/datacenters/routes.ts` |
| `updated_at` | yes | yes | `client/datacenters/routes.ts` |
| `metadata` | yes | yes | `client/datacenters/routes.ts` (+1) |
| `options` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `name` | yes | yes | `client/datacenters/routes.ts` (+1) |
| `description` | yes | yes | `client/datacenters/routes.ts` |

**7. `server`** (export `server`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `developer/routes-core.ts` (+3) |
| `updated_at` | no | yes | Touched by hello/status writes; list/detail select other columns. |
| `metadata` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `organization_id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `name` | yes | yes | `client/authn/install-state.ts` (+3) |
| `hostname` | yes | yes | `client/authn/install-state.ts` (+3) |
| `machine_key` | yes | yes | `client/authn/install-state.ts` (+3) |
| `os_id` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_family` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_version` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_codename` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_pretty_name` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `os_architecture` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `timezone` | yes | yes | `client/openapi/servers.ts` (+3) |
| `is_time_sync_enabled` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `ntp_servers` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `ntp_last_synced_at` | yes | yes | `daemon/cell/postgres-projection.ts` (+2) |
| `is_connected` | yes | yes | `client/managed/ha-recovery.ts` (+3) |
| `status_changed_at` | yes | yes | `client/servers/update-status.ts` (+3) |
| `daemon` | yes | yes | `daemon/authn/daemon-state.ts` (+3) |

**8. `license`** (export `license`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `client/authn/license.ts` |
| `updated_at` | no | yes | Touched on bind/revoke; list selects other columns. |
| `organization_id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `server_id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `name` | yes | yes | `client/authn/install-state.ts` (+2) |
| `token` | yes | yes | `client/authn/install-state.ts` (+1) |
| `revoked_at` | yes | yes | `client/authn/install-state.ts` (+3) |

**9. `command`** (export `command`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/environments/deployment-history-routes.ts` (+3) |
| `created_at` | yes | yes | `lib/db/command-records.ts` (+2) |
| `updated_at` | yes | yes | `lib/db/command-records.ts` |
| `metadata` | yes | yes | `lib/db/command-records.ts` |
| `options` | no | no | Pairing column; unused today (`command-records.ts` never selects/sets it). |
| `server_id` | yes | yes | `daemon/execution-log-ingest.ts` (+3) |
| `actor_type` | yes | yes | `lib/db/command-records.ts` (+1) |
| `actor_id` | yes | yes | `lib/db/command-records.ts` (+1) |
| `name` | yes | yes | `lib/db/command-records.ts` (+2) |
| `status` | yes | yes | `daemon/execution-log-ingest.ts` (+3) |
| `attempts` | yes | yes | `lib/db/command-records.ts` |
| `context` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `result_summary` | yes | yes | `lib/db/command-records.ts` (+1) |
| `error_code` | yes | yes | `lib/db/command-records.ts` (+1) |
| `error_message` | yes | yes | `lib/db/command-records.ts` (+1) |
| `queued_at` | yes | yes | `lib/db/command-records.ts` (+2) |
| `dispatch_started_at` | yes | yes | `lib/db/command-records.ts` |
| `sent_at` | yes | yes | `lib/db/command-records.ts` |
| `acked_at` | yes | yes | `lib/db/command-records.ts` |
| `started_at` | yes | yes | `lib/db/command-records.ts` (+1) |
| `finished_at` | yes | yes | `lib/db/command-records.ts` (+2) |
| `expires_at` | yes | yes | `lib/db/command-records.ts` |

**10. `dispatch`** (export `dispatch`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `command_id` | yes | yes | `lib/db/command-records.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` when dispatch row is inserted (`command-records.ts`). |
| `payload` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `expires_at` | yes | yes | Written by `retainCommandDispatch`; sweep reads `expires_at` in `command-records.ts`. |

**11. `network`** (export `network`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/networks/routes.ts` |
| `updated_at` | yes | yes | `client/networks/routes.ts` |
| `metadata` | yes | yes | `client/environments/validate-docker-external-networks.ts` (+1) |
| `options` | yes | yes | `client/environments/validate-docker-external-networks.ts` (+2) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `datacenter_id` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `server_id` | yes | yes | `client/environments/validate-docker-external-networks.ts` (+2) |
| `environment_id` | yes | yes | `client/managed/ingress-attachments.ts` (+1) |
| `kind` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `cidr` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `name` | yes | yes | `client/networks/routes.ts` (+1) |

**12. `fabric`** (export `fabric`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/fabric-records.ts` (+3) |
| `created_at` | yes | yes | `lib/net/private-endpoint.ts` |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert; no qualified select. |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | yes | yes | `lib/db/fabric-records.ts` (+2) |
| `organization_id` | yes | yes | `lib/commands/consumer.ts` (+2) |
| `cidr` | yes | yes | `lib/db/fabric-records.ts` |
| `name` | no | no | Nullable label; `insert(fabric)` in `fabric-records.ts` omits it. |

**13. `ip`** (export `ip`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/ips/routes.ts` (+2) |
| `updated_at` | yes | yes | `client/ips/routes.ts` |
| `metadata` | yes | yes | `client/ips/routes.ts` |
| `options` | yes | yes | `client/ips/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `datacenter_id` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `network_id` | yes | yes | `client/datacenters/routes.ts` (+2) |
| `server_id` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `address` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `allocation` | yes | yes | `client/ips/routes.ts` |
| `scope` | yes | yes | `client/datacenters/routes.ts` (+3) |
| `description` | yes | yes | `client/ips/routes.ts` |

**14. `relay`** (export `relay`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/fabric-records.ts` (+2) |
| `created_at` | no | yes | Postgres `defaultNow()` on insert (`fabric-records.ts`). |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert/update. |
| `metadata` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+3) |
| `options` | yes | yes | `lib/db/fabric-records.ts` (+1) |
| `fabric_id` | yes | yes | `lib/db/fabric-records.ts` (+1) |
| `server_id` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+3) |
| `address` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+2) |
| `role` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+2) |
| `keepalive` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `endpoint_address` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `public_key` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `prefix` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+1) |
| `advertised_cidrs` | yes | yes | `client/organizations/fabric-routes-helpers.ts` (+2) |
| `preshared_key` | yes | yes | `lib/db/fabric-records.ts` |

**15. `segment`** (export `segment`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/fabric-records.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` on insert (`fabric-records.ts`). |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `metadata` | no | no | Pairing column; unused today (keep with `options`). |
| `options` | yes | yes | `lib/db/fabric-records.ts` |
| `network_id` | yes | yes | `client/managed/ingress-attachments.ts` (+1) |
| `server_id` | yes | yes | `client/managed/ingress-attachments.ts` (+1) |
| `cidr` | yes | yes | `lib/db/fabric-records.ts` |

**16. `workspace`** (export `workspace`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` (+3) |
| `created_at` | yes | yes | `client/workspaces/routes.ts` |
| `updated_at` | yes | yes | `client/workspaces/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `name` | yes | yes | `client/display-name-uniqueness.ts` (+3) |
| `description` | yes | yes | `client/workspaces/routes.ts` |
| `kind` | yes | yes | `client/authz/workspace-kind-ancestry.ts` (+3) |

**17. `project`** (export `project`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/projects/routes.ts` |
| `updated_at` | yes | yes | `client/projects/routes.ts` |
| `metadata` | yes | yes | `client/managed/context.ts` (+3) |
| `options` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `workspace_id` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `repository_id` | yes | yes | `lib/db/repository-records.ts` (+1) |
| `name` | yes | yes | `client/display-name-uniqueness.ts` (+2) |
| `description` | yes | yes | `client/projects/routes.ts` |

**18. `environment`** (export `environment`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/environments/routes.ts` |
| `updated_at` | yes | yes | `client/environments/routes.ts` |
| `metadata` | yes | yes | `client/environments/routes.ts` (+1) |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `project_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `server_id` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `generation` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `name` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `description` | yes | yes | `client/environments/routes.ts` (+1) |

**19. `managed`** (export `managed`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/managed/routes.ts` |
| `updated_at` | yes | yes | `client/managed/routes.ts` |
| `metadata` | yes | yes | `client/managed/routes.ts` (+3) |
| `options` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `environment_id` | yes | yes | `client/bindings/routes-helpers.ts` (+3) |
| `server_id` | yes | yes | `client/managed/routes.ts` (+1) |
| `name` | yes | yes | `client/managed/routes.ts` |
| `engine` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `status` | yes | yes | `client/managed/apply-prepare.ts` (+3) |

**20. `node`** (export `node`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/managed/ha-recovery.ts` (+3) |
| `created_at` | yes | yes | `client/managed/members.ts` |
| `updated_at` | yes | yes | `client/managed/members.ts` |
| `metadata` | yes | yes | `client/managed/members.ts` (+1) |
| `options` | yes | yes | `client/managed/members.ts` |
| `managed_id` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `server_id` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `role` | yes | yes | `client/bindings/resolve-endpoint.ts` (+3) |
| `replica_class` | yes | yes | `client/managed/ha-desired.ts` (+1) |
| `is_read_eligible` | yes | yes | `client/bindings/resolve-endpoint.ts` (+2) |
| `ordinal` | yes | yes | `client/bindings/resolve-endpoint.ts` (+2) |
| `replication_transport` | yes | yes | `client/managed/members.ts` |
| `private_port` | yes | yes | `client/managed/ingress-desired.ts` (+1) |
| `status` | yes | yes | `client/managed/members.ts` |

**21. `leaf`** (export `leaf`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `organization_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `server_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+1) |
| `kind` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+1) |
| `managed_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `node_id` | yes | yes | `client/tls/leaf-renewal-sweep.ts` (+1) |
| `ca_id` | no | yes | Written by leaf upsert (`client/tls/leaf-tracking.ts`); renewal sweep keys other columns. |
| `ca_generation` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `not_after` | yes | yes | `client/tls/leaf-renewal-sweep.ts` |
| `issued_at` | no | yes | Written on leaf upsert; not selected on the renewal path. |

**22. `recovery`** (export `recovery`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/managed/ha-recovery.ts` (+1) |
| `created_at` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `metadata` | yes | yes | `client/managed/ha-recovery.ts` |
| `options` | yes | no | `client/authn/install-state.ts` (insert/select on this table). |
| `managed_id` | yes | yes | `client/managed/ha-recovery.ts` (+1) |
| `kind` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `source_primary_member_id` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `target_member_id` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |
| `state` | yes | yes | `lib/db/recovery-records.ts` |
| `started_at` | yes | yes | `lib/db/recovery-records.ts` |
| `completed_at` | yes | yes | `client/authn/install-state.ts` (insert/select on this table). |

**23. `variable`** (export `variable`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/variables/routes.ts` |
| `updated_at` | yes | yes | `client/variables/routes.ts` |
| `organization_id` | yes | yes | `client/variables/routes.ts` |
| `workspace_id` | yes | yes | `client/variables/routes.ts` |
| `project_id` | yes | yes | `client/variables/routes.ts` |
| `environment_id` | yes | yes | `client/projects/empty-setup.ts` (+1) |
| `service_id` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `hosting_id` | yes | yes | `client/bindings/routes-helpers.ts` (+1) |
| `server_id` | yes | yes | `client/variables/resolve-inherited.ts` (+1) |
| `binding_id` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `key` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `value` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `is_secret` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `is_literal` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `is_for_build` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `is_for_runtime` | yes | yes | `client/bindings/materialize.ts` (+2) |
| `description` | yes | yes | `client/variables/routes.ts` |

**24. `service`** (export `service`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/services/routes.ts` |
| `updated_at` | yes | yes | `client/services/routes.ts` |
| `metadata` | yes | yes | `client/services/routes.ts` |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `environment_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `name` | yes | yes | `client/bindings/impact.ts` (+1) |
| `description` | yes | yes | `client/services/routes.ts` |
| `compose_service_name` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |

**25. `deployment`** (export `deployment`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/deployment-records.ts` |
| `created_at` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `metadata` | yes | yes | `lib/db/deployment-records.ts` |
| `options` | yes | yes | `client/environments/deploy-routes.ts` (+1) |
| `environment_id` | yes | yes | `client/environments/site-releases.ts` (+3) |
| `server_id` | yes | yes | `daemon/rehydrate-secrets.ts` (+2) |
| `desired_generation` | yes | yes | `lib/db/deployment-history.ts` |
| `applied_generation` | yes | yes | `lib/db/deployment-history.ts` |
| `desired_hash` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `status` | yes | yes | `lib/commands/consumer.ts` (+2) |
| `last_command_id` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `finished_at` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `duration_ms` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |
| `outcome` | yes | yes | `client/environments/deploy-routes.ts` (insert/select on this table). |

**26. `task`** (export `task`)

Cron-style scheduled command on a service. Constraints: `uniq_task_service_name`
on `(service_id, name)`; `idx_task_service_id`; `task_concurrency_policy_check`
`IN ('allow','forbid','replace')`; `task_service_id_service_id_fk` CASCADE. No
execution columns (`last_run_at` / result) and no run-history table.

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/task-records.ts` |
| `created_at` | yes | yes | `lib/db/task-records.ts` |
| `updated_at` | yes | yes | `lib/db/task-records.ts` |
| `metadata` | yes | yes | `client/tasks/routes.ts` |
| `options` | yes | yes | `client/tasks/routes.ts` |
| `service_id` | yes | yes | `lib/db/task-records.ts` |
| `name` | yes | yes | `lib/db/task-records.ts` |
| `schedule` | yes | yes | `client/tasks/routes.ts` |
| `command` | yes | yes | `client/tasks/routes.ts` |
| `timezone` | yes | yes | `client/tasks/routes.ts` |
| `is_enabled` | yes | yes | `client/tasks/routes.ts` |
| `concurrency_policy` | yes | yes | `client/tasks/routes.ts` |
| `timeout_seconds` | yes | yes | `client/tasks/routes.ts` |

**27. `label`** (export `label`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/password.ts` (insert/select on this table). |
| `created_at` | yes | yes | `client/authn/password.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `client/authn/password.ts` (insert/select on this table). |
| `server_id` | yes | yes | `lib/db/label-records.ts` |
| `key` | yes | yes | `lib/db/label-records.ts` (+1) |
| `value` | yes | yes | `lib/schedule/plan-deploy.ts` |

**28. `hosting`** (export `hosting`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/hostings/routes.ts` |
| `updated_at` | yes | yes | `client/hostings/routes.ts` |
| `metadata` | yes | yes | `client/hostings/routes.ts` |
| `options` | yes | yes | `client/environments/deploy-routes.ts` (+3) |
| `service_id` | yes | yes | `client/bindings/routes-helpers.ts` (+3) |
| `tls_id` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `ip_id` | yes | yes | `client/environments/deploy-routes.ts` (+2) |
| `name` | yes | yes | `client/hostings/routes.ts` |
| `description` | yes | yes | `client/hostings/routes.ts` |

**29. `container`** (export `container`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/containers/routes.ts` (+1) |
| `updated_at` | yes | yes | `client/containers/routes.ts` (+1) |
| `metadata` | yes | yes | `client/containers/routes.ts` (+1) |
| `options` | yes | yes | `client/containers/routes.ts` (+1) |
| `service_id` | yes | yes | `client/containers/routes.ts` (+3) |
| `server_id` | yes | yes | `client/containers/routes.ts` (+3) |
| `container_id` | yes | yes | `client/containers/routes.ts` (+3) |
| `container_name` | yes | yes | `client/containers/routes.ts` (+3) |
| `status` | yes | yes | `client/containers/routes.ts` (+3) |
| `role` | yes | yes | `client/containers/routes.ts` (+3) |
| `compose_service_name` | yes | yes | `client/containers/routes.ts` (+3) |
| `ordinal` | yes | yes | `client/containers/routes.ts` (+3) |

**30. `principal`** (export `principal`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/managed/routes.ts` (+2) |
| `updated_at` | yes | yes | `client/managed/routes.ts` (+2) |
| `metadata` | yes | yes | `client/bindings/routes.ts` (+3) |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `kind` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `provider` | yes | yes | `client/managed/routes.ts` (+3) |
| `username` | yes | yes | `client/bindings/materialize.ts` (+3) |
| `password` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `project_id` | yes | yes | `client/principals/reconcile.ts` (+3) |
| `managed_id` | yes | yes | `client/bindings/impact.ts` (+3) |

**31. `entitlement`** (export `entitlement`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | yes | PK default on insert (`principals/store.ts`); list selects runtime/series/granted_by. |
| `created_at` | no | yes | Postgres `defaultNow()` on insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `principal_id` | yes | yes | `client/principals/store.ts` |
| `runtime` | yes | yes | `client/principals/store.ts` |
| `series` | yes | yes | `client/principals/store.ts` |
| `granted_by` | yes | yes | `client/principals/store.ts` |

**32. `ssh`** (export `sshKey`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/principals/ssh-keys.ts` |
| `created_at` | yes | yes | `client/principals/ssh-keys.ts` |
| `updated_at` | no | yes | Postgres `defaultNow()`; `ssh-keys.ts` selects other columns. |
| `principal_id` | yes | yes | `client/principals/ssh-keys.ts` |
| `name` | yes | yes | `client/principals/ssh-keys.ts` |
| `key_type` | yes | yes | `client/principals/ssh-keys.ts` |
| `public_key` | yes | yes | `client/principals/ssh-keys.ts` |
| `fingerprint` | yes | yes | `client/principals/ssh-keys.ts` |
| `comment` | yes | yes | `client/principals/ssh-keys.ts` |
| `user_id` | no | yes | Written as provenance on insert (`ssh-keys.ts`); not selected on list. |
| `bits` | yes | yes | `client/principals/ssh-keys.ts` |

**33. `tenancy`** (export `tenancy`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | yes | PK default; join queries use `principal_id` / `service_id`. |
| `created_at` | no | yes | Postgres `defaultNow()` on insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `principal_id` | yes | yes | `client/principals/tenancies.ts` (+1) |
| `service_id` | yes | yes | `client/principals/tenancies.ts` (+1) |

**34. `binding`** (export `binding`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `created_at` | yes | yes | `client/bindings/routes.ts` |
| `updated_at` | yes | yes | `client/bindings/routes.ts` |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | no | no | Pairing column; unused today. |
| `principal_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `service_id` | yes | yes | `client/bindings/impact.ts` (+3) |
| `database_name` | yes | yes | `client/bindings/impact.ts` (+2) |
| `key_prefix` | yes | yes | `client/bindings/impact.ts` (+3) |
| `is_emit_engine_defaults` | yes | yes | `client/bindings/materialize.ts` (+2) |

**35. `credential`** (export `credential`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+2) |
| `created_at` | no | yes | Postgres `defaultNow()` on insert (`client/repositories/routes.ts`). |
| `updated_at` | no | yes | Postgres `defaultNow()` on insert. |
| `metadata` | no | yes | Written on deploy-key create (`publicKey` / fingerprint jsonb). |
| `options` | no | no | Pairing column; unused today. |
| `organization_id` | yes | yes | `client/repositories/routes.ts` |
| `principal_id` | no | no | Optional FK present in schema; no first-party insert/select of `credential.principalId`. |
| `provider` | yes | yes | `client/repositories/routes-helpers.ts` (+1) |
| `name` | no | yes | Written on deploy-key create (`client/repositories/routes.ts` insert); not later selected qualified. |
| `secret_envelope` | yes | yes | `admin/reencrypt-secrets.ts` (+1) |
| `expires_at` | no | no | No table-qualified `credential.expiresAt` anywhere in `src/` (other tables' `expires_at` are unrelated). |

**36. `storage`** (export `storage`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |
| `created_at` | yes | yes | `client/storage/routes.ts` |
| `updated_at` | yes | yes | `client/storage/routes.ts` |
| `metadata` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `options` | yes | yes | `client/storage/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `workspace_id` | yes | yes | `client/storage/routes.ts` (+1) |
| `project_id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `environment_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `service_id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `kind` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `name` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `access_mode` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `retention` | yes | yes | `client/storage/routes.ts` (+1) |
| `generation` | yes | yes | `client/storage/routes.ts` |
| `principal_id` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `content_envelope` | yes | yes | `admin/reencrypt-secrets.ts` (+1) |

**37. `location`** (export `location`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `created_at` | yes | yes | `client/storage/routes.ts` |
| `updated_at` | yes | yes | `client/storage/routes.ts` |
| `metadata` | yes | yes | `client/storage/routes.ts` |
| `options` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `storage_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `server_id` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `credential_id` | yes | yes | `client/storage/routes.ts` |
| `provider` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `role` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `state` | yes | yes | `client/storage/routes.ts` |
| `path` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |
| `endpoint` | yes | yes | `client/storage/routes.ts` |
| `generation` | yes | yes | `client/storage/routes.ts` |

**38. `mount`** (export `mount`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/storage/routes.ts` |
| `created_at` | yes | yes | `client/storage/routes.ts` |
| `updated_at` | yes | yes | `client/storage/routes.ts` |
| `metadata` | yes | yes | `client/storage/routes.ts` |
| `options` | yes | yes | `client/storage/routes.ts` |
| `storage_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `service_id` | yes | yes | `client/environments/deploy-prepare.ts` (+3) |
| `destination_path` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `subpath` | yes | yes | `client/environments/deploy-prepare.ts` (+2) |
| `is_read_only` | yes | yes | `client/environments/deploy-prepare.ts` (+1) |

**39. `gitapp`** (export `forge`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/forges/handlers.ts` (+2) |
| `created_at` | yes | yes | `lib/git/forge-records.ts` |
| `updated_at` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `metadata` | yes | no | `client/forges/handlers.ts` (insert/select on this table). |
| `options` | yes | no | `client/forges/handlers.ts` (insert/select on this table). |
| `organization_id` | yes | yes | `client/forges/handlers.ts` (+1) |
| `provider` | yes | yes | `client/repositories/routes.ts` (+1) |
| `name` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `base_url` | yes | yes | `client/repositories/routes.ts` |
| `api_url` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `external_app_id` | yes | yes | `lib/git/forge-records.ts` |
| `app_slug` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `client_id` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `redirect_uri` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `webhook_origin` | yes | yes | `client/repositories/routes.ts` |
| `is_public` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `custom_git_user` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `custom_git_port` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `synced_at` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `envelopes` | yes | yes | `client/forges/handlers.ts` (insert/select on this table). |
| `webhook_ref` | yes | yes | `client/repositories/routes.ts` (+1) |
| `webhook_token_hash` | yes | yes | `lib/git/forge-records.ts` |

**40. `installation`** (export `gitConnection`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/repositories/routes.ts` |
| `updated_at` | yes | yes | `client/repositories/routes.ts` |
| `metadata` | yes | yes | `client/repositories/routes.ts` |
| `options` | yes | yes | `client/repositories/routes.ts` |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+1) |
| `app_id` | yes | yes | `client/repositories/routes.ts` (+2) |
| `provider` | yes | yes | `client/repositories/routes.ts` (+3) |
| `external_installation_id` | yes | yes | `client/repositories/routes.ts` (+2) |
| `account_login` | yes | yes | `client/repositories/routes.ts` |
| `account_type` | yes | yes | `client/repositories/routes.ts` |
| `suspended_at` | yes | yes | `client/repositories/routes.ts` (+3) |
| `oauth_envelope` | yes | yes | `lib/git/gitlab-oauth-token.ts` |

**41. `repository`** (export `repository`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `created_at` | yes | yes | `client/repositories/routes.ts` (+1) |
| `updated_at` | yes | yes | `client/repositories/routes.ts` |
| `metadata` | yes | yes | `client/repositories/routes.ts` |
| `options` | yes | yes | `client/repositories/routes.ts` (+1) |
| `organization_id` | yes | yes | `client/authz/create-access-grant.ts` (+3) |
| `installation_id` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `service_id` | yes | yes | `client/repositories/routes.ts` (+1) |
| `environment_id` | yes | yes | `client/repositories/routes.ts` (+1) |
| `credential_id` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `provider` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `repository_url` | yes | yes | `client/environments/deploy-sources.ts` (+1) |
| `repository_external_id` | yes | yes | `client/repositories/routes.ts` (+2) |
| `default_branch` | yes | yes | `client/environments/deploy-sources.ts` (+3) |
| `subdirectory` | yes | yes | `client/environments/deploy-sources.ts` (+2) |
| `auto_deploy` | yes | yes | `client/repositories/routes.ts` (+1) |

**42. `delivery`** (export `webhookDelivery`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `lib/db/webhook-delivery-records.ts` |
| `created_at` | yes | yes | Default on insert; sweep cursor in `webhook-delivery-records.ts`. |
| `provider` | yes | yes | `lib/db/webhook-delivery-records.ts` |
| `external_delivery_id` | yes | yes | `lib/db/webhook-delivery-records.ts` |
| `event` | no | yes | Written on claim insert; not selected after. |

**43. `grant`** (export `grant`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/access/routes.ts` (+3) |
| `created_at` | yes | yes | `client/access/routes.ts` |
| `actor_type` | yes | yes | `client/access/routes.ts` (+3) |
| `actor_id` | yes | yes | `client/access/routes.ts` (+3) |
| `entity_type` | yes | yes | `client/access/routes.ts` (+3) |
| `entity_id` | yes | yes | `client/access/routes.ts` (+3) |
| `permission` | yes | yes | `client/access/routes.ts` (+3) |

**44. `session`** (export `session`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/session-store.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` on session insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on session insert. |
| `user_id` | yes | yes | `client/access/routes.ts` (+3) |
| `expires_at` | yes | yes | `client/authn/session-store.ts` |
| `token` | yes | yes | `client/authn/session-store.ts` |
| `ip_address` | no | yes | Written by `createSession` (`session-store.ts`); login lookup does not select it. |
| `user_agent` | no | yes | Written by `createSession`; login lookup does not select it. |

**45. `setting`** (export `setting`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/install-state.ts` |
| `created_at` | yes | yes | `admin/openapi/index.ts` (insert/select on this table). |
| `updated_at` | yes | yes | `admin/openapi/index.ts` (insert/select on this table). |
| `key` | yes | yes | `admin/public-urls.ts` (+3) |
| `value` | yes | yes | `admin/reencrypt-secrets.ts` (+3) |

**46. `account`** (export `account`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/otp-http.ts` |
| `created_at` | no | yes | Postgres `defaultNow()` on account insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on account insert. |
| `user_id` | yes | yes | `client/authn/credentials.ts` (+2) |
| `provider_id` | yes | yes | `client/authn/credentials.ts` (+1) |
| `provider_user_id` | no | yes | Written on credential-account insert (`install-state.ts`, `http.ts`); not later selected. |
| `access_token` | no | no | OAuth leftover; credential accounts only write `password` / `provider_id`. |
| `refresh_token` | no | no | OAuth leftover; unused. |
| `id_token` | no | no | OAuth leftover; unused. |
| `access_token_expires_at` | no | no | OAuth leftover; unused. |
| `refresh_token_expires_at` | no | no | OAuth leftover; unused. |
| `scope` | no | no | OAuth leftover; unused. |
| `password` | yes | yes | `client/authn/credentials.ts` |

**47. `teammate`** (export `teammate`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/org-context.ts` |
| `created_at` | no | yes | `client/access/routes.ts` (insert/select on this table). |
| `team_id` | yes | yes | `client/access/routes.ts` (+3) |
| `user_id` | yes | yes | `client/access/routes.ts` (+3) |

**48. `team`** (export `team`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/access/routes.ts` (+3) |
| `created_at` | yes | yes | `client/teams/routes.ts` |
| `updated_at` | yes | yes | `client/teams/routes.ts` |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | no | no | Pairing column; unused today. |
| `organization_id` | yes | yes | `client/access/routes.ts` (+3) |
| `name` | yes | yes | `client/teams/routes.ts` |

**49. `user`** (export `user`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/credentials.ts` (+3) |
| `created_at` | no | yes | Postgres `defaultNow()` on user insert. |
| `updated_at` | no | yes | Postgres `defaultNow()` on user insert/update. |
| `metadata` | no | no | Pairing column; unused today. |
| `options` | no | no | Pairing column; unused today. |
| `name` | no | no | Sign-in is email-only; inserts omit `user.name`. |
| `email` | yes | yes | `client/authn/credentials.ts` (+3) |
| `is_email_verified` | yes | yes | `client/authn/credentials.ts` (+2) |
| `is_2fa_enabled` | no | no | No first-party reader/writer; 2FA table also unused. |
| `is_disabled` | yes | yes | `client/authn/credentials.ts` (+2) |
| `role` | yes | yes | `client/authn/install-state.ts` (+3) |

**50. `2fa`** (export `twoFactor`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `created_at` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `user_id` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `secret` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `is_verified` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |
| `backup_codes` | no | no | Better Auth–compat reserved table; zero first-party `twoFactor` imports in `src/`. |

**51. `verification`** (export `verification`)

| Column | Read | Write | Evidence |
| --- | --- | --- | --- |
| `id` | yes | yes | `client/authn/email-otp.ts` (+1) |
| `created_at` | yes | yes | `client/authn/email-otp.ts` |
| `updated_at` | no | yes | Postgres `defaultNow()` on OTP/email-verification upsert. |
| `expires_at` | yes | yes | `client/authn/email-otp.ts` (+1) |
| `identifier` | yes | yes | `client/authn/email-otp.ts` (+1) |
| `value` | yes | yes | `client/authn/email-otp.ts` (+1) |

Authz raw-SQL touch points (flag only; **do not edit in this phase**):
`src/client/authz/evaluator.ts`, `src/client/authz/create-access-grant.ts`,
`src/client/authz/workspace-kind-ancestry.ts`. After cutover, every
hand-written `sql` tagged-template fragment that names `copy`, `tag`, or `subnet` must
double-quote those identifiers (`"copy"`, `"tag"`, `"subnet"`) because
they are SQL-adjacent words.

There is no Storage-classification or Subsystem-docs table **in this
file** — those live in the repo-root `AGENTS.md`. Stray old table names
in **this** file are corrected in Step 4 below.

### Step 2 — Locked table renames

Mechanical substitution: in every listed FK/constraint/index name, replace
the old physical-table token with the new one, and apply the listed column
renames (which also rewrite FK constraint names that embed the old column).

| Old table (export) | New table (export) | FK/constraint/index names to rename (old → new) | FK columns to rename |
| --- | --- | --- | --- |
| `gitapp` (`forge`) | `forge` (`forge`) | `idx_gitapp_organization_id` → `idx_forge_organization_id`; `idx_gitapp_provider` → `idx_forge_provider`; `gitapp_organization_id_organization_id_fk` → `forge_organization_id_organization_id_fk`; `gitapp_provider_check` → `forge_provider_check`; `uniq_gitapp_webhook_ref` → `uniq_forge_webhook_ref`; `uniq_gitapp_provider_base_external` → `uniq_forge_provider_base_external`; `uniq_gitapp_webhook_token_hash` → `uniq_forge_webhook_token_hash` | `gitapp.credentials` → `forge.envelopes` |
| `installation` (`gitConnection`) | `connection` (`gitConnection`) | `idx_installation_organization_id` → `idx_connection_organization_id`; `idx_installation_app_id` → `idx_connection_forge_id`; `installation_organization_id_organization_id_fk` → `connection_organization_id_organization_id_fk`; `installation_app_id_gitapp_id_fk` → `connection_forge_id_forge_id_fk`; `installation_provider_check` → `connection_provider_check`; `uniq_installation_organization_app_external` → `uniq_connection_organization_forge_external` | `installation.app_id` → `connection.forge_id` |
| `source` (`source`) | `repository` (`repository`) | `idx_source_organization_id` → `idx_repository_organization_id`; `idx_source_installation_id` → `idx_repository_connection_id`; `idx_source_service_id` → `idx_repository_service_id`; `idx_source_environment_id` → `idx_repository_environment_id`; `idx_source_credential_id` → `idx_repository_secret_id`; `source_organization_id_organization_id_fk` → `repository_organization_id_organization_id_fk`; `source_installation_id_installation_id_fk` → `repository_connection_id_connection_id_fk`; `source_service_id_service_id_fk` → `repository_service_id_service_id_fk`; `source_environment_id_environment_id_fk` → `repository_environment_id_environment_id_fk`; `source_credential_id_credential_id_fk` → `repository_secret_id_secret_id_fk`; `uniq_source_organization_installation_repository` → `uniq_repository_organization_connection_repository`; `source_provider_check` → `repository_provider_check`; `source_auto_deploy_check` → `repository_auto_deploy_check`; `source_at_most_one_parent_check` → `repository_at_most_one_parent_check` | `source.installation_id` → `repository.connection_id`; `source.credential_id` → `repository.secret_id` |
| `steward` (`steward`) | `tenancy` (`tenancy`) | `idx_steward_principal_id` → `idx_tenancy_principal_id`; `idx_steward_service_id` → `idx_tenancy_service_id`; `steward_principal_id_principal_id_fk` → `tenancy_principal_id_principal_id_fk`; `steward_service_id_service_id_fk` → `tenancy_service_id_service_id_fk`; `steward_principal_service_unique` → `tenancy_principal_service_unique` | none |
| `location` (`location`) | `copy` (export `storageCopy`) | `idx_location_storage_id` → `idx_copy_storage_id`; `idx_location_server_id` → `idx_copy_server_id`; `idx_location_credential_id` → `idx_copy_secret_id`; `location_storage_id_storage_id_fk` → `copy_storage_id_storage_id_fk`; `location_server_id_server_id_fk` → `copy_server_id_server_id_fk`; `location_credential_id_credential_id_fk` → `copy_secret_id_secret_id_fk`; `uniq_location_storage_primary` → `uniq_copy_storage_primary`; `uniq_location_storage_server_provider` → `uniq_copy_storage_server_provider`; `location_provider_check` → `copy_provider_check`; `location_role_check` → `copy_role_check`; `location_state_check` → `copy_state_check` | `location.credential_id` → `copy.secret_id` (`copy.storage_id` / `copy.server_id` unchanged) |
| `credential` (`credential`) | `secret` (`secret`) | `idx_credential_organization_id` → `idx_secret_organization_id`; `idx_credential_principal_id` → `idx_secret_principal_id`; `credential_organization_id_organization_id_fk` → `secret_organization_id_organization_id_fk`; `credential_principal_id_principal_id_fk` → `secret_principal_id_principal_id_fk`; `credential_provider_check` → `secret_provider_check` | none (referencing columns renamed on their own tables above) |
| `node` (`node`) | `replica` (`replica`) | `idx_node_managed_id` → `idx_replica_managed_id`; `idx_node_server_id` → `idx_replica_server_id`; `node_managed_id_managed_id_fk` → `replica_managed_id_managed_id_fk`; `node_server_id_server_id_fk` → `replica_server_id_server_id_fk`; `uniq_node_primary` → `uniq_replica_primary`; `uniq_node_server_private_port` → `uniq_replica_server_private_port`; `uniq_node_managed_ordinal` → `uniq_replica_managed_ordinal`; `uniq_node_managed_server` → `uniq_replica_managed_server`; `node_role_check` → `replica_role_check`; `node_replica_class_check` → `replica_replica_class_check`; `node_ordinal_positive_check` → `replica_ordinal_positive_check`; `node_transport_check` → `replica_transport_check`; `node_status_check` → `replica_status_check` | `leaf.node_id` → `leaf.replica_id` (and its FK `leaf_node_id_node_id_fk` → `leaf_replica_id_replica_id_fk` / unique `uniq_leaf_engine_node` → `uniq_leaf_engine_replica`) |
| `segment` (`segment`) | `subnet` (`subnet`) | `idx_segment_network_id` → `idx_subnet_network_id`; `idx_segment_server_id` → `idx_subnet_server_id`; `segment_network_id_network_id_fk` → `subnet_network_id_network_id_fk`; `segment_server_id_server_id_fk` → `subnet_server_id_server_id_fk`; `segment_network_server_unique` → `subnet_network_server_unique` | none (`subnet.network_id` / `subnet.server_id` unchanged) |
| `rotation` (`rotation`) | `changeover` (`changeover`) | `idx_rotation_organization_id` → `idx_changeover_organization_id`; `rotation_organization_id_organization_id_fk` → `changeover_organization_id_organization_id_fk`; `uniq_rotation_inflight_organization` → `uniq_changeover_inflight_organization`; `rotation_state_check` → `changeover_state_check` | none |
| `task` (`task`, replica-slot meaning) | `slot` (`slot`) | `uniq_task_service_slot` → `uniq_slot_service_slot`; `idx_task_environment_generation` → `idx_slot_environment_generation`; `idx_task_server_id` → `idx_slot_server_id`; `task_environment_id_environment_id_fk` → `slot_environment_id_environment_id_fk`; `task_service_id_service_id_fk` → `slot_service_id_service_id_fk`; `task_server_id_server_id_fk` → `slot_server_id_server_id_fk`; `task_slot_nonnegative_check` → `slot_slot_nonnegative_check`; `task_desired_state_check` → `slot_desired_state_check` | none — table keeps its own columns (`environment_id`, `service_id`, `server_id`, `address`, `slot`, `generation`, `desired_state`) |

**Forthcoming (not created in phase 2's rename pass; owned by later phases):**
a **new-meaning** `task` (cron). The replica-slot table
is `slot`; the cron table reclaims the physical name `task` after that
rename (helpers `src/lib/db/task-records.ts`; client CRUD
`src/client/tasks/routes.ts`). `tag` / `marker` exist (helpers `src/lib/db/tag-records.ts`). `copy`,
`tag`, and `subnet` are SQL-adjacent words — double-quote
them in every hand-written `sql` tagged-template fragment (known touch points listed in
Step 1).

### Step 3 — Column adjudication

Phase 2 implements **exactly** the DDL delta below (plus the Step 2
table/FK/index/column renames). Every other inventoried column and
named constraint is **Keep**. The complete catalog that follows is
the mechanical checklist — one keep/rename/drop line per schema item
so cutover does not re-open `schema.ts` to guess.

#### DDL delta (the only mutations besides Step 2 renames)

| Current identifier | Decision | Reason |
| --- | --- | --- |
| `hosting.name` (`hosting_name_format_check`) | **Drop the CHECK**, keep the column | Validation is app-side (`display-name-format.ts`) per the documented names-are-labels rule. |
| `datacenter.name` (`datacenter_name_format_check`) | **Drop the CHECK**, keep the column | Same reason. |
| `gitapp.credentials` | **Rename** to `forge.envelopes` | Stops the name clash with the new `secret` table; contents unchanged (`privateKeyEnvelope?`, `clientSecretEnvelope?`, `webhookSecretEnvelope?`). |
| `installation.provider` (becomes `connection.provider`) | **Keep** | Hot denormalized filter column: `src/client/repositories/routes.ts`, `webhook-trigger.ts`, `github-app-token.ts`, `gitlab-oauth-token.ts` select/filter it directly rather than always joining `forge.provider`. |
| `service.compose_service_name` / `container.compose_service_name` | **Keep both** | Independently authoritative — `service` is the compose key of the logical service; `container` is the reported/allocated Docker identity. Shared name is not a true duplicate; phase 2 must not conflate them. |
| `storage.generation` | **Keep** | Step 1 found an API reader (`STORAGE_SELECT` in `src/client/storage/routes.ts` + `serialize.ts`). Materialization tracking still uses `location.generation` (→ `copy.generation`); the storage-level column is the identity generation the API already echoes. |
| `principal.metadata.home` | **Keep** (no DDL) | jsonb field inside `metadata`, not a column. Intentionally mirrors the derived `/srv/users/<username>` path for display. Phase 3+ code auditors only. |
| `command.options` | **Keep** | `metadata`/`options` pairing is a hard schema rule. Unused today; dropping would break the invariant for no gain. |
| `service.metadata` / `service.options` | **Keep** | Same pairing convention; reserved for future non-indexed facts / per-service placement. |
| `mount.metadata` / `mount.options` | **Keep** | Same pairing convention. |
| `segment.metadata` / `segment.options` (→ `subnet`) | **Keep** | Same pairing convention. |
| `location.provider` CHECK (`block`/`nfs`/`cifs`/`s3`/`s3_compatible`/`sftp`/`ftp`/`webdav` plus live `docker`/`path`) | **Keep** all values | `docker`/`path` are exercised today; the remainder mirror `credential.provider`'s CHECK and are pre-provisioned for the storage-provider roadmap in the `location`/`storage` doc comments — not dead, just unimplemented. |
| `credential.provider` CHECK (→ `secret.provider`) | **Keep** all values | Same forward-provisioning reason; `git_deploy_key` is already live. |
| `organization.slug` | **Keep** column + `organization_slug_unique` | Documented always-NULL / reserved for a future feature. Writes never populate it; the unique is defensive. |
| `credential.expires_at` (would have become `secret.expires_at`) | **Drop** | Step 1 grep found no reader — no credential-rotation or expiry-sweep path references `credential.expiresAt` / `credential.expires_at`. |

#### Complete keep / rename / drop catalog

One line per column and per named constraint. Table renames themselves
are in Step 2; this catalog records what happens to each item **on**
those tables.

**1. `invitation`** (export `invitation` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `invitation.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `invitation.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `invitation.user_id` | column | **Keep** | Live column. Present on the accept select; no first-party insert. |
| `invitation.team_id` | column | **Keep** | Live column. Present on the accept select; no first-party insert. |
| `invitation.expires_at` | column | **Keep** | Live column. `client/access/routes.ts` |
| `invitation.email` | column | **Keep** | Live column. Read on accept (`client/access/routes.ts`). **No first-party `insert(invitation)`**. |
| `invitation.status` | column | **Keep** | Live column. `client/access/routes.ts` |
| `invitation.grants` | column | **Keep** | Live column. Read on accept; no first-party insert. |
| `idx_invitation_email` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_invitation_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_invitation_team_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `invitation_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `invitation_team_id_team_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**2. `organization`** (export `organization` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `organization.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `organization.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `organization.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `organization.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `organization.options` | column | **Keep** | Live jsonb; `client/bindings/materialize.ts` (+3) |
| `organization.name` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `organization.slug` | column | **Keep** | Always-NULL reserved slug + `organization_slug_unique`; developer status echoes it. |
| `organization_slug_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**3. `tls`** (export `tls` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `tls.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `tls.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `tls.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `tls.metadata` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+3) |
| `tls.options` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+3) |
| `tls.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `tls.name` | column | **Keep** | Live column. `client/tls/organization-ca.ts` (+1) |
| `tls.source` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+3) |
| `tls.certificate_pem` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `tls.private_key_pem` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+2) |
| `tls.status` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+3) |
| `tls.not_after` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `tls.fingerprint_sha256` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `tls.ca_state` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+2) |
| `tls.ca_generation` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+2) |
| `idx_tls_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_tls_not_after` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_tls_organization_ca_generation` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_tls_organization_fingerprint_sha256` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_tls_organization_active_ca` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_source_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_state_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_lifecycle_source_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_generation_source_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_ca_generation_required_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `tls_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**4. `rotation`** → `changeover` (export `changeover`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `rotation.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `rotation.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `rotation.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `rotation.metadata` | column | **Keep** | Live jsonb; table insert/select |
| `rotation.options` | column | **Keep** | Live jsonb; table insert/select |
| `rotation.organization_id` | column | **Keep** | Live column. `client/tls/changeover-lease.ts` |
| `rotation.from_ca_generation` | column | **Keep** | Live column. table insert/select |
| `rotation.to_ca_generation` | column | **Keep** | Live column. table insert/select |
| `rotation.state` | column | **Keep** | Live column. `client/tls/changeover-lease.ts` |
| `rotation.started_at` | column | **Keep** | Live column. `client/tls/changeover-lease.ts` |
| `rotation.completed_at` | column | **Keep** | Live column. table insert/select |
| `rotation.results` | column | **Keep** | Live column. `client/tls/changeover-fanout.ts` |
| `idx_rotation_organization_id` | index | **Rename** → `idx_changeover_organization_id` | Step 2 mechanical token substitution. |
| `uniq_rotation_inflight_organization` | uniqueIndex | **Rename** → `uniq_changeover_inflight_organization` | Step 2 mechanical token substitution. |
| `rotation_state_check` | check | **Rename** → `changeover_state_check` | Step 2 mechanical token substitution. |
| `rotation_organization_id_organization_id_fk` | fk | **Rename** → `changeover_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |

**5. `passkey`** (export `passkey` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `passkey.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `passkey.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `passkey.user_id` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.aaguid` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.name` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.public_key` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.credential_id` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.counter` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.device_type` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.is_backed_up` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `passkey.transports` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `idx_passkey_credential_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_passkey_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `passkey_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**6. `datacenter`** (export `datacenter` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `datacenter.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `datacenter.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `datacenter.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `datacenter.metadata` | column | **Keep** | Live jsonb; `client/datacenters/routes.ts` (+1) |
| `datacenter.options` | column | **Keep** | Live jsonb; `client/datacenters/routes.ts` (+3) |
| `datacenter.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `datacenter.name` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+1) |
| `datacenter.description` | column | **Keep** | Live column. `client/datacenters/routes.ts` |
| `idx_datacenter_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `datacenter_name_format_check` | check | **Drop** | Name-format CHECK contradicts app-side `display-name-format.ts`; column stays. |
| `datacenter_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**7. `server`** (export `server` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `server.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `server.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `server.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `server.metadata` | column | **Keep** | Live jsonb; `client/datacenters/routes.ts` (+3) |
| `server.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `server.organization_id` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.name` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.hostname` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.machine_key` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `server.os_id` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_family` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_version` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_codename` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_pretty_name` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.os_architecture` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.timezone` | column | **Keep** | Live column. `client/openapi/servers.ts` (+3) |
| `server.is_time_sync_enabled` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.ntp_servers` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.ntp_last_synced_at` | column | **Keep** | Live column. `daemon/cell/postgres-projection.ts` (+2) |
| `server.is_connected` | column | **Keep** | Live column. `client/managed/ha-recovery.ts` (+3) |
| `server.status_changed_at` | column | **Keep** | Live column. `client/servers/update-status.ts` (+3) |
| `server.daemon` | column | **Keep** | Live column. `daemon/authn/daemon-state.ts` (+3) |
| `idx_server_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_server_machine_key` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_server_hostname` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_server_connected` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `server_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**8. `license`** (export `license` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `license.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `license.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `license.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `license.organization_id` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `license.server_id` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `license.name` | column | **Keep** | Live column. `client/authn/install-state.ts` (+2) |
| `license.token` | column | **Keep** | Live column. `client/authn/install-state.ts` (+1) |
| `license.revoked_at` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `idx_license_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_license_server_id` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `license_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `license_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**9. `command`** (export `command` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `command.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `command.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `command.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `command.metadata` | column | **Keep** | Live jsonb; `lib/db/command-records.ts` |
| `command.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `command.server_id` | column | **Keep** | Live column. `daemon/execution-log-ingest.ts` (+3) |
| `command.actor_type` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.actor_id` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.name` | column | **Keep** | Live column. `lib/db/command-records.ts` (+2) |
| `command.status` | column | **Keep** | Live column. `daemon/execution-log-ingest.ts` (+3) |
| `command.attempts` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.context` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+3) |
| `command.result_summary` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.error_code` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.error_message` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.queued_at` | column | **Keep** | Live column. `lib/db/command-records.ts` (+2) |
| `command.dispatch_started_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.sent_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.acked_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `command.started_at` | column | **Keep** | Live column. `lib/db/command-records.ts` (+1) |
| `command.finished_at` | column | **Keep** | Live column. `lib/db/command-records.ts` (+2) |
| `command.expires_at` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `idx_command_server_id_created_at` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_command_status` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_command_deploy_environment_created` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `command_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**10. `dispatch`** (export `dispatch` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `dispatch.command_id` | column | **Keep** | Live column. `lib/db/command-records.ts` |
| `dispatch.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `dispatch.payload` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `dispatch.expires_at` | column | **Keep** | Live column. Written by `retainCommandDispatch`; sweep reads `expires_at` in `command-records.ts`. |
| `idx_dispatch_expires_at` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `dispatch_command_id_command_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**11. `network`** (export `network` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `network.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `network.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `network.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `network.metadata` | column | **Keep** | Live jsonb; `client/environments/validate-docker-external-networks.ts` (+1) |
| `network.options` | column | **Keep** | Live jsonb; `client/environments/validate-docker-external-networks.ts` (+2) |
| `network.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `network.datacenter_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `network.server_id` | column | **Keep** | Live column. `client/environments/validate-docker-external-networks.ts` (+2) |
| `network.environment_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `network.kind` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `network.cidr` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `network.name` | column | **Keep** | Live column. `client/networks/routes.ts` (+1) |
| `idx_network_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_network_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_network_datacenter_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_network_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_network_datacenter_cidr` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_single_scope_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_datacenter_id_datacenter_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `network_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**12. `fabric`** (export `fabric` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `fabric.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `fabric.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `fabric.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `fabric.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `fabric.options` | column | **Keep** | Live jsonb; `lib/db/fabric-records.ts` (+2) |
| `fabric.organization_id` | column | **Keep** | Live column. `lib/commands/consumer.ts` (+2) |
| `fabric.cidr` | column | **Keep** | Live column. `lib/db/fabric-records.ts` |
| `fabric.name` | column | **Keep** | Nullable display label; not populated by enable-fabric. |
| `idx_fabric_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_fabric_organization_id` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `fabric_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `fabric_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**13. `ip`** (export `ip` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `ip.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `ip.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ip.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ip.metadata` | column | **Keep** | Live jsonb; `client/ips/routes.ts` |
| `ip.options` | column | **Keep** | Live jsonb; `client/ips/routes.ts` |
| `ip.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `ip.datacenter_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `ip.network_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+2) |
| `ip.server_id` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `ip.address` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `ip.allocation` | column | **Keep** | Live column. `client/ips/routes.ts` |
| `ip.scope` | column | **Keep** | Live column. `client/datacenters/routes.ts` (+3) |
| `ip.description` | column | **Keep** | Live column. `client/ips/routes.ts` |
| `idx_ip_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_datacenter_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_network_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ip_scope_server_datacenter` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_ip_org_address` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_allocation_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_scope_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_scope_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_anchor_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_member_network_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_datacenter_id_datacenter_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_network_id_network_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ip_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**14. `relay`** (export `relay` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `relay.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `relay.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `relay.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `relay.metadata` | column | **Keep** | Live jsonb; `client/organizations/fabric-routes-helpers.ts` (+3) |
| `relay.options` | column | **Keep** | Live jsonb; `lib/db/fabric-records.ts` (+1) |
| `relay.fabric_id` | column | **Keep** | Live column. `lib/db/fabric-records.ts` (+1) |
| `relay.server_id` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+3) |
| `relay.address` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+2) |
| `relay.role` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+2) |
| `relay.keepalive` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.endpoint_address` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.public_key` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.prefix` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+1) |
| `relay.advertised_cidrs` | column | **Keep** | Live column. `client/organizations/fabric-routes-helpers.ts` (+2) |
| `relay.preshared_key` | column | **Keep** | Live column. `lib/db/fabric-records.ts` |
| `idx_relay_fabric_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_relay_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_fabric_server_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_relay_fabric_address` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_relay_fabric_public_key` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_role_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_keepalive_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_member_advertised_cidrs_empty_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_fabric_id_fabric_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `relay_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**15. `segment`** → `subnet` (export `subnet`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `segment.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `segment.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `segment.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `segment.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `segment.options` | column | **Keep** | Live jsonb; `lib/db/fabric-records.ts` |
| `segment.network_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `segment.server_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `segment.cidr` | column | **Keep** | Live column. `lib/db/fabric-records.ts` |
| `idx_segment_network_id` | index | **Rename** → `idx_subnet_network_id` | Step 2 mechanical token substitution. |
| `idx_segment_server_id` | index | **Rename** → `idx_subnet_server_id` | Step 2 mechanical token substitution. |
| `segment_network_server_unique` | unique | **Rename** → `subnet_network_server_unique` | Step 2 mechanical token substitution. |
| `segment_network_id_network_id_fk` | fk | **Rename** → `subnet_network_id_network_id_fk` | Step 2 mechanical token substitution. |
| `segment_server_id_server_id_fk` | fk | **Rename** → `subnet_server_id_server_id_fk` | Step 2 mechanical token substitution. |

**16. `workspace`** (export `workspace` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `workspace.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `workspace.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `workspace.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `workspace.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `workspace.name` | column | **Keep** | Live column. `client/display-name-uniqueness.ts` (+3) |
| `workspace.description` | column | **Keep** | Live column. `client/workspaces/routes.ts` |
| `workspace.kind` | column | **Keep** | Live column. `client/authz/workspace-kind-ancestry.ts` (+3) |
| `idx_workspace_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_workspace_organization_turbopanel` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `workspace_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `workspace_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `workspace_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**17. `project`** (export `project` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `project.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `project.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `project.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `project.metadata` | column | **Keep** | Live jsonb; `client/managed/context.ts` (+3) |
| `project.options` | column | **Keep** | Live jsonb; `client/bindings/resolve-endpoint.ts` (+3) |
| `project.workspace_id` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `project.name` | column | **Keep** | Live column. `client/display-name-uniqueness.ts` (+2) |
| `project.description` | column | **Keep** | Live column. `client/projects/routes.ts` |
| `idx_project_workspace_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_project_workspace_system_component` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `project_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `project_workspace_id_workspace_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**18. `environment`** (export `environment` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `environment.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `environment.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `environment.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `environment.metadata` | column | **Keep** | Live jsonb; `client/environments/routes.ts` (+1) |
| `environment.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `environment.project_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `environment.server_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `environment.generation` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `environment.name` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `environment.description` | column | **Keep** | Live column. `client/environments/routes.ts` (+1) |
| `idx_environment_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_environment_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `environment_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `environment_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `environment_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**19. `managed`** (export `managed` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `managed.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `managed.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `managed.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `managed.metadata` | column | **Keep** | Live jsonb; `client/managed/routes.ts` (+3) |
| `managed.options` | column | **Keep** | Live jsonb; `client/bindings/materialize.ts` (+3) |
| `managed.environment_id` | column | **Keep** | Live column. `client/bindings/routes-helpers.ts` (+3) |
| `managed.server_id` | column | **Keep** | Live column. `client/managed/routes.ts` (+1) |
| `managed.name` | column | **Keep** | Live column. `client/managed/routes.ts` |
| `managed.engine` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `managed.status` | column | **Keep** | Live column. `client/managed/apply-prepare.ts` (+3) |
| `idx_managed_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_managed_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_managed_engine` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_environment_id_unique` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_status_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `managed_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**20. `node`** → `replica` (export `replica`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `node.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `node.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `node.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `node.metadata` | column | **Keep** | Live jsonb; `client/managed/members.ts` (+1) |
| `node.options` | column | **Keep** | Live jsonb; `client/managed/members.ts` |
| `node.managed_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `node.server_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `node.role` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `node.replica_class` | column | **Keep** | Live column. `client/managed/ha-desired.ts` (+1) |
| `node.is_read_eligible` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+2) |
| `node.ordinal` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+2) |
| `node.replication_transport` | column | **Keep** | Live column. `client/managed/members.ts` |
| `node.private_port` | column | **Keep** | Live column. `client/managed/ingress-desired.ts` (+1) |
| `node.status` | column | **Keep** | Live column. `client/managed/members.ts` |
| `idx_node_managed_id` | index | **Rename** → `idx_replica_managed_id` | Step 2 mechanical token substitution. |
| `idx_node_server_id` | index | **Rename** → `idx_replica_server_id` | Step 2 mechanical token substitution. |
| `uniq_node_primary` | uniqueIndex | **Rename** → `uniq_replica_primary` | Step 2 mechanical token substitution. |
| `uniq_node_server_private_port` | uniqueIndex | **Rename** → `uniq_replica_server_private_port` | Step 2 mechanical token substitution. |
| `uniq_node_managed_ordinal` | unique | **Rename** → `uniq_replica_managed_ordinal` | Step 2 mechanical token substitution. |
| `uniq_node_managed_server` | unique | **Rename** → `uniq_replica_managed_server` | Step 2 mechanical token substitution. |
| `node_role_check` | check | **Rename** → `replica_role_check` | Step 2 mechanical token substitution. |
| `node_replica_class_check` | check | **Rename** → `replica_replica_class_check` | Step 2 mechanical token substitution. |
| `node_ordinal_positive_check` | check | **Rename** → `replica_ordinal_positive_check` | Step 2 mechanical token substitution. |
| `node_transport_check` | check | **Rename** → `replica_transport_check` | Step 2 mechanical token substitution. |
| `node_status_check` | check | **Rename** → `replica_status_check` | Step 2 mechanical token substitution. |
| `node_managed_id_managed_id_fk` | fk | **Rename** → `replica_managed_id_managed_id_fk` | Step 2 mechanical token substitution. |
| `node_server_id_server_id_fk` | fk | **Rename** → `replica_server_id_server_id_fk` | Step 2 mechanical token substitution. |

**21. `leaf`** (export `leaf` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `leaf.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `leaf.organization_id` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.server_id` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+1) |
| `leaf.kind` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` (+1) |
| `leaf.managed_id` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.node_id` | column | **Rename** → `leaf.replica_id` | Step 2 FK/column rename. |
| `leaf.ca_id` | column | **Keep** | Live column. Written by leaf upsert (`client/tls/leaf-tracking.ts`); renewal sweep keys other columns. |
| `leaf.ca_generation` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.not_after` | column | **Keep** | Live column. `client/tls/leaf-renewal-sweep.ts` |
| `leaf.issued_at` | column | **Keep** | Live column. Written on leaf upsert; not selected on the renewal path. |
| `idx_leaf_not_after` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_leaf_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_leaf_ingress_server` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_leaf_engine_node` | uniqueIndex | **Rename** → `uniq_leaf_engine_replica` | Step 2 mechanical token substitution. |
| `leaf_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_kind_keys_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_managed_id_managed_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `leaf_node_id_node_id_fk` | fk | **Rename** → `leaf_replica_id_replica_id_fk` | Step 2 mechanical token substitution. |
| `leaf_ca_id_tls_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**22. `recovery`** (export `recovery` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `recovery.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `recovery.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `recovery.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `recovery.metadata` | column | **Keep** | Live jsonb; `client/managed/ha-recovery.ts` |
| `recovery.options` | column | **Keep** | Live jsonb; table insert/select |
| `recovery.managed_id` | column | **Keep** | Live column. `client/managed/ha-recovery.ts` (+1) |
| `recovery.kind` | column | **Keep** | Live column. table insert/select |
| `recovery.source_primary_member_id` | column | **Keep** | Live column. table insert/select |
| `recovery.target_member_id` | column | **Keep** | Live column. table insert/select |
| `recovery.state` | column | **Keep** | Live column. `lib/db/recovery-records.ts` |
| `recovery.started_at` | column | **Keep** | Live column. `lib/db/recovery-records.ts` |
| `recovery.completed_at` | column | **Keep** | Live column. table insert/select |
| `idx_recovery_managed_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_recovery_inflight_managed` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `recovery_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `recovery_state_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `recovery_managed_id_managed_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**23. `variable`** (export `variable` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `variable.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `variable.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `variable.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `variable.organization_id` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `variable.workspace_id` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `variable.project_id` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `variable.environment_id` | column | **Keep** | Live column. `client/projects/empty-setup.ts` (+1) |
| `variable.service_id` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.hosting_id` | column | **Keep** | Live column. `client/bindings/routes-helpers.ts` (+1) |
| `variable.server_id` | column | **Keep** | Live column. `client/variables/resolve-inherited.ts` (+1) |
| `variable.binding_id` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `variable.key` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `variable.value` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `variable.is_secret` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `variable.is_literal` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.is_for_build` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.is_for_runtime` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `variable.description` | column | **Keep** | Live column. `client/variables/routes.ts` |
| `idx_variable_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_workspace_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_hosting_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_variable_binding_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_org` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_workspace` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_project` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_environment` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_service` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_hosting` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_var_server` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_exactly_one_parent_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_key_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_workspace_id_workspace_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_hosting_id_hosting_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `variable_binding_id_binding_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**24. `service`** (export `service` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `service.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `service.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `service.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `service.metadata` | column | **Keep** | Live jsonb; `client/services/routes.ts` |
| `service.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `service.environment_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `service.name` | column | **Keep** | Live column. `client/bindings/impact.ts` (+1) |
| `service.description` | column | **Keep** | Live column. `client/services/routes.ts` |
| `service.compose_service_name` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `idx_service_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_service_environment_compose_name` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `service_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `service_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**25. `deployment`** (export `deployment` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `deployment.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `deployment.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `deployment.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `deployment.metadata` | column | **Keep** | Live jsonb; `lib/db/deployment-records.ts` |
| `deployment.options` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+1) |
| `deployment.environment_id` | column | **Keep** | Live column. `client/environments/site-releases.ts` (+3) |
| `deployment.server_id` | column | **Keep** | Live column. `daemon/rehydrate-secrets.ts` (+2) |
| `deployment.desired_generation` | column | **Keep** | Live column. `lib/db/deployment-history.ts` |
| `deployment.applied_generation` | column | **Keep** | Live column. `lib/db/deployment-history.ts` |
| `deployment.desired_hash` | column | **Keep** | Live column. table insert/select |
| `deployment.status` | column | **Keep** | Live column. `lib/commands/consumer.ts` (+2) |
| `deployment.last_command_id` | column | **Keep** | Live column. table insert/select |
| `deployment.finished_at` | column | **Keep** | Live column. table insert/select |
| `deployment.duration_ms` | column | **Keep** | Live column. table insert/select |
| `deployment.outcome` | column | **Keep** | Live column. table insert/select |
| `idx_deployment_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_deployment_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_deployment_environment_server` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_status_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_generation_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_outcome_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `deployment_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**26. `task`** → `slot` (export `slot`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `task.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `task.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `task.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `task.metadata` | column | **Keep** | Live jsonb; table insert/select |
| `task.options` | column | **Keep** | Live jsonb; table insert/select |
| `task.environment_id` | column | **Keep** | Live column. `client/managed/ingress-attachments.ts` (+1) |
| `task.service_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `task.server_id` | column | **Keep** | Live column. `client/bindings/resolve-endpoint.ts` (+3) |
| `task.address` | column | **Keep** | Live column. `lib/schedule/slot-addresses.ts` |
| `task.slot` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `task.generation` | column | **Keep** | Live column. `lib/db/slot-records.ts` |
| `task.desired_state` | column | **Keep** | Live column. table insert/select |
| `idx_task_environment_generation` | index | **Rename** → `idx_slot_environment_generation` | Step 2 mechanical token substitution. |
| `idx_task_server_id` | index | **Rename** → `idx_slot_server_id` | Step 2 mechanical token substitution. |
| `uniq_task_service_slot` | unique | **Rename** → `uniq_slot_service_slot` | Step 2 mechanical token substitution. |
| `task_slot_nonnegative_check` | check | **Rename** → `slot_slot_nonnegative_check` | Step 2 mechanical token substitution. |
| `task_desired_state_check` | check | **Rename** → `slot_desired_state_check` | Step 2 mechanical token substitution. |
| `task_environment_id_environment_id_fk` | fk | **Rename** → `slot_environment_id_environment_id_fk` | Step 2 mechanical token substitution. |
| `task_service_id_service_id_fk` | fk | **Rename** → `slot_service_id_service_id_fk` | Step 2 mechanical token substitution. |
| `task_server_id_server_id_fk` | fk | **Rename** → `slot_server_id_server_id_fk` | Step 2 mechanical token substitution. |

**27. `label`** (export `label` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `label.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `label.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `label.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `label.server_id` | column | **Keep** | Live column. `lib/db/label-records.ts` |
| `label.key` | column | **Keep** | Live column. `lib/db/label-records.ts` (+1) |
| `label.value` | column | **Keep** | Live column. `lib/schedule/plan-deploy.ts` |
| `idx_label_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_label_server_key` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `label_key_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `label_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**28. `hosting`** (export `hosting` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `hosting.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `hosting.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `hosting.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `hosting.metadata` | column | **Keep** | Live jsonb; `client/hostings/routes.ts` |
| `hosting.options` | column | **Keep** | Live jsonb; `client/environments/deploy-routes.ts` (+3) |
| `hosting.service_id` | column | **Keep** | Live column. `client/bindings/routes-helpers.ts` (+3) |
| `hosting.tls_id` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `hosting.ip_id` | column | **Keep** | Live column. `client/environments/deploy-routes.ts` (+2) |
| `hosting.name` | column | **Keep** | Live column. `client/hostings/routes.ts` |
| `hosting.description` | column | **Keep** | Live column. `client/hostings/routes.ts` |
| `idx_hosting_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_hosting_tls_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_hosting_ip_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `hosting_name_format_check` | check | **Drop** | Name-format CHECK contradicts app-side `display-name-format.ts`; column stays. |
| `hosting_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `hosting_tls_id_tls_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `hosting_ip_id_ip_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**29. `container`** (export `container` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `container.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `container.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `container.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `container.metadata` | column | **Keep** | Live jsonb; `client/containers/routes.ts` (+1) |
| `container.options` | column | **Keep** | Live jsonb; `client/containers/routes.ts` (+1) |
| `container.service_id` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.server_id` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.container_id` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.container_name` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.status` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.role` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.compose_service_name` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `container.ordinal` | column | **Keep** | Live column. `client/containers/routes.ts` (+3) |
| `idx_container_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_container_server_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_container_status` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_container_server_container_id` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_container_service_role_ordinal` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_ordinal_positive_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_role_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `container_server_id_server_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**30. `principal`** (export `principal` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `principal.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `principal.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `principal.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `principal.metadata` | column | **Keep** | Live jsonb; `client/bindings/routes.ts` (+3) |
| `principal.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `principal.kind` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `principal.provider` | column | **Keep** | Live column. `client/managed/routes.ts` (+3) |
| `principal.username` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+3) |
| `principal.password` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `principal.project_id` | column | **Keep** | Live column. `client/principals/reconcile.ts` (+3) |
| `principal.managed_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `idx_principal_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_principal_managed_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_provider_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_username_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `principal_managed_id_managed_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**31. `entitlement`** (export `entitlement` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `entitlement.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `entitlement.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `entitlement.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `entitlement.principal_id` | column | **Keep** | Live column. `client/principals/store.ts` |
| `entitlement.runtime` | column | **Keep** | Live column. `client/principals/store.ts` |
| `entitlement.series` | column | **Keep** | Live column. `client/principals/store.ts` |
| `entitlement.granted_by` | column | **Keep** | Live column. `client/principals/store.ts` |
| `idx_entitlement_principal_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_runtime_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_series_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_granted_by_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `entitlement_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**32. `ssh`** (export `sshKey` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `ssh.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `ssh.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ssh.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `ssh.principal_id` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.name` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.key_type` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.public_key` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.fingerprint` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.comment` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `ssh.user_id` | column | **Keep** | Live column. Written as provenance on insert (`ssh-keys.ts`); not selected on list. |
| `ssh.bits` | column | **Keep** | Live column. `client/principals/ssh-keys.ts` |
| `idx_ssh_principal_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_ssh_fingerprint` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_fingerprint_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_type_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_fingerprint_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_public_key_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_name_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `ssh_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**33. `steward`** → `tenancy` (export `tenancy`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `steward.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `steward.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `steward.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `steward.principal_id` | column | **Keep** | Live column. `client/principals/tenancies.ts` (+1) |
| `steward.service_id` | column | **Keep** | Live column. `client/principals/tenancies.ts` (+1) |
| `idx_steward_principal_id` | index | **Rename** → `idx_tenancy_principal_id` | Step 2 mechanical token substitution. |
| `idx_steward_service_id` | index | **Rename** → `idx_tenancy_service_id` | Step 2 mechanical token substitution. |
| `steward_principal_service_unique` | unique | **Rename** → `tenancy_principal_service_unique` | Step 2 mechanical token substitution. |
| `steward_principal_id_principal_id_fk` | fk | **Rename** → `tenancy_principal_id_principal_id_fk` | Step 2 mechanical token substitution. |
| `steward_service_id_service_id_fk` | fk | **Rename** → `tenancy_service_id_service_id_fk` | Step 2 mechanical token substitution. |

**34. `binding`** (export `binding` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `binding.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `binding.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `binding.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `binding.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `binding.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `binding.principal_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `binding.service_id` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `binding.database_name` | column | **Keep** | Live column. `client/bindings/impact.ts` (+2) |
| `binding.key_prefix` | column | **Keep** | Live column. `client/bindings/impact.ts` (+3) |
| `binding.is_emit_engine_defaults` | column | **Keep** | Live column. `client/bindings/materialize.ts` (+2) |
| `idx_binding_principal_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_binding_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_binding_service_engine_defaults` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_binding_service_prefix` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_key_prefix_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_database_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `binding_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**35. `credential`** → `secret` (export `secret`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `credential.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `credential.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `credential.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `credential.metadata` | column | **Keep** | Live jsonb; Written on deploy-key create (`publicKey` / fingerprint jsonb). |
| `credential.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `credential.organization_id` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `credential.principal_id` | column | **Keep** | Optional FK reserved for principal-owned secrets; unused today. |
| `credential.provider` | column | **Keep** | Live column. `client/repositories/routes-helpers.ts` (+1) |
| `credential.name` | column | **Keep** | Live column. Written on deploy-key create (`client/repositories/routes.ts` insert); not later selected qualified. |
| `credential.secret_envelope` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+1) |
| `credential.expires_at` | column | **Drop** | No table-qualified reader or writer; would have become `secret.expires_at`. |
| `idx_credential_organization_id` | index | **Rename** → `idx_secret_organization_id` | Step 2 mechanical token substitution. |
| `idx_credential_principal_id` | index | **Rename** → `idx_secret_principal_id` | Step 2 mechanical token substitution. |
| `credential_provider_check` | check | **Rename** → `secret_provider_check` | Step 2 mechanical token substitution. |
| `credential_organization_id_organization_id_fk` | fk | **Rename** → `secret_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |
| `credential_principal_id_principal_id_fk` | fk | **Rename** → `secret_principal_id_principal_id_fk` | Step 2 mechanical token substitution. |

**36. `storage`** (export `storage` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `storage.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `storage.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `storage.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `storage.metadata` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+3) |
| `storage.options` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `storage.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `storage.workspace_id` | column | **Keep** | Live column. `client/storage/routes.ts` (+1) |
| `storage.project_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `storage.environment_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `storage.service_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `storage.kind` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `storage.name` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `storage.access_mode` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `storage.retention` | column | **Keep** | Live column. `client/storage/routes.ts` (+1) |
| `storage.generation` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `storage.principal_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `storage.content_envelope` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+1) |
| `idx_storage_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_workspace_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_project_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_environment_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_storage_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_storage_environment_compose_volume_key` | uniqueIndex | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_kind_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_access_mode_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_retention_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_at_most_one_parent_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_workspace_id_workspace_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_project_id_project_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_environment_id_environment_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `storage_principal_id_principal_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**37. `location`** → `copy` (export `storageCopy`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `location.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `location.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `location.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `location.metadata` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `location.options` | column | **Keep** | Live jsonb; `client/environments/deploy-prepare.ts` (+1) |
| `location.storage_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `location.server_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `location.credential_id` | column | **Rename** → `copy.secret_id` | Step 2 FK/column rename. |
| `location.provider` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `location.role` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `location.state` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `location.path` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `location.endpoint` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `location.generation` | column | **Keep** | Live column. `client/storage/routes.ts` |
| `idx_location_storage_id` | index | **Rename** → `idx_copy_storage_id` | Step 2 mechanical token substitution. |
| `idx_location_server_id` | index | **Rename** → `idx_copy_server_id` | Step 2 mechanical token substitution. |
| `idx_location_credential_id` | index | **Rename** → `idx_copy_secret_id` | Step 2 mechanical token substitution. |
| `uniq_location_storage_primary` | uniqueIndex | **Rename** → `uniq_copy_storage_primary` | Step 2 mechanical token substitution. |
| `uniq_location_storage_server_provider` | uniqueIndex | **Rename** → `uniq_copy_storage_server_provider` | Step 2 mechanical token substitution. |
| `location_provider_check` | check | **Rename** → `copy_provider_check` | Step 2 mechanical token substitution. |
| `location_role_check` | check | **Rename** → `copy_role_check` | Step 2 mechanical token substitution. |
| `location_state_check` | check | **Rename** → `copy_state_check` | Step 2 mechanical token substitution. |
| `location_storage_id_storage_id_fk` | fk | **Rename** → `copy_storage_id_storage_id_fk` | Step 2 mechanical token substitution. |
| `location_server_id_server_id_fk` | fk | **Rename** → `copy_server_id_server_id_fk` | Step 2 mechanical token substitution. |
| `location_credential_id_credential_id_fk` | fk | **Rename** → `copy_secret_id_secret_id_fk` | Step 2 mechanical token substitution. |

**38. `mount`** (export `mount` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `mount.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `mount.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `mount.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `mount.metadata` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `mount.options` | column | **Keep** | Live jsonb; `client/storage/routes.ts` |
| `mount.storage_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `mount.service_id` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+3) |
| `mount.destination_path` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `mount.subpath` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+2) |
| `mount.is_read_only` | column | **Keep** | Live column. `client/environments/deploy-prepare.ts` (+1) |
| `idx_mount_storage_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_mount_service_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_mount_service_destination` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `mount_storage_id_storage_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `mount_service_id_service_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**39. `gitapp`** → `forge` (export `forge`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `gitapp.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `gitapp.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `gitapp.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `gitapp.metadata` | column | **Keep** | Live jsonb; table insert/select |
| `gitapp.options` | column | **Keep** | Live jsonb; table insert/select |
| `gitapp.organization_id` | column | **Keep** | Live column. `client/forges/handlers.ts` (+1) |
| `gitapp.provider` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `gitapp.name` | column | **Keep** | Live column. table insert/select |
| `gitapp.base_url` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `gitapp.api_url` | column | **Keep** | Live column. table insert/select |
| `gitapp.external_app_id` | column | **Keep** | Live column. `lib/git/forge-records.ts` |
| `gitapp.app_slug` | column | **Keep** | Live column. table insert/select |
| `gitapp.client_id` | column | **Keep** | Live column. table insert/select |
| `gitapp.redirect_uri` | column | **Keep** | Live column. table insert/select |
| `gitapp.webhook_origin` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `gitapp.is_public` | column | **Keep** | Live column. table insert/select |
| `gitapp.custom_git_user` | column | **Keep** | Live column. table insert/select |
| `gitapp.custom_git_port` | column | **Keep** | Live column. table insert/select |
| `gitapp.synced_at` | column | **Keep** | Live column. table insert/select |
| `gitapp.credentials` | column | **Rename** → `forge.envelopes` | Step 2 FK/column rename. |
| `forge.webhook_ref` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `gitapp.webhook_token_hash` | column | **Keep** | Live column. `lib/git/forge-records.ts` |
| `idx_gitapp_organization_id` | index | **Rename** → `idx_forge_organization_id` | Step 2 mechanical token substitution. |
| `idx_gitapp_provider` | index | **Rename** → `idx_forge_provider` | Step 2 mechanical token substitution. |
| `uniq_gitapp_webhook_ref` | unique | **Rename** → `uniq_forge_webhook_ref` | Step 2 mechanical token substitution. |
| `uniq_gitapp_provider_base_external` | unique | **Rename** → `uniq_forge_provider_base_external` | Step 2 mechanical token substitution. |
| `uniq_gitapp_webhook_token_hash` | unique | **Rename** → `uniq_forge_webhook_token_hash` | Step 2 mechanical token substitution. |
| `gitapp_provider_check` | check | **Rename** → `forge_provider_check` | Step 2 mechanical token substitution. |
| `gitapp_organization_id_organization_id_fk` | fk | **Rename** → `forge_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |

**40. `installation`** → `connection` (export `gitConnection`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `installation.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `installation.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `installation.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `installation.metadata` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` |
| `installation.options` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` |
| `installation.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+1) |
| `installation.app_id` | column | **Rename** → `connection.forge_id` | Step 2 FK/column rename. |
| `installation.provider` | column | **Keep** | Live column. `client/repositories/routes.ts` (+3) |
| `installation.external_installation_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+2) |
| `installation.account_login` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `installation.account_type` | column | **Keep** | Live column. `client/repositories/routes.ts` |
| `installation.suspended_at` | column | **Keep** | Live column. `client/repositories/routes.ts` (+3) |
| `installation.oauth_envelope` | column | **Keep** | Live column. `lib/git/gitlab-oauth-token.ts` |
| `idx_installation_organization_id` | index | **Rename** → `idx_connection_organization_id` | Step 2 mechanical token substitution. |
| `idx_installation_app_id` | index | **Rename** → `idx_connection_forge_id` | Step 2 mechanical token substitution. |
| `uniq_installation_organization_app_external` | unique | **Rename** → `uniq_connection_organization_forge_external` | Step 2 mechanical token substitution. |
| `installation_provider_check` | check | **Rename** → `connection_provider_check` | Step 2 mechanical token substitution. |
| `installation_organization_id_organization_id_fk` | fk | **Rename** → `connection_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |
| `installation_app_id_gitapp_id_fk` | fk | **Rename** → `connection_forge_id_forge_id_fk` | Step 2 mechanical token substitution. |

**41. `source`** → `repository` (export `repository`)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `source.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `source.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `source.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `source.metadata` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` |
| `source.options` | column | **Keep** | Live jsonb; `client/repositories/routes.ts` (+1) |
| `source.organization_id` | column | **Keep** | Live column. `client/authz/create-access-grant.ts` (+3) |
| `source.installation_id` | column | **Rename** → `repository.connection_id` | Step 2 FK/column rename. |
| `source.service_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `source.environment_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `source.credential_id` | column | **Rename** → `repository.secret_id` | Step 2 FK/column rename. |
| `source.provider` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+2) |
| `source.repository_url` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+1) |
| `source.repository_external_id` | column | **Keep** | Live column. `client/repositories/routes.ts` (+2) |
| `source.default_branch` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+3) |
| `source.subdirectory` | column | **Keep** | Live column. `client/environments/deploy-sources.ts` (+2) |
| `source.auto_deploy` | column | **Keep** | Live column. `client/repositories/routes.ts` (+1) |
| `idx_source_organization_id` | index | **Rename** → `idx_repository_organization_id` | Step 2 mechanical token substitution. |
| `idx_source_installation_id` | index | **Rename** → `idx_repository_connection_id` | Step 2 mechanical token substitution. |
| `idx_source_service_id` | index | **Rename** → `idx_repository_service_id` | Step 2 mechanical token substitution. |
| `idx_source_environment_id` | index | **Rename** → `idx_repository_environment_id` | Step 2 mechanical token substitution. |
| `idx_source_credential_id` | index | **Rename** → `idx_repository_secret_id` | Step 2 mechanical token substitution. |
| `uniq_source_organization_installation_repository` | unique | **Rename** → `uniq_repository_organization_connection_repository` | Step 2 mechanical token substitution. |
| `source_provider_check` | check | **Rename** → `repository_provider_check` | Step 2 mechanical token substitution. |
| `source_auto_deploy_check` | check | **Rename** → `repository_auto_deploy_check` | Step 2 mechanical token substitution. |
| `source_at_most_one_parent_check` | check | **Rename** → `repository_at_most_one_parent_check` | Step 2 mechanical token substitution. |
| `source_organization_id_organization_id_fk` | fk | **Rename** → `repository_organization_id_organization_id_fk` | Step 2 mechanical token substitution. |
| `source_installation_id_installation_id_fk` | fk | **Rename** → `repository_connection_id_connection_id_fk` | Step 2 mechanical token substitution. |
| `source_service_id_service_id_fk` | fk | **Rename** → `repository_service_id_service_id_fk` | Step 2 mechanical token substitution. |
| `source_environment_id_environment_id_fk` | fk | **Rename** → `repository_environment_id_environment_id_fk` | Step 2 mechanical token substitution. |
| `source_credential_id_credential_id_fk` | fk | **Rename** → `repository_secret_id_secret_id_fk` | Step 2 mechanical token substitution. |

**42. `delivery`** (export `webhookDelivery` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `delivery.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `delivery.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `delivery.provider` | column | **Keep** | Live column. `lib/db/webhook-delivery-records.ts` |
| `delivery.external_delivery_id` | column | **Keep** | Live column. `lib/db/webhook-delivery-records.ts` |
| `delivery.event` | column | **Keep** | Live column. Written on claim insert; not selected after. |
| `idx_delivery_created_at` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `uniq_delivery_provider_external` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `delivery_provider_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**43. `grant`** (export `grant` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `grant.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `grant.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `grant.actor_type` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.actor_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.entity_type` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.entity_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `grant.permission` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `idx_grant_entity` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_grant_actor` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `grant_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**44. `session`** (export `session` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `session.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `session.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `session.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `session.user_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `session.expires_at` | column | **Keep** | Live column. `client/authn/session-store.ts` |
| `session.token` | column | **Keep** | Live column. `client/authn/session-store.ts` |
| `session.ip_address` | column | **Keep** | Live column. Written by `createSession` (`session-store.ts`); login lookup does not select it. |
| `session.user_agent` | column | **Keep** | Live column. Written by `createSession`; login lookup does not select it. |
| `idx_session_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `session_token_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `session_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**45. `setting`** (export `setting` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `setting.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `setting.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `setting.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `setting.key` | column | **Keep** | Live column. `admin/public-urls.ts` (+3) |
| `setting.value` | column | **Keep** | Live column. `admin/reencrypt-secrets.ts` (+3) |
| `setting_key_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**46. `account`** (export `account` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `account.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `account.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `account.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `account.user_id` | column | **Keep** | Live column. `client/authn/credentials.ts` (+2) |
| `account.provider_id` | column | **Keep** | Live column. `client/authn/credentials.ts` (+1) |
| `account.provider_user_id` | column | **Keep** | Live column. Written on credential-account insert (`install-state.ts`, `http.ts`); not later selected. |
| `account.access_token` | column | **Keep** | Better Auth OAuth leftover; credential accounts unused. |
| `account.refresh_token` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.id_token` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.access_token_expires_at` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.refresh_token_expires_at` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.scope` | column | **Keep** | Better Auth OAuth leftover; unused. |
| `account.password` | column | **Keep** | Live column. `client/authn/credentials.ts` |
| `idx_account_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `account_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**47. `teammate`** (export `teammate` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `teammate.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `teammate.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `teammate.team_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `teammate.user_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `idx_teammate_team_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `idx_teammate_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `teammate_team_user_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `teammate_team_id_team_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `teammate_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**48. `team`** (export `team` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `team.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `team.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `team.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `team.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `team.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `team.organization_id` | column | **Keep** | Live column. `client/access/routes.ts` (+3) |
| `team.name` | column | **Keep** | Live column. `client/teams/routes.ts` |
| `idx_team_organization_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `team_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `team_organization_id_organization_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**49. `user`** (export `user` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `user.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `user.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `user.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `user.metadata` | column | **Keep** | metadata/options pairing rule; unused today. |
| `user.options` | column | **Keep** | metadata/options pairing rule; unused today. |
| `user.name` | column | **Keep** | Email-only identity; column kept for Better Auth compat. |
| `user.email` | column | **Keep** | Live column. `client/authn/credentials.ts` (+3) |
| `user.is_email_verified` | column | **Keep** | Live column. `client/authn/credentials.ts` (+2) |
| `user.is_2fa_enabled` | column | **Keep** | Reserved until 2FA ships; `2fa` table also unused. |
| `user.is_disabled` | column | **Keep** | Live column. `client/authn/credentials.ts` (+2) |
| `user.role` | column | **Keep** | Live column. `client/authn/install-state.ts` (+3) |
| `user_email_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `user_name_format_check` | check | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**50. `2fa`** (export `twoFactor` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `2fa.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `2fa.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `2fa.user_id` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `2fa.secret` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `2fa.is_verified` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `2fa.backup_codes` | column | **Keep** | Better Auth–compat reserved; no first-party usage. |
| `idx_2fa_user_id` | index | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |
| `2fa_user_id_user_id_fk` | fk | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

**51. `verification`** (export `verification` unchanged)

| Item | Kind | Decision | Reason |
| --- | --- | --- | --- |
| `verification.id` | column | **Keep** | Primary key; identity for every FK and API id. |
| `verification.created_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `verification.updated_at` | column | **Keep** | Lifecycle timestamp; written by defaultNow even when not selected. |
| `verification.expires_at` | column | **Keep** | Live column. `client/authn/email-otp.ts` (+1) |
| `verification.identifier` | column | **Keep** | Live column. `client/authn/email-otp.ts` (+1) |
| `verification.value` | column | **Keep** | Live column. `client/authn/email-otp.ts` (+1) |
| `verification_identifier_unique` | unique | **Keep** | Unchanged; not in the Step 2 rename list or the DDL delta. |

