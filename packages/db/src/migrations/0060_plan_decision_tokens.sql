CREATE TABLE "plan_decision_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_decision_tokens" ADD CONSTRAINT "plan_decision_tokens_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_decision_tokens_token_idx" ON "plan_decision_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "plan_decision_tokens_plan_idx" ON "plan_decision_tokens" USING btree ("plan_id");
