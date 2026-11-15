ALTER TABLE "users" RENAME TO "members";
--> statement-breakpoint
ALTER TABLE "members" RENAME COLUMN "name" TO "display_name";
