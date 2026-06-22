ALTER TABLE `kline_daily` ADD `atr14` real;--> statement-breakpoint
ALTER TABLE `kline_daily` ADD `obv` real;--> statement-breakpoint
ALTER TABLE `kline_daily` ADD `vol_ma5` real;--> statement-breakpoint
ALTER TABLE `kline_daily` ADD `vol_ratio` real;--> statement-breakpoint
ALTER TABLE `kline_daily` ADD `pct_chg` real;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `kline_daily_market_idx` ON `kline_daily` (`market_code`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `kline_daily_date_idx` ON `kline_daily` (`date`);
