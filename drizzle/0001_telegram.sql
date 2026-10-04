ALTER TABLE "accounts" RENAME COLUMN "email" TO "telegram";--> statement-breakpoint
ALTER TABLE "accounts" RENAME COLUMN "email_verified_at" TO "verified_at";--> statement-breakpoint
ALTER TABLE "accounts" RENAME CONSTRAINT "accounts_email_unique" TO "accounts_telegram_unique";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "telegram_chat_id" text;
