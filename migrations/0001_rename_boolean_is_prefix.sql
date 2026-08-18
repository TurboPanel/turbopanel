ALTER TABLE "server" RENAME COLUMN "connected" TO "is_connected";--> statement-breakpoint
ALTER TABLE "node" RENAME COLUMN "read_eligible" TO "is_read_eligible";--> statement-breakpoint
ALTER TABLE "variable" RENAME COLUMN "for_build" TO "is_for_build";--> statement-breakpoint
ALTER TABLE "variable" RENAME COLUMN "for_runtime" TO "is_for_runtime";--> statement-breakpoint
ALTER TABLE "binding" RENAME COLUMN "emit_engine_defaults" TO "is_emit_engine_defaults";--> statement-breakpoint
ALTER TABLE "mount" RENAME COLUMN "read_only" TO "is_read_only";
