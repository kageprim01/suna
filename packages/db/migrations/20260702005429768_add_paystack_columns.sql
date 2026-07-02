CREATE TABLE "kortix"."tunnel_rpc_forwards" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tunnel_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"requester_relay_owner_id" varchar(255),
	"target_relay_owner_id" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"method" varchar(255) NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "paystack_subscription_code" varchar(255);--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "paystack_email_token" varchar(255);--> statement-breakpoint
ALTER TABLE "kortix"."credit_purchases" ADD COLUMN "paystack_reference" text;--> statement-breakpoint
ALTER TABLE "kortix"."credit_purchases" ADD COLUMN "paystack_access_code" text;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_connections" ADD COLUMN "relay_owner_id" varchar(255);--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_connections" ADD COLUMN "relay_owner_instance" varchar(255);--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_connections" ADD COLUMN "relay_owner_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_connections" ADD COLUMN "relay_owner_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_rpc_forwards" ADD CONSTRAINT "tunnel_rpc_forwards_tunnel_id_tunnel_connections_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tunnel_rpc_forwards_target_status" ON "kortix"."tunnel_rpc_forwards" USING btree ("target_relay_owner_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_tunnel_rpc_forwards_expiry" ON "kortix"."tunnel_rpc_forwards" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_tunnel_rpc_forwards_tunnel" ON "kortix"."tunnel_rpc_forwards" USING btree ("tunnel_id");--> statement-breakpoint
CREATE INDEX "idx_tunnel_connections_relay_owner" ON "kortix"."tunnel_connections" USING btree ("relay_owner_id");