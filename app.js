require('dotenv').config();

// Evita WebAssembly out-of-memory en Hostinger (mysql2 caching_sha2_password)
process.env.MYSQL2_USE_NATIVE_AUTH = '1';
process.env.MYSQL2_DISABLE_WASM = '1';

// ── Modo servidor HTTP (Passenger / Hostinger Node.js App) ──────
// Si existe la variable PORT, Passenger está corriendo este archivo
// como una web app. En ese caso cargamos server.js en su lugar.
if (process.env.PORT) {
  require('./server');
  return;
}
// ────────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const {
  acquireLock,
  releaseLock,
  checkCooldown,
  resetCooldown,
  loadSessionState,
  saveSessionState,
  sendTelegramAlert,
  sendTelegramPhoto,
  sendMediaGroup,
  cleanup,
} = require('./helpers');
const FacebookScraper = require('./scraper');
const { syncToFirebase } = require('./firebase');

const BATCH_ID = uuidv4();

async function main() {
  logger.info('══════════════════════════════════════════════');
  logger.info('Facebook Scraper - Iniciando');
  logger.info(`Batch ID: ${BATCH_ID}`);
  logger.info(`Modo: ${config.dryRun ? 'DRY RUN (sin escritura en DB)' : 'PRODUCCIÓN'}`);
  logger.info(`Hora: ${new Date().toISOString()}`);
  logger.info('══════════════════════════════════════════════');

  // 1. Verificar lock file
  if (!acquireLock()) {
    logger.info('Otra instancia está corriendo. Saliendo.');
    process.exit(0);
  }

  let exitCode = 0;
  let runStatus = 'success';

  try {
    // 2. Verificar cooldown (circuit breaker)
    if (checkCooldown()) {
      logger.info('En período de cooldown. Saliendo sin ejecutar.');
      releaseLock();
      process.exit(0);
    }

    // 3. Conectar a MySQL e inicializar tablas
    logger.info('Conectando a MySQL...');
    await db.initTables();

    if (!config.dryRun) {
      await db.startScrapeRun(BATCH_ID);
    }

    // 4. Inicializar scraper
    const scraper = new FacebookScraper(BATCH_ID);
    await scraper.init();

    // 5. Health check pre-scraping
    try {
      await scraper.healthCheck();
    } catch (err) {
      logger.crit(`Health check falló: ${err.message}`);
      runStatus = 'aborted';

      if (!config.dryRun) {
        await db.finishScrapeRun(BATCH_ID, { errors: 1, summary: `Health check: ${err.message}` }, runStatus);
      }

      const state = loadSessionState();
      state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
      saveSessionState(state);

      await sendTelegramAlert(`<b>❌ FB Scraper - Sesión perdida</b>\nError: ${err.message}\nBatch: ${BATCH_ID}\nFallos consecutivos: ${state.consecutiveFailures}`);

      cleanup();
      process.exit(1);
    }

    // 6. Scraping
    logger.info('Iniciando scraping del feed...');
    const stats = await scraper.scrape();

    // 7. Guardar estadísticas
    stats.summary = `Batch ${BATCH_ID}: ${stats.postsNew} nuevos, ${stats.postsUpdated} actualizados, ${stats.postsSkipped} saltados, ${stats.postsFailed} fallidos`;

    if (!config.dryRun) {
      await db.finishScrapeRun(BATCH_ID, stats, runStatus);
    }

    // 8. Resetear cooldown tras ejecución exitosa
    resetCooldown();

    // 9. Actualizar session state
    const state = loadSessionState();
    state.lastSuccessfulRun = new Date().toISOString();
    state.consecutiveFailures = 0;
    saveSessionState(state);

    // 10. Notificación de resumen
    const emoji = stats.postsNew > 0 ? '✅' : 'ℹ️';
    const telegramMsg =
      `<b>${emoji} FB Scraper - Ejecución completada</b>\n` +
      `Batch: ${BATCH_ID}\n` +
      `Nuevos: ${stats.postsNew} | Actualizados: ${stats.postsUpdated}\n` +
      `Saltados: ${stats.postsSkipped} | Fallidos: ${stats.postsFailed}\n` +
      `Páginas: ${stats.pagesScraped} | Errores: ${stats.errors}\n` +
      `Modo: ${config.dryRun ? 'DRY RUN' : 'Producción'}`;

    await sendTelegramAlert(telegramMsg);

    // 11. Enviar contenido de cada post nuevo por Telegram
    if (stats.newPosts && stats.newPosts.length > 0) {
      for (const post of stats.newPosts) {
        // Texto, truncado a ~1000 chars
        let text = post.text || '';
        if (text.length > 1000) text = text.substring(0, 997) + '...';

        const authorLink = post.author_id
          ? `<a href="https://fb.com/${post.author_id}"><b>${post.author}</b></a>`
          : `<b>${post.author}</b>`;

        const publicLink = (post.group_url && post.post_url)
          ? `\n\n<a href="https://fb.com/groups/${post.group_url}/posts/${post.post_url}"><b>Link a la publicacion</b></a>`
          : '';

        const videoLinks = (post.videos || []).slice(0, 3)
          .map((url, idx) => `\n<a href="${url}"><b>Video ${idx + 1}</b></a>`)
          .join('');

        const postMsg =
          (text ? `${authorLink}\n\n${text}${publicLink}${videoLinks}` : `${authorLink}${publicLink}${videoLinks}`);

        // Si hay imagenes, se envian todas juntas en un media group
        if (post.images && post.images.length > 0) {
          await sendMediaGroup(post.images, postMsg);
        } else {
          // Sin imagenes, solo texto
          await sendTelegramAlert(postMsg);
        }
        // Pequena pausa entre mensajes para no saturar la API
        await new Promise(r => setTimeout(r, 500));
      }

      // 12. Sincronizar posts nuevos con Firebase (Comunidad)
      for (const post of stats.newPosts) {
        await syncToFirebase({
          id_unico: post.id,
          author_name: post.author,
          author_id: post.author_id,
          group_name: post.group,
          group_url: post.group_url,
          content: post.text,
          images: post.images || [],
          video_links: post.videos || [],
          tags: post.tags || [],
          post_url: post.post_url,
        });
        await new Promise(r => setTimeout(r, 300));
      }
    }

    logger.info('══════════════════════════════════════════════');
    logger.info(`Resumen: ${stats.summary}`);
    logger.info('Ejecución exitosa.');
    logger.info('══════════════════════════════════════════════');

  } catch (err) {
    logger.crit(`Error fatal: ${err.message}`);
    logger.crit(err.stack);
    exitCode = 1;
    runStatus = 'failed';

    try {
      if (!config.dryRun) {
        await db.finishScrapeRun(BATCH_ID, { errors: 1, summary: `Fatal: ${err.message}` }, runStatus);
      }
    } catch { /* ignore */ }

    const state = loadSessionState();
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    saveSessionState(state);

    await sendTelegramAlert(
      `<b>❌ FB Scraper - Error fatal</b>\n` +
      `Error: ${err.message}\n` +
      `Batch: ${BATCH_ID}\n` +
      `Fallos: ${state.consecutiveFailures}`
    );
  } finally {
    cleanup();

    try {
      await db.closePool();
    } catch { /* ignore */ }

    logger.info(`Saliendo con código ${exitCode}`);
    process.exit(exitCode);
  }
}

// Manejo de señales
process.on('SIGINT', () => {
  logger.warn('SIGINT recibido. Limpiando...');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.warn('SIGTERM recibido. Limpiando...');
  cleanup();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
});

main();
