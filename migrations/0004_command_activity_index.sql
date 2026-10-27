-- The organization Activity feed lists every deploy, restart and stop, not
-- only the running and failed ones. Additive only: one partial index (on the
-- command name, newest first per organization) so the page and its count stay
-- an index walk. The previous release never reads it; idx_command_feed stays.
CREATE INDEX "idx_command_activity" ON "command" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" IN ('environment.deploy', 'environment.lifecycle', 'environment.stop');