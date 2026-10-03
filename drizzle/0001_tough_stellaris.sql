DROP INDEX `typecho_contents_type_status`;--> statement-breakpoint
CREATE INDEX `typecho_contents_type_status_created` ON `typecho_contents` (`type`,`status`,`created`);--> statement-breakpoint
CREATE INDEX `typecho_contents_author_type_status_created` ON `typecho_contents` (`authorId`,`type`,`status`,`created`);--> statement-breakpoint
CREATE INDEX `typecho_contents_type_status_order` ON `typecho_contents` (`type`,`status`,`order`);--> statement-breakpoint
DROP INDEX `typecho_relationships_mid`;--> statement-breakpoint
CREATE INDEX `typecho_relationships_mid_cid` ON `typecho_relationships` (`mid`,`cid`);--> statement-breakpoint
CREATE INDEX `typecho_comments_cid_status_parent_created` ON `typecho_comments` (`cid`,`status`,`parent`,`created`);--> statement-breakpoint
CREATE INDEX `typecho_comments_status_created` ON `typecho_comments` (`status`,`created`);