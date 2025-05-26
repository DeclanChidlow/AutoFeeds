-- Initialise database with required tables
-- This runs automatically when the MariaDB container starts for the first time

USE autofeeds;

CREATE TABLE IF NOT EXISTS feeds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    url VARCHAR(512) NOT NULL,
    channel_id VARCHAR(26) NOT NULL,
    server_id VARCHAR(26) NOT NULL,
    feed_type ENUM('rss', 'atom', 'json') NOT NULL,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_feed_channel (url, channel_id),
    INDEX idx_channel_id (channel_id),
    INDEX idx_server_id (server_id),
    INDEX idx_last_updated (last_updated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feed_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    feed_id INT NOT NULL,
    item_id VARCHAR(512) NOT NULL,
    title VARCHAR(512),
    link VARCHAR(512),
    published_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
    UNIQUE KEY unique_item (feed_id, item_id),
    INDEX idx_feed_id (feed_id),
    INDEX idx_published_at (published_at),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
