CREATE TABLE "audit" ("id" INTEGER PRIMARY KEY,"member_id" INTEGER,"event" TEXT);
--> statement-breakpoint
CREATE VIEW "member_names" AS SELECT "id","display_name" FROM "members";
--> statement-breakpoint
CREATE INDEX "name_desc" ON "members"("display_name" DESC,"id");
--> statement-breakpoint
CREATE INDEX "live_name" ON "members"(lower("display_name")) WHERE "score">0;
--> statement-breakpoint
CREATE TRIGGER "member_added" AFTER INSERT ON "members" BEGIN INSERT INTO "audit"("member_id","event") VALUES(new.id,'insert'); END;
