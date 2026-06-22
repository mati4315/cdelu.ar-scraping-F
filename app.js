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
  claimPublicationSlot,
  sendTelegramAlert,
  sendTelegramPhoto,
  sendTelegramToChat,
  sendMediaGroup,
  broadcastPost,
  broadcastMessage,
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

    // 8. Resetear cooldown solo si la sesion no se perdio
    if (!stats.sessionLost) {
      resetCooldown();
    } else {
      logger.warn('Cooldown mantenido: sesion perdida durante el scraping.');
    }

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
    // Mandar resumen tambien al canal si es diferente
    if (config.telegram.channelId && config.telegram.channelId !== config.telegram.chatId) {
      await sendTelegramToChat(config.telegram.channelId, telegramMsg);
    }

    // 11. Enviar contenido de cada post nuevo por Telegram (a todos los destinos)
    if (stats.newPosts && stats.newPosts.length > 0) {
      const postsToPublish = [];

      for (const post of stats.newPosts) {
        const slot = claimPublicationSlot();
        if (!slot.allowed) {
          logger.warn(
            `Límite de publicación alcanzado: ${slot.published}/${slot.limit} en ${slot.windowMinutes} min. ` +
            'Se omiten los posts restantes de esta corrida.'
          );
          break;
        }

        postsToPublish.push(post);
      }

      for (const post of postsToPublish) {
        await broadcastPost(post);

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

        // Pequeña pausa entre publicaciones para no saturar Telegram/Firebase
        await new Promise(r => setTimeout(r, 500));
      }

      if (stats.newPosts.length > postsToPublish.length) {
        logger.info(`Publicados ${postsToPublish.length} de ${stats.newPosts.length} posts nuevos por límite de ventana.`);
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
  logger.error(`Unhandled Rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

main();
