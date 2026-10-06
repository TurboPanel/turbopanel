ALTER TABLE "entitlement" DROP CONSTRAINT "entitlement_runtime_check";--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_runtime_check" CHECK ("entitlement"."runtime" IN ('php', 'node', 'deno'));--> statement-breakpoint
COMMENT ON COLUMN "entitlement"."runtime" IS 'Runtime family the grant covers, `php`, `node` or `deno` (CHECK `entitlement_runtime_check`).';
