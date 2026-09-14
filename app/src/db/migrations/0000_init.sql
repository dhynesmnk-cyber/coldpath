CREATE TYPE "public"."audit_action" AS ENUM('auth.login', 'auth.logout', 'auth.denied', 'pii.read', 'pii.grant', 'pii.revoke', 'capture.create', 'document.ingest', 'crm.ingest', 'deliverable.create', 'deliverable.edit', 'deliverable.approve', 'deliverable.publish', 'account.resolve', 'account.suppress', 'review.resolve', 'role.grant', 'role.revoke');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('allow', 'deny', 'error');--> statement-breakpoint
CREATE TYPE "public"."pii_field" AS ENUM('email', 'phone');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'marketing', 'sales_lead', 'rep', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('identified', 'scored', 'researching', 'in_review', 'published', 'working', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('P0', 'P1', 'P2', 'P3');--> statement-breakpoint
CREATE TYPE "public"."resolved_by" AS ENUM('rule', 'fuzzy', 'human', 'model');--> statement-breakpoint
CREATE TYPE "public"."rto" AS ENUM('PJM', 'MISO', 'SPP', 'ERCOT', 'NYISO', 'ISO-NE', 'CAISO', 'WECC', 'SERC', 'TVA', 'Duke', 'NW', 'SWPP', 'Other');--> statement-breakpoint
CREATE TYPE "public"."vertical" AS ENUM('cold_storage_logistics', 'manufacturing_food_production', 'retail_food_service', 'other');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('gap', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."impact" AS ENUM('critical', 'high', 'medium', 'low', 'context');--> statement-breakpoint
CREATE TYPE "public"."role_in_deal" AS ENUM('economic_buyer', 'economic_buyer_domain', 'financial_validator', 'technical_champion', 'technical_evaluator', 'influencer', 'end_user', 'supporting');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('compliance', 'leadership', 'capex', 'expansion', 'restructuring', 'power', 'regulatory', 'sustainability', 'intent', 'financial', 'technology', 'driver');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('rmp', 'edgar', 'news', 'web', 'job', 'enforcement', 'tariff', 'rto', 'sustainability', 'crm', 'enrichment', 'capture', 'document', 'internal');--> statement-breakpoint
CREATE TYPE "public"."capture_method" AS ENUM('manual_paste', 'csv_export', 'api');--> statement-breakpoint
CREATE TYPE "public"."correction_kind" AS ENUM('wrong', 'stale', 'missing', 'tone', 'other');--> statement-breakpoint
CREATE TYPE "public"."deliverable_status" AS ENUM('draft', 'in_review', 'published', 'superseded', 'blocked', 'stale');--> statement-breakpoint
CREATE TYPE "public"."deliverable_type" AS ENUM('brief', 'exec', 'outbound', 'discovery', 'battle', 'business', 'campaign', 'letter', 'social', 'site_portfolio');--> statement-breakpoint
CREATE TYPE "public"."document_class" AS ENUM('prior_research', 'activity_record', 'mixed', 'unclassifiable', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."cost_operation" AS ENUM('research', 'refresh', 'deliverable', 'enrichment', 'news', 'registry', 'filings', 'web', 'infra');--> statement-breakpoint
CREATE TYPE "public"."gate_id" AS ENUM('G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8');--> statement-breakpoint
CREATE TYPE "public"."ingest_path" AS ENUM('crm', 'reports', 'capture', 'salesintel', 'spec', 'research');--> statement-breakpoint
CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai', 'azure_openai', 'none');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('blocking', 'waiting', 'info');--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idp_subject" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"initials" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_app_user_idp" UNIQUE("tenant_id","idp_subject"),
	CONSTRAINT "uq_app_user_email" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"action" "audit_action" NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"account_id" uuid,
	"outcome" "audit_outcome" NOT NULL,
	"reason" text,
	"ip" "inet",
	"user_agent" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "pii_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"field" "pii_field" NOT NULL,
	"consent_basis" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "uq_pii_grant" UNIQUE("tenant_id","user_id","person_id","field")
);
--> statement-breakpoint
CREATE TABLE "read_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deliverable_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"scope" uuid,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "uq_role_grant" UNIQUE("tenant_id","user_id","role","scope")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" "inet",
	"user_agent" text,
	"idp_session_id" text
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"vertical" "vertical" DEFAULT 'cold_storage_logistics' NOT NULL,
	"ticker" text,
	"hq" text,
	"website" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"crm_id" text,
	"owner_id" uuid,
	"rep_id" uuid,
	"priority" "priority",
	"status" "account_status" DEFAULT 'identified' NOT NULL,
	"icp_score" integer,
	"icp_components" jsonb,
	"research_state" jsonb,
	"researched_at" timestamp with time zone,
	"refresh_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_account_canonical" UNIQUE("tenant_id","canonical_name")
);
--> statement-breakpoint
CREATE TABLE "account_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"reported_name" text NOT NULL,
	"source" text,
	"confidence" integer DEFAULT 1 NOT NULL,
	"resolved_by" "resolved_by" NOT NULL,
	"match_score" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_alias" UNIQUE("tenant_id","account_id","reported_name")
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"state" text,
	"rto" "rto",
	"naics" text,
	"ammonia_lb" integer DEFAULT 0 NOT NULL,
	"program_level" integer,
	"accidents" integer DEFAULT 0 NOT NULL,
	"recent_accidents" integer DEFAULT 0 NOT NULL,
	"submissions" integer DEFAULT 0 NOT NULL,
	"rmp_id" text,
	"lat" numeric(10, 6),
	"lon" numeric(10, 6),
	"url" text,
	"validated" boolean DEFAULT true NOT NULL,
	"validation_note" text,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"predicate" text NOT NULL,
	"value" text NOT NULL,
	"as_of" date,
	"source_id" uuid NOT NULL,
	"confidence" integer DEFAULT 1 NOT NULL,
	"citation_start" integer,
	"citation_end" integer,
	"used_in_deliverable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"pillar" integer NOT NULL,
	"title" text NOT NULL,
	"evidence" text NOT NULL,
	"ndustrial_angle" text NOT NULL,
	"severity" integer NOT NULL,
	"is_weak_fit" boolean DEFAULT false NOT NULL,
	"is_strategic" boolean DEFAULT false NOT NULL,
	"supporting_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text,
	"title" text,
	"role_in_deal" "role_in_deal" NOT NULL,
	"confidence" integer DEFAULT 1 NOT NULL,
	"is_gap" boolean DEFAULT false NOT NULL,
	"gap_reason" text,
	"resolution_path" text,
	"angle" text,
	"provenance" text,
	"as_of" date,
	"email" text,
	"phone" text,
	"linkedin_url" text,
	"verified_at" date
);
--> statement-breakpoint
CREATE TABLE "signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"site_id" uuid,
	"type" "signal_type" NOT NULL,
	"occurred_on" date NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"impact" "impact" NOT NULL,
	"why_it_matters" text,
	"source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" "source_kind" NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"publisher" text,
	"published_on" date,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" integer DEFAULT 1 NOT NULL,
	"licence" text NOT NULL,
	"attribution" text,
	"data_through" date,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "capture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid,
	"person_id" uuid,
	"captured_by" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_url" text,
	"source_kind" text DEFAULT 'linkedin_sales_navigator' NOT NULL,
	"capture_method" "capture_method" DEFAULT 'manual_paste' NOT NULL,
	"raw_text" text NOT NULL,
	"extracted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" integer DEFAULT 2 NOT NULL,
	"corroborated_by" uuid,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deliverable_id" uuid NOT NULL,
	"fact_id" uuid,
	"person_id" uuid,
	"raised_by" uuid NOT NULL,
	"kind" "correction_kind" NOT NULL,
	"note" text,
	"resolved" jsonb DEFAULT 'false'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "deliverable_type" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "deliverable_status" DEFAULT 'draft' NOT NULL,
	"body" jsonb NOT NULL,
	"rendered" text,
	"min_confidence" integer DEFAULT 2 NOT NULL,
	"blocked_reason" text,
	"author_id" uuid,
	"approved_by" uuid,
	"published_at" timestamp with time zone,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_deliverable_version" UNIQUE("tenant_id","account_id","type","version")
);
--> statement-breakpoint
CREATE TABLE "deliverable_fact" (
	"deliverable_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "deliverable_fact_deliverable_id_fact_id_pk" PRIMARY KEY("deliverable_id","fact_id")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid,
	"filename" text NOT NULL,
	"mime" text,
	"bytes" bigint,
	"extracted_text" text,
	"classification" "document_class" NOT NULL,
	"classification_margin" integer,
	"research_markers" integer DEFAULT 0 NOT NULL,
	"activity_markers" integer DEFAULT 0 NOT NULL,
	"author" text,
	"doc_date" text,
	"age_days" integer,
	"confidence_cap" integer DEFAULT 2 NOT NULL,
	"rejection_reason" text,
	"indexed_for_suppression" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation" "cost_operation" NOT NULL,
	"account_id" uuid,
	"units" integer DEFAULT 1 NOT NULL,
	"unit_cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"provider" "llm_provider" DEFAULT 'none' NOT NULL,
	"model" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "review_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gate" "gate_id" NOT NULL,
	"path" "ingest_path" NOT NULL,
	"severity" "severity" NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"account_id" uuid,
	"evidence" jsonb,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii_grant" ADD CONSTRAINT "pii_grant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii_grant" ADD CONSTRAINT "pii_grant_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii_grant" ADD CONSTRAINT "pii_grant_granted_by_app_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipt" ADD CONSTRAINT "read_receipt_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipt" ADD CONSTRAINT "read_receipt_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_granted_by_app_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_rep_id_app_user_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_alias" ADD CONSTRAINT "account_alias_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_alias" ADD CONSTRAINT "account_alias_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain" ADD CONSTRAINT "pain_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain" ADD CONSTRAINT "pain_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_captured_by_app_user_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_corroborated_by_fact_id_fk" FOREIGN KEY ("corroborated_by") REFERENCES "public"."fact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction" ADD CONSTRAINT "correction_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction" ADD CONSTRAINT "correction_deliverable_id_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction" ADD CONSTRAINT "correction_fact_id_fact_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."fact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction" ADD CONSTRAINT "correction_raised_by_app_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable" ADD CONSTRAINT "deliverable_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable" ADD CONSTRAINT "deliverable_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable" ADD CONSTRAINT "deliverable_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable" ADD CONSTRAINT "deliverable_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_fact" ADD CONSTRAINT "deliverable_fact_deliverable_id_deliverable_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_fact" ADD CONSTRAINT "deliverable_fact_fact_id_fact_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."fact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_fact" ADD CONSTRAINT "deliverable_fact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_app_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_event" ADD CONSTRAINT "cost_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_event" ADD CONSTRAINT "cost_event_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_app_user_tenant" ON "app_user" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ix_audit_tenant_at" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "ix_audit_user" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_read_receipt_deliverable" ON "read_receipt" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "ix_role_grant_user" ON "role_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_session_user" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_session_tenant" ON "session" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ix_account_tenant_status" ON "account" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ix_account_owner" ON "account" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "ix_alias_name" ON "account_alias" USING btree ("reported_name");--> statement-breakpoint
CREATE INDEX "ix_site_account" ON "site" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_site_tenant_rto" ON "site" USING btree ("tenant_id","rto");--> statement-breakpoint
CREATE INDEX "ix_site_unvalidated" ON "site" USING btree ("tenant_id","validated");--> statement-breakpoint
CREATE INDEX "ix_fact_account" ON "fact" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_fact_source" ON "fact" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ix_pain_account" ON "pain" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_person_account" ON "person" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_person_gap" ON "person" USING btree ("tenant_id","is_gap");--> statement-breakpoint
CREATE INDEX "ix_signal_account" ON "signal" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_signal_date" ON "signal" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "ix_source_account" ON "source" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_source_kind" ON "source" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "ix_capture_account" ON "capture" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_capture_by" ON "capture" USING btree ("captured_by");--> statement-breakpoint
CREATE INDEX "ix_correction_deliverable" ON "correction" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "ix_deliverable_account" ON "deliverable" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ix_deliverable_status" ON "deliverable" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ix_df_fact" ON "deliverable_fact" USING btree ("fact_id");--> statement-breakpoint
CREATE INDEX "ix_document_classification" ON "document" USING btree ("tenant_id","classification");--> statement-breakpoint
CREATE INDEX "ix_cost_tenant_at" ON "cost_event" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "ix_cost_operation" ON "cost_event" USING btree ("operation");--> statement-breakpoint
CREATE INDEX "ix_review_open" ON "review_item" USING btree ("tenant_id","severity","resolved_at");--> statement-breakpoint
CREATE INDEX "ix_review_gate" ON "review_item" USING btree ("gate");