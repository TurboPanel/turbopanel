-- One name pool per organization across system users and database logins
-- (owner decision 2026-10-13). Before the unique indexes go on, surface any
-- row pair that already breaks the rule. Nothing here changes data: a
-- duplicate stops the migration with the offending rows listed, and an
-- operator picks which row changes (see the HINT) before running it again.
--
-- Pool rows are every principal except a managed cluster's root and
-- replication logins (metadata.managedRoot / metadata.managedReplication),
-- the same predicate the two indexes below carry.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(
    format('organization %s: %s %L held by principals %s',
      organization_id, namespace, name, ids),
    E'\n' ORDER BY organization_id, namespace, name)
  INTO offenders
  FROM (
    SELECT organization_id, namespace, name, string_agg(id::text, ', ' ORDER BY id) AS ids
    FROM (
      SELECT id, organization_id, 'username' AS namespace, lower(username) AS name
      FROM principal
      WHERE coalesce(metadata ->> 'managedRoot', '') <> 'true'
        AND coalesce(metadata ->> 'managedReplication', '') <> 'true'
      UNION ALL
      SELECT id, organization_id, 'applied_username' AS namespace, lower(applied_username) AS name
      FROM principal
      WHERE coalesce(metadata ->> 'managedRoot', '') <> 'true'
        AND coalesce(metadata ->> 'managedReplication', '') <> 'true'
    ) pool
    GROUP BY organization_id, namespace, name
    HAVING count(*) > 1
  ) dup;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'principal names are not unique per organization; the migration changes no data'
      USING DETAIL = offenders,
            HINT = 'Give one row of each pair a different username / applied_username (an operator decision, never automatic), then run the migration again.';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_username" ON "principal" USING btree ("organization_id",lower("username")) WHERE coalesce(metadata ->> 'managedRoot', '') <> 'true' AND coalesce(metadata ->> 'managedReplication', '') <> 'true';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_applied_username" ON "principal" USING btree ("organization_id",lower("applied_username")) WHERE coalesce(metadata ->> 'managedRoot', '') <> 'true' AND coalesce(metadata ->> 'managedReplication', '') <> 'true';