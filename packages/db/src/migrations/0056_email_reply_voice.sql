ALTER TABLE "email_accounts" ADD COLUMN "reply_from_account_id" uuid;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_reply_from_account_id_fkey" FOREIGN KEY ("reply_from_account_id") REFERENCES "public"."email_accounts"("id") ON DELETE set null ON UPDATE no action;
