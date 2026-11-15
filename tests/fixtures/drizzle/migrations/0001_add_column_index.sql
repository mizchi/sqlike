ALTER TABLE `users` ADD `bio` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX `name_feed` ON `users` (`name`,`id`);
