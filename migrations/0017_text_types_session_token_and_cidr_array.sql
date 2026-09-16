ALTER TABLE "relay" DROP CONSTRAINT "relay_member_advertised_cidrs_empty_check";--> statement-breakpoint
-- Hand-corrected from drizzle-kit's emission for this one statement, and only
-- this one: drizzle-kit 0.31 prints an array-of-builtin type change as
-- "undefined"."cidr"[] (a known array-alter emission bug; the snapshot
-- records the correct cidr[]), and it cannot express the USING clause a
-- jsonb -> cidr[] conversion needs. USING may not contain a subquery, so the
-- jsonb array text ("[\"a\",\"b\"]") is rewritten to an array literal ({a,b})
-- by character translation — CIDR strings never contain [ ] or " — which is
-- data-preserving for any rows that exist; every database is disposable
-- pre-tag regardless. The old jsonb DEFAULT has to go first — Postgres
-- refuses to retype a column whose default cannot be cast to the new type —
-- and the new '{}'::cidr[] default is set right after, as generated.
ALTER TABLE "relay" ALTER COLUMN "advertised_cidrs" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "relay" ALTER COLUMN "advertised_cidrs" SET DATA TYPE cidr[] USING translate("advertised_cidrs"::text, '[]"', '{}')::cidr[];--> statement-breakpoint
ALTER TABLE "relay" ALTER COLUMN "advertised_cidrs" SET DEFAULT '{}'::cidr[];--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "token" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "relay" ADD CONSTRAINT "relay_member_advertised_cidrs_empty_check" CHECK ("relay"."role" <> 'member' OR cardinality("relay"."advertised_cidrs") = 0);