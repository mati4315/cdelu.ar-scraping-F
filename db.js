const mysql = require('mysql2/promise');
const config = require('./config');
const logger = require('./logger');

// Evita que mysql2 intente WebAssembly (falla en Hostinger desde cron)
process.env.MYSQL2_USE_NATIVE_AUTH = '1';
process.env.MYSQL2_DISABLE_WASM = '1';

let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool(config.db);
    logger.info('Pool MySQL creado.');
  }
  return pool;
}

async function initTables() {
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS fb_posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_unico VARCHAR(100) UNIQUE NOT NULL,
        author_name VARCHAR(255) NOT NULL,
        author_id VARCHAR(50),
        group_name VARCHAR(255),
        group_url VARCHAR(500),
        content LONGTEXT,
        content_hash VARCHAR(64),
        images JSON,
        video_links JSON,
        tags JSON,
        post_url VARCHAR(255),
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_unico (id_unico),
        INDEX idx_author (author_name),
        INDEX idx_group (group_name),
        INDEX idx_scraped (scraped_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    await conn.execute(`
      ALTER TABLE fb_posts
      ADD COLUMN IF NOT EXISTS tags JSON,
      ADD COLUMN IF NOT EXISTS post_url VARCHAR(255)
    `);

    await conn.execute(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS scrape_errors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        batch_id VARCHAR(36),
        post_id VARCHAR(100),
        error_message TEXT NOT NULL,
        error_type VARCHAR(50),
        url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_batch (batch_id),
        INDEX idx_type (error_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    logger.info('Tablas inicializadas correctamente.');
  } finally {
    conn.release();
  }
}

/**
 * Inicia un run de scraping en la tabla scrape_runs.
 */
async function startScrapeRun(batchId) {
  const p = await getPool();
  await p.execute(
    'INSERT INTO scrape_runs (batch_id, status) VALUES (?, ?)',
    [batchId, 'running']
  );
}

/**
 * Finaliza un run de scraping con estadísticas.
 */
async function finishScrapeRun(batchId, stats, status) {
  const p = await getPool();
  await p.execute(
    `UPDATE scrape_runs SET
      finished_at = NOW(),
      posts_new = ?,
      posts_updated = ?,
      posts_skipped = ?,
      posts_failed = ?,
      pages_scraped = ?,
      errors_count = ?,
      status = ?,
      summary = ?
    WHERE batch_id = ?`,
    [
      stats.postsNew || 0,
      stats.postsUpdated || 0,
      stats.postsSkipped || 0,
      stats.postsFailed || 0,
      stats.pagesScraped || 0,
      stats.errors || 0,
      status,
      stats.summary || null,
      batchId,
    ]
  );
}

/**
 * Registra un error en scrape_errors.
 */
async function logError(batchId, postId, errorMessage, errorType, url) {
  const p = await getPool();
  await p.execute(
    'INSERT INTO scrape_errors (batch_id, post_id, error_message, error_type, url) VALUES (?, ?, ?, ?, ?)',
    [batchId, postId || null, errorMessage, errorType || 'unknown', url || null]
  );
}

/**
 * Inserta o actualiza un post.
 * Retorna: { action: 'inserted' | 'updated' | 'skipped' }
 */
async function upsertPost(postData) {
  const p = await getPool();

  if (!postData.id_unico) {
    return { action: 'skipped', reason: 'no id_unico' };
  }

  const [existing] = await p.execute(
    'SELECT id_unico, content_hash, images, video_links, tags, post_url FROM fb_posts WHERE id_unico = ?',
    [postData.id_unico]
  );

  const nextImagesJson = postData.images ? JSON.stringify(postData.images) : null;
  const nextVideosJson = postData.video_links ? JSON.stringify(postData.video_links) : null;
  const nextTagsJson = postData.tags ? JSON.stringify(postData.tags) : null;
  const nextPostUrl = postData.post_url || null;

  if (existing.length === 0) {
    await p.execute(
      `INSERT INTO fb_posts
        (id_unico, author_name, author_id,
         group_name, group_url,
         content, content_hash,
         images, video_links, tags, post_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        postData.id_unico,
        postData.author_name,
        postData.author_id || null,
        postData.group_name || null,
        postData.group_url || null,
        postData.content || '',
        postData.content_hash || null,
        nextImagesJson,
        nextVideosJson,
        nextTagsJson,
        nextPostUrl,
      ]
    );
    return { action: 'inserted' };
  }

  const existingImagesJson = normalizeJsonColumn(existing[0].images);
  const existingVideosJson = normalizeJsonColumn(existing[0].video_links);
  const existingTagsJson = normalizeJsonColumn(existing[0].tags);
  const tagsChanged = existingTagsJson !== normalizeJsonColumn(nextTagsJson);
  const postUrlChanged = (existing[0].post_url || null) !== nextPostUrl;
  const mediaChanged = existingImagesJson !== normalizeJsonColumn(nextImagesJson) ||
    existingVideosJson !== normalizeJsonColumn(nextVideosJson);

  if (existing[0].content_hash !== postData.content_hash || mediaChanged || tagsChanged || postUrlChanged) {
    await p.execute(
      `UPDATE fb_posts SET
        author_name = ?, author_id = ?,
        group_name = ?, group_url = ?,
        content = ?, content_hash = ?,
        images = ?, video_links = ?, tags = ?, post_url = ?,
        updated_at = NOW()
       WHERE id_unico = ?`,
      [
        postData.author_name,
        postData.author_id || null,
        postData.group_name || null,
        postData.group_url || null,
        postData.content || '',
        postData.content_hash || null,
        nextImagesJson,
        nextVideosJson,
        nextTagsJson,
        nextPostUrl,
        postData.id_unico,
      ]
    );
    return { action: 'updated' };
  }

  return { action: 'skipped', reason: 'unchanged' };
}

function normalizeJsonColumn(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Pool MySQL cerrado.');
  }
}

module.exports = {
  getPool,
  initTables,
  startScrapeRun,
  finishScrapeRun,
  logError,
  upsertPost,
  closePool,
};
