CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"client_id" uuid,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"phone" text,
	"role" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "matched_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_client_idx" ON "contacts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_company_email_idx" ON "contacts" USING btree ("company_id","email");--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_matched_contact_id_contacts_id_fk" FOREIGN KEY ("matched_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;