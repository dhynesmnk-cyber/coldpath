ALTER TABLE "session" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "refresh_hash" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "family_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "refresh_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
CREATE INDEX "ix_session_family" ON "session" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash");