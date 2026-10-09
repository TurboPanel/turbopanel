# Backups

Artifacts are files on the host that made them. `backup.server_id` records that
host (the primary at run time). A restore after a switchover cannot fetch the
file from the new primary: when `server_id` is set and differs from
`managed.server_id`, `POST …/backups/:id/restore` answers **409**
`backup_on_other_server` and does not flip status or enqueue. Delete is
dispatched to the stored host when known (and still answers `server_offline`
when that host is down). Older rows with null `server_id` keep the previous
behaviour (current primary).
