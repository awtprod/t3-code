CREATE TABLE "relay_web_push_subscriptions" (
	"user_id" varchar(255),
	"device_id" varchar(255),
	"label" text DEFAULT 'Web browser' NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"app_version" varchar(64),
	"preferences_json" jsonb NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_web_push_subscriptions_pkey" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_web_push_subscriptions_endpoint" ON "relay_web_push_subscriptions" ("endpoint");