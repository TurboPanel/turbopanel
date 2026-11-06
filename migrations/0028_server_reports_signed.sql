ALTER TABLE "server" ADD COLUMN "trust_reports_signed_at" timestamp(3) with time zone;--> statement-breakpoint
COMMENT ON COLUMN "server"."trust_reports_signed_at" IS 'When a signed daemon report from this server first verified; set once, and from then on its unsigned reports on a signed session are refused.';
