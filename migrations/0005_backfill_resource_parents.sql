INSERT INTO "resource" ("kind", "item_id", "organization_id", "parent_id")
SELECT 'organization', o.id, o.id, NULL
FROM "organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "resource" r
  WHERE r.kind = 'organization' AND r.item_id = o.id
);
--> statement-breakpoint
UPDATE "resource" AS s
SET "parent_id" = o.id, "updated_at" = now()
FROM "resource" AS o
WHERE s.kind = 'server'
  AND (s.parent_id IS NULL OR s.parent_id IS DISTINCT FROM o.id)
  AND o.kind = 'organization'
  AND o.item_id = s.organization_id;
