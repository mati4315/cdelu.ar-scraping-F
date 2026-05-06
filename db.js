const mysql = require('mysql2/promise');
const config = require('./config');
const logger = require('./logger');

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
        post_id VARCHAR(100) UNIQUE NOT NULL,
        author_name VARCHAR(255) NOT NULL,
        author_profile_url VARCHAR(500),
        author_profile_pic TEXT,
        group_name VARCHAR(255),
        group_url VARCHAR(500),
        content LONGTEXT,
        content_hash VARCHAR(64),
        original_post_link TEXT NOT NULL,
        post_timestamp VARCHAR(50),
        images JSON,
        video_links JSON,
        reaction_count INT DEFAULT 0,
        comment_count INT DEFAULT 0,
        share_count INT DEFAULT 0,
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        scrape_batch_id VARCHAR(36),
        scrape_status ENUM('new','updated','failed','skipped') DEFAULT 'new',
        INDEX idx_post_id (post_id),
        INDEX idx_author (author_name),
        INDEX idx_group (group_name),
        INDEX idx_scraped (scraped_at),
        INDEX idx_batch (scrape_batch_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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

  if (!postData.post_id) {
    return { action: 'skipped', reason: 'no post_id' };
  }

  const [existing] = await p.execute(
    'SELECT post_id, content_hash FROM fb_posts WHERE post_id = ?',
    [postData.post_id]
  );

  if (existing.length === 0) {
    await p.execute(
      `INSERT INTO fb_posts
        (post_id, author_name, author_profile_url, author_profile_pic,
         group_name, group_url,
         content, content_hash, original_post_link, post_timestamp,
         images, video_links, reaction_count, comment_count, share_count,
         scrape_batch_id, scrape_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [
        postData.post_id,
        postData.author_name,
        postData.author_profile_url || null,
        postData.author_profile_pic || null,
        postData.group_name || null,
        postData.group_url || null,
        postData.content || '',
        postData.content_hash || null,
        postData.original_post_link || '',
        postData.post_timestamp || null,
        postData.images ? JSON.stringify(postData.images) : null,
        postData.video_links ? JSON.stringify(postData.video_links) : null,
        postData.reaction_count || 0,
        postData.comment_count || 0,
        postData.share_count || 0,
        postData.scrape_batch_id || null,
      ]
    );
    return { action: 'inserted' };
  }

  if (existing[0].content_hash !== postData.content_hash) {
    await p.execute(
      `UPDATE fb_posts SET
        author_name = ?, author_profile_url = ?, author_profile_pic = ?,
        group_name = ?, group_url = ?,
        content = ?, content_hash = ?, original_post_link = ?,
        post_timestamp = ?, images = ?, video_links = ?,
        reaction_count = ?, comment_count = ?, share_count = ?,
        scrape_batch_id = ?, scrape_status = 'updated', updated_at = NOW()
       WHERE post_id = ?`,
      [
        postData.author_name,
        postData.author_profile_url || null,
        postData.author_profile_pic || null,
        postData.group_name || null,
        postData.group_url || null,
        postData.content || '',
        postData.content_hash || null,
        postData.original_post_link || '',
        postData.post_timestamp || null,
        postData.images ? JSON.stringify(postData.images) : null,
        postData.video_links ? JSON.stringify(postData.video_links) : null,
        postData.reaction_count || 0,
        postData.comment_count || 0,
        postData.share_count || 0,
        postData.scrape_batch_id || null,
        postData.post_id,
      ]
    );
    return { action: 'updated' };
  }

  return { action: 'skipped', reason: 'unchanged' };
}

/**
 * Verifica si un post_id ya existe en la DB.
 */
async function postExists(postId) {
  const p = await getPool();
  const [rows] = await p.execute(
    'SELECT 1 FROM fb_posts WHERE post_id = ? LIMIT 1',
    [postId]
  );
  return rows.length > 0;
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
  postExists,
  closePool,
};
