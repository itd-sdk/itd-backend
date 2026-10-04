DROP TABLE IF EXISTS "payment_methods" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "payments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "subscriptions" CASCADE;--> statement-breakpoint
UPDATE "users" SET "active_pin_slug" = NULL WHERE "active_pin_slug" = 'nuksta';--> statement-breakpoint
DELETE FROM "user_pins" WHERE "pin_slug" = 'nuksta';--> statement-breakpoint
DELETE FROM "pins" WHERE "slug" = 'nuksta';
