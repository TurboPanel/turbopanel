ALTER TABLE "folder" ADD COLUMN "removal_note" text;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_removal_note_check" CHECK (removal_note IS NULL OR char_length(removal_note) <= 300);--> statement-breakpoint
COMMENT ON COLUMN "folder"."removal_note" IS 'Why the host kept a `removing` folder, in plain words, from its last answer; NULL when it has not refused.';
