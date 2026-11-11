CREATE TABLE "contact_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"new_value" text NOT NULL,
	"new_chat_id" text,
	"applies_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"canceled_at" timestamp (3) with time zone,
	"applied_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "contact_changes" ADD CONSTRAINT "contact_changes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_changes_account_idx" ON "contact_changes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "contact_changes_due_idx" ON "contact_changes" USING btree ("applies_at");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_phone_unique" UNIQUE("phone");