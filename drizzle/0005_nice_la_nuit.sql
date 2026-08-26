DROP INDEX `typecho_contents_slug`;--> statement-breakpoint
CREATE INDEX `typecho_contents_slug` ON `typecho_contents` (`slug`);