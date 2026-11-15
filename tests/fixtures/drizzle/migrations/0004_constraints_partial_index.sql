PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`score` real DEFAULT 0.5 NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	CONSTRAINT "valid_name" CHECK(length("__new_users"."name")>0)
);

--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "email", "score", "bio") SELECT "id", "name", "email", "score", "bio" FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE INDEX `name_feed` ON `users` (`name`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_unique` ON `users` (`email`);
