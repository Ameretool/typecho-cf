CREATE TABLE `typecho_comments` (
	`coid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cid` integer DEFAULT 0,
	`created` integer DEFAULT 0,
	`author` text,
	`authorId` integer DEFAULT 0,
	`ownerId` integer DEFAULT 0,
	`mail` text,
	`url` text,
	`ip` text,
	`agent` text,
	`text` text,
	`type` text DEFAULT 'comment',
	`status` text DEFAULT 'approved',
	`parent` integer DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `typecho_comments_cid` ON `typecho_comments` (`cid`);--> statement-breakpoint
CREATE INDEX `typecho_comments_created` ON `typecho_comments` (`created`);--> statement-breakpoint
CREATE INDEX `typecho_comments_status_owner` ON `typecho_comments` (`status`,`ownerId`);--> statement-breakpoint
CREATE TABLE `typecho_contents` (
	`cid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text,
	`slug` text,
	`created` integer DEFAULT 0,
	`modified` integer DEFAULT 0,
	`text` text,
	`order` integer DEFAULT 0,
	`authorId` integer DEFAULT 0,
	`template` text,
	`type` text DEFAULT 'post',
	`status` text DEFAULT 'publish',
	`password` text,
	`commentsNum` integer DEFAULT 0,
	`allowComment` text DEFAULT '0',
	`allowPing` text DEFAULT '0',
	`allowFeed` text DEFAULT '0',
	`parent` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_contents_slug` ON `typecho_contents` (`slug`);--> statement-breakpoint
CREATE INDEX `typecho_contents_created` ON `typecho_contents` (`created`);--> statement-breakpoint
CREATE INDEX `typecho_contents_type_status` ON `typecho_contents` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `typecho_contents_authorId` ON `typecho_contents` (`authorId`);--> statement-breakpoint
CREATE INDEX `typecho_contents_parent` ON `typecho_contents` (`parent`);--> statement-breakpoint
CREATE TABLE `typecho_fields` (
	`cid` integer NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'str',
	`str_value` text,
	`int_value` integer DEFAULT 0,
	`float_value` real DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_fields_cid_name` ON `typecho_fields` (`cid`,`name`);--> statement-breakpoint
CREATE INDEX `typecho_fields_int_value` ON `typecho_fields` (`int_value`);--> statement-breakpoint
CREATE INDEX `typecho_fields_float_value` ON `typecho_fields` (`float_value`);--> statement-breakpoint
CREATE TABLE `typecho_login_failures` (
	`ip` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`windowStartedAt` integer DEFAULT 0 NOT NULL,
	`bannedUntil` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `typecho_metas` (
	`mid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`slug` text,
	`type` text NOT NULL,
	`description` text,
	`count` integer DEFAULT 0,
	`order` integer DEFAULT 0,
	`parent` integer DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `typecho_metas_slug` ON `typecho_metas` (`slug`);--> statement-breakpoint
CREATE INDEX `typecho_metas_type_slug` ON `typecho_metas` (`type`,`slug`);--> statement-breakpoint
CREATE TABLE `typecho_options` (
	`name` text NOT NULL,
	`user` integer DEFAULT 0 NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_options_name_user` ON `typecho_options` (`name`,`user`);--> statement-breakpoint
CREATE TABLE `typecho_password_reset_requests` (
	`email` text PRIMARY KEY NOT NULL,
	`lastSentAt` integer DEFAULT 0 NOT NULL,
	`uid` integer,
	`tokenHash` text,
	`expiresAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_password_reset_requests_tokenHash` ON `typecho_password_reset_requests` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `typecho_relationships` (
	`cid` integer NOT NULL,
	`mid` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_relationships_cid_mid` ON `typecho_relationships` (`cid`,`mid`);--> statement-breakpoint
CREATE INDEX `typecho_relationships_mid` ON `typecho_relationships` (`mid`);--> statement-breakpoint
CREATE TABLE `typecho_users` (
	`uid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`password` text,
	`mail` text,
	`url` text,
	`screenName` text,
	`created` integer DEFAULT 0,
	`activated` integer DEFAULT 0,
	`logged` integer DEFAULT 0,
	`group` text DEFAULT 'visitor',
	`authCode` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_users_name` ON `typecho_users` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `typecho_users_mail` ON `typecho_users` (`mail`);--> statement-breakpoint
CREATE INDEX `typecho_users_group` ON `typecho_users` (`group`);