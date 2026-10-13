ALTER TABLE "command" ADD COLUMN "progress" jsonb;--> statement-breakpoint
COMMENT ON COLUMN "command"."progress" IS 'Latest command-progress payload from the daemon (CommandProgress in src/contracts/cell-protocol.ts): the step plan and where it stands. NULL until reported; finalised on the terminal transition.';
