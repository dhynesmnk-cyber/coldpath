CREATE INDEX "ix_session_refresh_hash" ON "session" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "ix_session_issued_at" ON "session" USING btree ("issued_at");