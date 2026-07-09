CREATE TYPE "agentica"."gateway_budget_action" AS ENUM('block', 'warn');--> statement-breakpoint
CREATE TYPE "agentica"."gateway_budget_period" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "agentica"."gateway_budget_scope" AS ENUM('project', 'member');--> statement-breakpoint
CREATE TABLE "agentica"."gateway_budgets" (
	"budget_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" "agentica"."gateway_budget_scope" NOT NULL,
	"subject_user_id" uuid,
	"limit_usd" numeric(12, 4) NOT NULL,
	"period" "agentica"."gateway_budget_period" DEFAULT 'month' NOT NULL,
	"action" "agentica"."gateway_budget_action" DEFAULT 'block' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentica"."gateway_budgets" ADD CONSTRAINT "gateway_budgets_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "agentica"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gateway_budgets_project" ON "agentica"."gateway_budgets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_budgets_lookup" ON "agentica"."gateway_budgets" USING btree ("project_id","scope");