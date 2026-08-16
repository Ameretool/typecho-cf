DROP INDEX `typecho_options_name_user`;--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_options_user_name` ON `typecho_options` (`user`,`name`);