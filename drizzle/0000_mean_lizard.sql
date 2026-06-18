CREATE TABLE `ai_sentiment` (
	`market_code` text PRIMARY KEY NOT NULL,
	`score` real NOT NULL,
	`label` text NOT NULL,
	`summary` text NOT NULL,
	`signals` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market_code` text NOT NULL,
	`type` text NOT NULL,
	`threshold` real NOT NULL,
	`is_triggered` integer DEFAULT false,
	`is_active` integer DEFAULT true,
	`created_at` integer NOT NULL,
	`triggered_at` integer
);
--> statement-breakpoint
CREATE INDEX `alerts_market_code_idx` ON `alerts` (`market_code`);--> statement-breakpoint
CREATE INDEX `alerts_is_active_idx` ON `alerts` (`is_active`);--> statement-breakpoint
CREATE TABLE `daily_snapshot` (
	`market_code` text NOT NULL,
	`date` text NOT NULL,
	`pe_ratio` real,
	`pb_ratio` real,
	`turnover_rate` real,
	`total_market_value` real,
	`circulating_market_value` real,
	`updated_at` integer,
	PRIMARY KEY(`market_code`, `date`)
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `kline_daily` (
	`market_code` text NOT NULL,
	`date` text NOT NULL,
	`open` real NOT NULL,
	`close` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`volume` real NOT NULL,
	`macd` real,
	`macd_signal` real,
	`macd_hist` real,
	`rsi14` real,
	`boll_mid` real,
	`boll_upper` real,
	`boll_lower` real,
	`kdj_k` real,
	`kdj_d` real,
	`kdj_j` real,
	PRIMARY KEY(`market_code`, `date`)
);
--> statement-breakpoint
CREATE TABLE `kline_min` (
	`market_code` text NOT NULL,
	`period` text NOT NULL,
	`time` text NOT NULL,
	`open` real NOT NULL,
	`close` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`volume` real NOT NULL,
	PRIMARY KEY(`market_code`, `period`, `time`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`is_read` integer DEFAULT false,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_groups_link` (
	`market_code` text NOT NULL,
	`group_id` integer NOT NULL,
	PRIMARY KEY(`market_code`, `group_id`)
);
--> statement-breakpoint
CREATE TABLE `stocks` (
	`market_code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`view` text,
	`industry` text,
	`remarks` text,
	`is_active` integer DEFAULT true,
	`last_sync_time` integer
);
