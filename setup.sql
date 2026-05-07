-- =============================================================
-- Facebook Scraper - Esquema de Base de Datos
-- Ejecutar en MySQL para inicializar las tablas.
-- =============================================================

CREATE DATABASE IF NOT EXISTS facebook_scraper
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE facebook_scraper;

-- Tabla principal de posts
CREATE TABLE IF NOT EXISTS fb_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_unico VARCHAR(100) UNIQUE NOT NULL COMMENT 'author_id + mes + semana + 20chars texto limpio',
    author_name VARCHAR(255) NOT NULL,
    author_id VARCHAR(50) COMMENT 'Facebook numeric user ID',
    group_name VARCHAR(255) COMMENT 'Nombre del grupo (si viene del feed de grupos)',
    group_url VARCHAR(500) COMMENT 'ID numérico del grupo',
    content LONGTEXT COMMENT 'Texto completo del post',
    content_hash VARCHAR(64) COMMENT 'SHA256 del contenido para detectar ediciones',
    images JSON COMMENT 'Array de URLs de imágenes',
    video_links JSON COMMENT 'Array de URLs de videos',
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_unico (id_unico),
    INDEX idx_author (author_name),
    INDEX idx_group (group_name),
    INDEX idx_scraped (scraped_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de estadísticas de ejecución
CREATE TABLE IF NOT EXISTS scrape_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id VARCHAR(36) NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL,
    posts_new INT DEFAULT 0,
    posts_updated INT DEFAULT 0,
    posts_skipped INT DEFAULT 0,
    posts_failed INT DEFAULT 0,
    pages_scraped INT DEFAULT 0,
    errors_count INT DEFAULT 0,
    status ENUM('running','success','failed','aborted') DEFAULT 'running',
    summary TEXT,
    INDEX idx_batch (batch_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de errores
CREATE TABLE IF NOT EXISTS scrape_errors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id VARCHAR(36),
    post_id VARCHAR(100),
    error_message TEXT NOT NULL,
    error_type VARCHAR(50) COMMENT 'Tipo de error: page_fetch, post_process, session, etc.',
    url TEXT COMMENT 'URL donde ocurrió el error',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_batch (batch_id),
    INDEX idx_type (error_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
