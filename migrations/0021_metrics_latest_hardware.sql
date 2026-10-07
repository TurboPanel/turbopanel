-- breaking-ok: only the throwaway testing and canary servers exist; a previous Worker still writing topology history during the deploy just logs and the daemon resends after the resync marker
CREATE TABLE "hardware" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"boot_generation" integer NOT NULL,
	"snapshot" jsonb,
	"applied_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "hardware" ("server_id", "generation", "boot_generation", "snapshot", "applied_at")
SELECT DISTINCT ON ("server_id") "server_id", "generation", "boot_generation", "snapshot", "applied_at"
FROM "generation"
ORDER BY "server_id", "created_at" DESC, "id" DESC;--> statement-breakpoint
DROP TABLE "generation" CASCADE;--> statement-breakpoint
ALTER TABLE "hardware" ADD CONSTRAINT "hardware_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hardware_server_id" ON "hardware" USING btree ("server_id");--> statement-breakpoint
COMMENT ON TABLE "hardware" IS 'The latest hardware facts a server''s daemon reported in `topology-report`; one row per server, overwritten in place at most every 5 minutes, no history.';--> statement-breakpoint
COMMENT ON COLUMN "hardware"."generation" IS 'Daemon-maintained topology generation counter, bumped only when the enumerated NIC, GPU, filesystem, disk or signal identity set or slot mapping changes.';--> statement-breakpoint
COMMENT ON COLUMN "hardware"."boot_generation" IS 'Daemon boot counter, incremented when `/proc/sys/kernel/random/boot_id` differs from the value persisted in its state directory; sent with the snapshot.';--> statement-breakpoint
COMMENT ON COLUMN "hardware"."snapshot" IS 'Full daemon-reported topology object stored verbatim: networks, filesystems, blockDevices, gpus, hardwareSignals, cpu, numaNodes, capacities, machineClass.';--> statement-breakpoint
COMMENT ON COLUMN "hardware"."applied_at" IS 'Daemon''s own report timestamp (`topology-report.at`) for the stored facts, never the control-plane receipt time.';
