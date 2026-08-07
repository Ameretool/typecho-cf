DROP INDEX `typecho_metas_type_slug`;--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_metas_type_slug` ON `typecho_metas` (`type`,`slug`);