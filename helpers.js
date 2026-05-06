const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

/**
 * Retraso aleatorio entre MIN y MAX ms (comportamiento humano).
 */
function randomDelay(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// LOCK FILE (anti-solapamiento de cron jobs)
// ═══════════════════════════════════════════════════════════════

function acquireLock() {
  const lockFile = config.lock.lockFile;
  if (fs.existsSync(lockFile)) {
    try {
      const raw = fs.readFileSync(lockFile, 'utf8');
      const data = JSON.parse(raw);
      const pidExists = pidIsRunning(data.pid);
      if (pidExists) {
        logger.warn(`Lock activo: PID ${data.pid} sigue corriendo. Abortando.`);
        return false;
      }
      logger.info(`Lock huérfano (PID ${data.pid} muerto). Limpiando...`);
      fs.unlinkSync(lockFile);
    } catch {
      fs.unlinkSync(lockFile);
    }
  }
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));
  logger.info(`Lock adquirido. PID: ${process.pid}`);
  return true;
}

function releaseLock() {
  const lockFile = config.lock.lockFile;
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      logger.info('Lock liberado.');
    }
  } catch (err) {
    logger.error(`Error liberando lock: ${err.message}`);
  }
}

function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// CIRCUIT BREAKER + COOLDOWN
// ═══════════════════════════════════════════════════════════════

function checkCooldown() {
  const file = config.cooldown.cooldownFile;
  if (!fs.existsSync(file)) return false;

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now = Date.now();
    if (now < data.until) {
      const remainingMs = data.until - now;
      const remainingMin = Math.round(remainingMs / 60000);
      logger.warn(`En cooldown. ${remainingMin} min restantes (razón: ${data.reason})`);
      return true;
    }
    logger.info('Cooldown expirado. Reanudando...');
    fs.unlinkSync(file);
    return false;
  } catch {
    return false;
  }
}

function triggerCooldown(reason) {
  const file = config.cooldown.cooldownFile;

  let consecutiveFailures = 0;
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      consecutiveFailures = (data.consecutiveFailures || 0) + 1;
    } catch { /* ignore */ }
  }

  const multiplier = Math.min(Math.pow(2, consecutiveFailures), 8);
  const cooldownMs = config.cooldown.baseMinutes * 60 * 1000 * multiplier;
  const maxMs = config.cooldown.maxHours * 60 * 60 * 1000;
  const actualCooldown = Math.min(cooldownMs, maxMs);

  const until = Date.now() + actualCooldown;

  fs.writeFileSync(file, JSON.stringify({
    until,
    reason,
    consecutiveFailures,
    triggeredAt: new Date().toISOString(),
  }));

  const minutes = Math.round(actualCooldown / 60000);
  logger.crit(`Circuit breaker activado: ${reason}. Cooldown: ${minutes} min. Fallos: ${consecutiveFailures + 1}`);
}

function resetCooldown() {
  const file = config.cooldown.cooldownFile;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// SESSION STATE
// ═══════════════════════════════════════════════════════════════

function loadSessionState() {
  const file = config.session.stateFile;
  if (!fs.existsSync(file)) return { lastSuccessfulRun: null, lastPostId: null, consecutiveFailures: 0 };

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { lastSuccessfulRun: null, lastPostId: null, consecutiveFailures: 0 };
  }
}

function saveSessionState(state) {
  fs.writeFileSync(config.session.stateFile, JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════
// COOKIES
// ═══════════════════════════════════════════════════════════════

function loadCookies() {
  const file = config.fb.cookiesFile;
  if (!fs.existsSync(file)) {
    logger.crit(`No se encontró ${file}. Coloca tus cookies de FB allí.`);
    return null;
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const cookies = JSON.parse(raw);
    return cookies;
  } catch (err) {
    logger.crit(`Error parseando cookies: ${err.message}`);
    return null;
  }
}

function cookiesToHeader(cookies) {
  if (!cookies || !Array.isArray(cookies)) return '';
  return cookies.map((c) => `${c.name || c.key}=${c.value}`).join('; ');
}

/**
 * Parsea encabezados Set-Cookie de respuestas HTTP y actualiza el array de cookies.
 */
function mergeCookies(existingCookies, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return existingCookies;

  const cookieMap = new Map();
  for (const c of existingCookies) {
    cookieMap.set(c.name || c.key, c);
  }

  for (const header of setCookieHeaders) {
    const parts = header.split(';')[0].split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      cookieMap.set(name, { name, value });
    }
  }

  return Array.from(cookieMap.values());
}

function saveCookies(cookies) {
  fs.writeFileSync(config.fb.cookiesFile, JSON.stringify(cookies, null, 2));
  logger.debug('Cookies actualizadas y guardadas.');
}

// ═══════════════════════════════════════════════════════════════
// USER AGENT
// ═══════════════════════════════════════════════════════════════

function getRandomUserAgent() {
  const list = config.userAgents;
  return list[Math.floor(Math.random() * list.length)];
}

// ═══════════════════════════════════════════════════════════════
// RETRY WITH BACKOFF (para errores de red)
// ═══════════════════════════════════════════════════════════════

async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(`Intento ${attempt}/${maxRetries} falló: ${err.message}. Reintentando en ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
// VALIDATORS
// ═══════════════════════════════════════════════════════════════

function isValidPostId(postId) {
  if (!postId) return false;
  return /^\d+_\d+$/.test(postId);
}

function extractPostIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, config.fb.baseUrl);
    const params = u.searchParams;
    if (params.has('story_fbid')) {
      return `${params.get('id')}_${params.get('story_fbid')}`;
    }
    if (params.has('fbid')) {
      return `${params.get('id')}_${params.get('fbid')}`;
    }
    const permalinkMatch = u.pathname.match(/\/permalink\/(\d+)/);
    if (permalinkMatch) return permalinkMatch[1];
  } catch { /* ignore */ }
  return null;
}

function isValidUrl(url) {
  if (!url) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isFbSpinnerOrIcon(url) {
  if (!url) return true;
  return /\/rsrc\.php\//.test(url) ||
         /\/emoji\.php\//.test(url) ||
         /\/static\.xx\.fbcdn\.net\/.*\/pixel\.gif/.test(url) ||
         /\/ajax\/bootloader-endpoint\.php/.test(url) ||
         /emoji/i.test(url);
}

/**
 * Filtra un array de URLs de imágenes, quitando sprites e íconos de FB.
 */
function filterValidImages(urls) {
  return urls.filter((u) => u && isValidUrl(u) && !isFbSpinnerOrIcon(u));
}

function isValidContent(content) {
  if (!content) return false;
  return content.trim().length >= 2;
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM ALERTS
// ═══════════════════════════════════════════════════════════════

async function sendTelegramAlert(message) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) {
    logger.debug('Telegram no configurado. Saltando alerta.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 10000 });
    logger.debug('Alerta enviada por Telegram.');
  } catch (err) {
    logger.error(`Error enviando alerta Telegram: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════

function cleanup() {
  releaseLock();
  logger.info('Cleanup completado.');
}

// ═══════════════════════════════════════════════════════════════

module.exports = {
  randomDelay,
  sleep,
  acquireLock,
  releaseLock,
  checkCooldown,
  triggerCooldown,
  resetCooldown,
  loadSessionState,
  saveSessionState,
  loadCookies,
  cookiesToHeader,
  mergeCookies,
  saveCookies,
  getRandomUserAgent,
  retryWithBackoff,
  isValidPostId,
  extractPostIdFromUrl,
  isValidUrl,
  isFbSpinnerOrIcon,
  filterValidImages,
  isValidContent,
  sendTelegramAlert,
  cleanup,
};
