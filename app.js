require('dotenv').config();

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
  cleanup,
} = require('./helpers');
const FacebookScraper = require('./scraper');

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
