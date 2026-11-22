CREATE TABLE "voice_suspensions" (
	"player_id" varchar(64) NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_voice_suspensions" PRIMARY KEY("player_id")
);
--> statement-breakpoint
ALTER TABLE "player_reports" DROP CONSTRAINT "ck_player_reports_reason";--> statement-breakpoint
ALTER TABLE "player_reports" ADD COLUMN "reporter_address" varchar(24);--> statement-breakpoint
ALTER TABLE "voice_suspensions" ADD CONSTRAINT "fk_voice_suspensions_player_id_players" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_reports" ADD CONSTRAINT "ck_player_reports_reason" CHECK (reason IN ('handle', 'abuse', 'collusion', 'other', 'voice'));