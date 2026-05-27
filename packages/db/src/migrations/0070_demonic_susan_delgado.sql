CREATE TABLE "telegram_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" text NOT NULL,
	"telegram_username" text,
	"app_user_id" text NOT NULL,
	"pairing_token" text,
	"pairing_expires_at" timestamp with time zone,
	"paired_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"bot_token_enc" text NOT NULL,
	"bot_username" text NOT NULL,
	"delivery_mode" text DEFAULT 'longpoll' NOT NULL,
	"webhook_secret" text,
	"public_base_url" text,
	"allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_offset" integer DEFAULT 0,
	"last_error_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_bindings" ADD CONSTRAINT "telegram_bindings_app_user_id_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_bindings_telegram_user_id_idx" ON "telegram_bindings" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "telegram_bindings_app_user_id_idx" ON "telegram_bindings" USING btree ("app_user_id");--> statement-breakpoint
CREATE INDEX "telegram_bindings_pairing_token_idx" ON "telegram_bindings" USING btree ("pairing_token");--> statement-breakpoint
CREATE INDEX "telegram_bots_company_id_idx" ON "telegram_bots" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "telegram_bots_active_idx" ON "telegram_bots" USING btree ("active");