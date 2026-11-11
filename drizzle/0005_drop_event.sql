DROP TABLE "event_items" CASCADE;--> statement-breakpoint
DROP TABLE "event_nicknames" CASCADE;--> statement-breakpoint
DROP TABLE "event_placements" CASCADE;--> statement-breakpoint
DROP TABLE "event_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "event_wallets" CASCADE;--> statement-breakpoint
DROP TABLE "post_marks" CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "event_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "event_cycle";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "notebook_style";--> statement-breakpoint
DELETE FROM "notifications" WHERE "type" = 'alice_task_reminder';--> statement-breakpoint
UPDATE "users" SET "active_pin_slug" = NULL WHERE "active_pin_slug" = 'aliceai';--> statement-breakpoint
DELETE FROM "user_pins" WHERE "pin_slug" = 'aliceai';--> statement-breakpoint
DELETE FROM "pins" WHERE "slug" = 'aliceai';
