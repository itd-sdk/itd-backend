ALTER TABLE "event_wallets" ADD COLUMN "notebook_grid" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_wallets" ADD COLUMN "notebook_ruled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "notebook_style" text;