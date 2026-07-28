CREATE UNIQUE INDEX "uniq_storage_environment_compose_volume_key" ON "storage" USING btree ("environment_id" uuid_ops,("metadata" ->> 'composeVolumeKey')) WHERE kind = 'docker_volume'
          AND environment_id IS NOT NULL
          AND COALESCE(metadata->>'composeVolumeKey', '') <> '';