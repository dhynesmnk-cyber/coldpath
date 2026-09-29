-- Sector expansion wiring — EXPANSION-PLAN.md §6 step 2 (schema deltas).
-- Adds the three expansion verticals and the universe-source kinds introduced
-- by connectors/{cement,district-energy,ev-depot} (steps 4-7), keeping the
-- Postgres enums in sync with src/db/schema/{account,research}.ts.
--
-- NOTE: ALTER TYPE ... ADD VALUE is safe here because PG12+ allows it outside
-- a transaction and these harnesses run statements individually. Production
-- applies this file via scripts/migrate-prod.ts, which does NOT wrap it in a
-- transaction (verify before changing that behaviour).
ALTER TYPE "public"."vertical" ADD VALUE IF NOT EXISTS 'cement_bulk_minerals';--> statement-breakpoint
ALTER TYPE "public"."vertical" ADD VALUE IF NOT EXISTS 'district_energy';--> statement-breakpoint
ALTER TYPE "public"."vertical" ADD VALUE IF NOT EXISTS 'heavy_transport_ev_depots';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE IF NOT EXISTS 'directory';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE IF NOT EXISTS 'usgs';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE IF NOT EXISTS 'afdc';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE IF NOT EXISTS 'grants';
