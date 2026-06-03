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
  logger.error(`Circuit breaker activado: ${reason}. Cooldown: ${minutes} min. Fallos: ${consecutiveFailures + 1}`);
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


// -----------------------------------------------------------------------------
// PUBLICATION RATE LIMIT
// -----------------------------------------------------------------------------

function loadPublicationState() {
  const file = config.publication.stateFile;
  const fallback = { publishedAt: [] };

  if (!fs.existsSync(file)) return fallback;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const publishedAt = Array.isArray(raw.publishedAt) ? raw.publishedAt : [];
    return {
      publishedAt: publishedAt
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    };
  } catch {
    return fallback;
  }
}

function savePublicationState(state) {
  const file = config.publication.stateFile;
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function claimPublicationSlot() {
  const now = Date.now();
  const windowMs = config.publication.windowMinutes * 60 * 1000;
  const limit = config.publication.maxPostsPerWindow;
  const state = loadPublicationState();
  const publishedAt = state.publishedAt.filter((ts) => now - ts < windowMs);

  if (publishedAt.length >= limit) {
    state.publishedAt = publishedAt;
    savePublicationState(state);
    return {
      allowed: false,
      remaining: 0,
      published: publishedAt.length,
      limit,
      windowMinutes: config.publication.windowMinutes,
    };
  }

  publishedAt.push(now);
  state.publishedAt = publishedAt;
  savePublicationState(state);

  return {
    allowed: true,
    remaining: Math.max(0, limit - publishedAt.length),
    published: publishedAt.length,
    limit,
    windowMinutes: config.publication.windowMinutes,
  };
}
// ═══════════════════════════════════════════════════════════════
// COOKIES
// ═══════════════════════════════════════════════════════════════

function loadCookies() {
  const file = config.fb.cookiesFile;
  if (!fs.existsSync(file)) {
    logger.error(`No se encontró ${file}. Coloca tus cookies de FB allí.`);
    return null;
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const cookies = JSON.parse(raw);
    return cookies;
  } catch (err) {
    logger.error(`Error parseando cookies: ${err.message}`);
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

/**
 * Envia un mensaje a un chat específico de Telegram.
 * @param {string|number} chatId - ID del chat
 * @param {string} message - Texto del mensaje
 * @param {object} [options] - Opciones adicionales
 * @param {number} [options.topicId] - message_thread_id para topics en foros
 */
async function sendTelegramToChat(chatId, message, options = {}) {
  const { botToken } = config.telegram;
  if (!botToken || !chatId) {
    logger.debug('Telegram no configurado. Saltando mensaje.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (options.topicId) payload.message_thread_id = options.topicId;
    await axios.post(url, payload, { timeout: 10000 });
    logger.debug(`Mensaje enviado a chat ${chatId}.`);
  } catch (err) {
    logger.error(`Error enviando mensaje a ${chatId}: ${err.message}`);
  }
}

/**
 * Envia un mensaje a todos los chats de alerta (logs internos).
 */
async function sendTelegramAlert(message) {
  const chatIds = config.telegramDestinations.alertChatIds;
  for (const chatId of chatIds) {
    // alertas siempre sin topic
    await sendTelegramToChat(typeof chatId === 'object' ? chatId.chatId : chatId, message);
  }
}

/**
 * Envia una foto por Telegram. Soporta URLs remotas o paths locales.
 */
/**
 * Envia una foto a un chat específico.
 * @param {string|number} chatId - ID del chat
 * @param {string} photo - URL o path local de la foto
 * @param {string} [caption] - Pie de foto
 * @param {object} [options] - Opciones adicionales
 * @param {number} [options.topicId] - message_thread_id para topics en foros
 */
async function sendTelegramPhotoToChat(chatId, photo, caption, options = {}) {
  const { botToken } = config.telegram;
  if (!botToken || !chatId) return;
  try {
    if (typeof photo === 'string' && (photo.startsWith('http://') || photo.startsWith('https://'))) {
      const payload = {
        chat_id: chatId,
        photo: photo,
        caption: caption || undefined,
        parse_mode: caption ? 'HTML' : undefined,
      };
      if (options.topicId) payload.message_thread_id = options.topicId;
      await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, payload, { timeout: 15000 });
    } else if (typeof photo === 'string' && fs.existsSync(photo)) {
      await uploadLocalPhoto(botToken, chatId, photo, caption, options);
    } else {
      logger.debug(`Foto no encontrada o formato invalido: ${photo}`);
      return;
    }
    logger.debug(`Foto enviada a chat ${chatId}.`);
  } catch (err) {
    logger.warn(`Error enviando foto a ${chatId}: ${err.message}`);
  }
}

/**
 * Envia una foto al chat principal (legacy).
 */
async function sendTelegramPhoto(photo, caption) {
  const { chatId } = config.telegram;
  if (!chatId) return;
  await sendTelegramPhotoToChat(chatId, photo, caption);
}

function uploadLocalPhoto(botToken, chatId, filePath, caption, options = {}) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const fileBuffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const boundary = 'WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n`),
    ];
    if (caption) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`));
    }
    if (options.topicId) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${options.topicId}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    
    const body = Buffer.concat(parts);
    
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Telegram API Error: ${res.statusCode} - ${data}`));
        } else {
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Envia multiples fotos juntas en un solo mensaje (media group).
 * Soporta URLs remotas y archivos locales.
 * Solo el primer elemento lleva caption (limite de Telegram).
 */
/**
 * Envia un group de fotos a un chat específico.
 * @param {string|number} chatId - ID del chat
 * @param {string[]} photos - URLs o paths locales
 * @param {string} [caption] - Pie del primer elemento
 * @param {object} [options] - Opciones adicionales
 * @param {number} [options.topicId] - message_thread_id para topics en foros
 */
async function sendMediaGroupToChat(chatId, photos, caption, options = {}) {
  const { botToken } = config.telegram;
  if (!botToken || !chatId) return;
  if (!photos || photos.length === 0) return;
  if (photos.length === 1) {
    return sendTelegramPhotoToChat(chatId, photos[0], caption, options);
  }

  const isRemote = typeof photos[0] === 'string' && (photos[0].startsWith('http://') || photos[0].startsWith('https://'));

  if (isRemote) {
    try {
      const payload = {
        chat_id: chatId,
        media: photos.map((url, i) => ({
          type: 'photo',
          media: url,
          ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
        })),
      };
      if (options.topicId) payload.message_thread_id = options.topicId;
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, payload, { timeout: 30000 });
      logger.debug(`Media group enviado a chat ${chatId}.`);
    } catch (err) {
      logger.warn(`Error enviando media group a ${chatId}: ${err.message}`);
    }
  } else {
    try {
      await uploadLocalMediaGroup(botToken, chatId, photos, caption, options);
      logger.debug(`Media group local enviado a chat ${chatId}.`);
    } catch (err) {
      logger.warn(`Error enviando media group local a ${chatId}: ${err.message}`);
    }
  }
}

/**
 * Envia un media group al chat principal (legacy).
 */
async function sendMediaGroup(photos, caption) {
  const { chatId } = config.telegram;
  if (!chatId) return;
  await sendMediaGroupToChat(chatId, photos, caption);
}

function uploadLocalMediaGroup(botToken, chatId, filePaths, caption) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const boundary = 'WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const maxPhotos = Math.min(filePaths.length, 3);

    const media = filePaths.slice(0, maxPhotos).map((_, i) => ({
      type: 'photo',
      media: `attach://file${i}`,
      ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
    }));

    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(media)}\r\n`),
    ];

    for (let i = 0; i < maxPhotos; i++) {
      const fileBuffer = fs.readFileSync(filePaths[i]);
      const filename = path.basename(filePaths[i]);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file${i}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`));
      parts.push(fileBuffer);
      parts.push(Buffer.from(`\r\n`));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMediaGroup`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// BROADCAST - Envia a todos los destinos configurados
// ═══════════════════════════════════════════════════════════════

/**
 * Envia un post (texto + imágenes) a todos los destinos configurados.
 * Soporta destinos con topicId para foros de Telegram.
 */
async function broadcastPost(post) {
  const chatIds = config.telegramDestinations.postChatIds;
  if (!chatIds || chatIds.length === 0) return;

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

  const postMsg = text
    ? `${authorLink}\n\n${text}${publicLink}${videoLinks}`
    : `${authorLink}${publicLink}${videoLinks}`;

  for (const dest of chatIds) {
    const chatId = typeof dest === 'object' ? dest.chatId : dest;
    const options = typeof dest === 'object' ? { topicId: dest.topicId } : {};
    try {
      if (post.images && post.images.length > 0) {
        await sendMediaGroupToChat(chatId, post.images, postMsg, options);
      } else {
        await sendTelegramToChat(chatId, postMsg, options);
      }
    } catch (err) {
      logger.warn(`Error enviando post a chat ${chatId}: ${err.message}`);
    }
  }
}

/**
 * Envia un mensaje de texto a todos los chats de posts.
 */
async function broadcastMessage(message) {
  if (!message) return;
  const chatIds = config.telegramDestinations.postChatIds;
  for (const dest of chatIds) {
    const chatId = typeof dest === 'object' ? dest.chatId : dest;
    const options = typeof dest === 'object' ? { topicId: dest.topicId } : {};
    await sendTelegramToChat(chatId, message, options);
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
  loadPublicationState,
  savePublicationState,
  claimPublicationSlot,
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
  sendTelegramPhoto,
  sendTelegramToChat,
  sendTelegramPhotoToChat,
  sendMediaGroup,
  sendMediaGroupToChat,
  broadcastPost,
  broadcastMessage,
  cleanup,
};
