const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const {
  sleep,
  loadCookies,
  cookiesToHeader,
  mergeCookies,
  saveCookies,
  getRandomUserAgentProfile,
  retryWithBackoff,
  filterValidImages,
  isValidContent,
  isValidUrl,
  isFbSpinnerOrIcon,
  triggerCooldown,
} = require('./helpers');
const {
  createBrowserLikeHttpsAgent,
  getProxyUrl,
  getCurrentProxyUrl,
} = require('./tls');
const db = require('./db');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

function getImageDimensionsFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;

  // PNG
  if (buffer.length >= 24 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF
  if (buffer.length >= 10 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }

      let marker = buffer[offset + 1];
      while (marker === 0xff && offset + 1 < buffer.length) {
        offset++;
        marker = buffer[offset + 1];
      }

      if (marker === 0xd9 || marker === 0xda) break;
      const blockLength = buffer.readUInt16BE(offset + 2);
      if (blockLength < 2 || offset + 2 + blockLength > buffer.length) break;

      const sof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (sof && offset + 9 < buffer.length) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }

      offset += 2 + blockLength;
    }
  }

  return null;
}

function isImageBelowMinimumDimensions(dimensions) {
  if (!dimensions || !dimensions.width || !dimensions.height) return false;
  const minWidth = Math.max(1, config.scraping.minImageWidth || 180);
  const minHeight = Math.max(1, config.scraping.minImageHeight || 180);
  const minPixels = Math.max(1, config.scraping.minImagePixels || 40000);
  const pixels = dimensions.width * dimensions.height;
  return dimensions.width < minWidth || dimensions.height < minHeight || pixels < minPixels;
}

class FacebookScraper {
  constructor(batchId) {
    this.batchId = batchId;
    this.cookies = null;
    this.cookieHeader = '';
    this._uaProfile = getRandomUserAgentProfile();
    this._httpsAgent = null;
    this.stats = {
      postsNew: 0,
      postsUpdated: 0,
      postsSkipped: 0,
      postsFailed: 0,
      pagesScraped: 0,
      errors: 0,
      newPosts: [],
      sessionLost: false,   // Indica si la sesion se perdio durante el scraping
    };
    this.shouldStop = false;
    this.totalPostsProcessed = 0;
    this._lastContent = '';
    this._postCountSinceDistraction = 0;
    this._seenStoryIds = new Set();
    this._rateLimitHits = 0;
    this._thumbnailWarned = false;
    this._compressionWarned = false;
  }

  async init() {
    this.cookies = loadCookies();
    if (!this.cookies) throw new Error('No se pudieron cargar las cookies.');
    this.cookieHeader = cookiesToHeader(this.cookies);

    // Validar cookies criticas (Facebook las requiere para identificar sesion real)
    const criticalCookies = ['datr', 'c_user', 'xs', 'sb'];
    const cookieNames = new Set(this.cookies.map(c => c.name || c.key));
    const missing = criticalCookies.filter(c => !cookieNames.has(c));
    if (missing.length > 0) {
      logger.warn(`Cookies criticas ausentes: ${missing.join(', ')}. La sesion podria ser debil.`);
    }
    // Verificar que las cookies no esten expiradas
    const now = Date.now() / 1000;
    for (const c of this.cookies) {
      if (c.expires && typeof c.expires === 'number' && c.expires < now) {
        logger.warn(`Cookie "${c.name || c.key}" expirada (${new Date(c.expires * 1000).toISOString()}). La sesion podria fallar.`);
      }
    }

    this._uaProfile = getRandomUserAgentProfile();
    // Crear agente TLS con fingerprint similar a navegador (+ proxy si hay)
    const proxyUrl = getProxyUrl();
    this._httpsAgent = createBrowserLikeHttpsAgent(proxyUrl);
    const proxyLabel = proxyUrl ? ` (proxy: ${proxyUrl.split('@').pop()})` : '';
    logger.info(`Sesión iniciada. UA: ${this._uaProfile.ua.substring(0, 60)}...${proxyLabel}`);
  }

  _getHumanHeaders() {
    // Rotar perfil cada N requests para simular cambios de sesion/navegador
    // pero mantener consistencia dentro de una misma "pagina"
    const profile = this._uaProfile;

    const lang = config.headerVariants.acceptLanguage[
      Math.floor(Math.random() * config.headerVariants.acceptLanguage.length)
    ];
    const accept = config.headerVariants.accept[
      Math.floor(Math.random() * config.headerVariants.accept.length)
    ];

    const headers = {
      'User-Agent': profile.ua,
      'Accept': accept,
      'Accept-Language': lang,
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': Math.random() > 0.5 ? 'max-age=0' : 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Cookie': this.cookieHeader,
      'Referer': 'https://www.facebook.com/',
      // Prioridad de recursos (Chrome 101+)
      'Priority': 'u=0, i',
    };

    // Chrome 84+ envia SIEMPRE estos headers. Su ausencia = bot flag.
    if (profile.secChUa) {
      headers['Sec-Ch-Ua'] = profile.secChUa;
      headers['Sec-Ch-Ua-Mobile'] = profile.secChUaMobile;
      headers['Sec-Ch-Ua-Platform'] = profile.secChUaPlatform;
    }

    // Client Hints de viewport (Chrome las envia en main frame requests)
    if (profile.viewportWidth) {
      headers['Viewport-Width'] = String(profile.viewportWidth);
    }
    if (profile.devicePixelRatio) {
      headers['DPR'] = String(profile.devicePixelRatio);
    }

    return headers;
  }

  get headers() {
    return this._getHumanHeaders();
  }

  async healthCheck() {
    logger.info('Ejecutando health check...');
    try {
      const resp = await axios.get(config.fb.profileUrl, {
        headers: this.headers,
        timeout: config.scraping.requestTimeoutMs,
        maxRedirects: 0,
        validateStatus: (s) => s < 400,
        httpsAgent: this._httpsAgent,
        httpAgent: this._httpsAgent,
      });
      this._processSetCookies(resp.headers['set-cookie']);
      const html = resp.data;
      if (this._detectLoginPage(html)) throw new Error('SESSION_EXPIRED');
      if (this._detectCheckpoint(html)) throw new Error('CHECKPOINT_REQUIRED');
      logger.info('Health check OK. Sesión activa.');
      return true;
    } catch (err) {
      if (err.response && (err.response.status === 302 || err.response.status === 403)) {
        triggerCooldown('SESSION_EXPIRED');
        throw new Error('SESSION_EXPIRED');
      }
      if (err.message === 'SESSION_EXPIRED' || err.message === 'CHECKPOINT_REQUIRED') {
        triggerCooldown(err.message);
        throw err;
      }
      logger.error(`Health check error: ${err.message}`);
      throw err;
    }
  }

  async scrape() {
    const feedUrls = config.fb.feedUrls || [config.fb.homeUrl];
    let totalPagesScraped = 0;

    // Simular que el usuario llego a la pagina principal primero (warm-up)
    logger.info('Calentando sesion: visitando homepage...');
    try {
      await this._fetchPage('https://www.facebook.com/');
      const settlingMs = 1500 + Math.floor(Math.random() * 2500);
      await sleep(settlingMs);
      logger.info('Homepage cargada. Iniciando scraping de feeds.');
    } catch (err) {
      logger.warn(`Warm-up homepage fallo: ${err.message}. Continuando...`);
    }

    for (let fi = 0; fi < feedUrls.length && !this.shouldStop; fi++) {
      const feedUrl = feedUrls[fi];
      let currentUrl = feedUrl;
      let feedPages = 0;

      logger.info(`Feed ${fi + 1}/${feedUrls.length}: ${currentUrl}`);

      while (totalPagesScraped < config.scraping.maxPages && !this.shouldStop) {
        logger.info(`Scrapeando página ${totalPagesScraped + 1} (feed #${fi + 1} pág ${feedPages + 1}): ${currentUrl}`);

        let html;
        try {
          html = await this._fetchPage(currentUrl);
        } catch (err) {
          if (err.response && err.response.status === 429) {
            this._rateLimitHits++;
            logger.warn(`Rate limit HTTP 429 detectado (hit ${this._rateLimitHits}).`);
            this.stats.errors++;
            await db.logError(this.batchId, null, 'HTTP 429 Too Many Requests', 'rate_limit', currentUrl);
            if (this._rateLimitHits >= 3) {
              logger.crit('Demasiados rate limits. Activando cooldown extendido.');
              triggerCooldown('RATE_LIMITED');
              this.shouldStop = true;
            }
            const backoff = config.scraping.minDelayMs * (2 + this._rateLimitHits);
            logger.debug(`Backoff de ${backoff}ms por rate limiting...`);
            await sleep(backoff);
            break;
          }
          logger.error(`Error cargando página: ${err.message}`);
          this.stats.errors++;
          await db.logError(this.batchId, null, err.message, 'page_fetch_error', currentUrl);
          break;
        }

        if (this._detectLoginPage(html) || this._detectCheckpoint(html)) {
          this.stats.sessionLost = true;
          triggerCooldown('SESSION_LOST_DURING_SCRAPE');
          this.shouldStop = true;
          break;
        }

        // Simular tiempo de "settling" después de cargar la página
        const settlingMs = config.human.pageSettlingMin +
          Math.floor(Math.random() * (config.human.pageSettlingMax - config.human.pageSettlingMin));
        logger.debug(`  → Página cargada. "Mirando" por ${settlingMs}ms...`);
        await sleep(settlingMs);

        // Extraer posts del SSR JSON
        const posts = this._extractPostsFromSSR(html);
        logger.info(`  → ${posts.length} posts extraídos del SSR.`);

        for (let i = 0; i < posts.length; i++) {
          if (this.shouldStop) break;
          if (this.totalPostsProcessed >= config.scraping.maxPostsPerRun) {
            logger.info(`Límite de ${config.scraping.maxPostsPerRun} posts alcanzado.`);
            this.shouldStop = true;
            break;
          }

          try {
            await this._processPostData(posts[i]);
          } catch (err) {
            logger.error(`Error procesando post: ${err.message}`);
            this.stats.postsFailed++;
            this.stats.errors++;
          }

          if (i < posts.length - 1 && !this.shouldStop) {
            await this._humanPostDelay(this._lastContent);
            await this._maybeDistractionPause();
          }
        }

        totalPagesScraped++;
        feedPages++;
        this.stats.pagesScraped = totalPagesScraped;

        if (!this.shouldStop) {
          const nextUrl = this._extractNextPageUrl(html, currentUrl);
          if (nextUrl) {
            currentUrl = nextUrl;
            // Rotar perfil de UA entre paginas (cambia sec-ch-ua, viewport, etc.)
            this._rotateProfile();
            const delay = this._naturalDelay(config.scraping.minDelayMs, config.scraping.maxDelayMs);
            logger.debug(`Pausa de ${delay}ms antes de siguiente página...`);
            await sleep(delay);
          } else {
            logger.info(`No se encontró enlace de siguiente página para feed ${feedUrl}.`);
            break;
          }
        }
      }

      if (fi < feedUrls.length - 1 && !this.shouldStop) {
        const delay = this._naturalDelay(config.scraping.minDelayMs, config.scraping.maxDelayMs);
        logger.debug(`Pausa de ${delay}ms antes del siguiente feed...`);
        await sleep(delay);
      }
    }

    logger.info(`Scraping finalizado. ${this.totalPostsProcessed} posts procesados en ${totalPagesScraped} páginas.`);
    return this.stats;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXTRACCIÓN DESDE SSR JSON DE www.facebook.com
  // ═══════════════════════════════════════════════════════════════

  _extractPostsFromSSR(html) {
    const blobs = [];
    const pattern = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        const content = match[1];
        // Solo procesar blobs que contengan datos de feed (comet_sections, story_bucket, o message)
        if (content.includes('story_bucket') || content.includes('comet_sections')) {
          blobs.push(content);
        }
      } catch { /* skip */ }
    }

    const allPosts = [];

    for (const blob of blobs) {
      // Extraer todos los bloques story completos
      // Un story es un objeto con id (Uzpf...), comet_sections con actor_photo, y puede tener message
      const stories = this._parseStoriesFromBlob(blob);
      for (const story of stories) {
        if (story.author_name && story.author_name !== 'Unknown') {
          // Validar que tenga contenido real
          if (story.text || (story.images && story.images.length > 0)) {
            // Filtrar textos del sistema
            if (!/^Solicitud para participar|^Cualquier persona puede ver/i.test(story.text || '')) {
              allPosts.push(story);
            }
          }
        }
      }
    }

    // Deduplicar por story_id
    const seen = new Set();
    return allPosts.filter(p => {
      if (seen.has(p.story_id)) return false;
      seen.add(p.story_id);
      return true;
    });
  }

  /**
   * Parsea stories del JSON crudo de un blob usando regex para encontrar
   * los datos relevantes sin caminar todo el árbol.
   */
  _parseStoriesFromBlob(blobStr) {
    const stories = [];

    // Encontrar todos los IDs de story (formato Uzpf... o S:_I...)
    const storyIdPattern = /"id":"(Uzpf[A-Za-z0-9_=-]{10,}|S:_I[A-Za-z0-9_=-]{10,})"/g;
    const storyIds = new Set();
    let idMatch;
    while ((idMatch = storyIdPattern.exec(blobStr)) !== null) {
      storyIds.add(idMatch[1]);
    }

    for (const storyId of storyIds) {
      try {
        // Buscar el nombre del autor asociado a este story_id
        // El autor está en: "name":"..." cerca de "story_bucket":{"nodes":[{"id":"<storyId>"}]
        // Pero el story_bucket.nodes[0].id NO es el mismo que story.id
        // En su lugar, buscar "name" que precede a "story_bucket" en el JSON
        
        // Enfoque: buscar por el ID de nodo en story_bucket 
        // story_bucket.nodes[0].id contiene el ID para matchear con los actores
        const nodeIdPattern = /"story_bucket":\{"nodes":\[\{"[^"]*":"[^"]*","id":"(\d+)"/g;
        let authorName = null;
        let authorUrl = null;
        let authorPic = null;
        let authorId = null;
        let groupName = null;
        let groupUrl = null;
        let nodeIdMatch;

        // Buscar todos los actores y guardar sus datos
        const actorMap = new Map(); // node_id → actor data
        
        // Encontrar actors: "name":"...", "url":"...facebook.com...", "profile_picture":{"uri":"..."}
        const actorRegex = /"name":"([^"]{2,80})"[^}]*?"url":"((?:https?:)?\\\/\\\/www\.facebook\.com\\\/[^"]+)"[^}]*?"profile_picture":\{"uri":"([^"]+)"/g;
        let actorMatch;
        while ((actorMatch = actorRegex.exec(blobStr)) !== null) {
          const name = this._decodeJsonText(actorMatch[1]);
          const url = actorMatch[2].replace(/\\\//g, '/');
          const pic = actorMatch[3].replace(/\\\//g, '/');
          
          if (!/Bundle|Worker|display|order|className|everyone|checksum|like|love|haha|wow|sad|angry/.test(name)) {
            // Encontrar el node_id asociado buscando "story_bucket" después de este actor
            const afterActor = blobStr.substring(actorMatch.index);
            const nodeMatch = afterActor.match(/"story_bucket":\{"nodes":\[\{[^}]*"id":"(\d+)"/);
            // Extraer el id del actor (facebook numeric id)
            const nearActor = blobStr.substring(Math.max(0, actorMatch.index - 100), actorMatch.index + 500);
            const authorIdMatch = nearActor.match(/"id":"(\d{5,30})"/);
            if (nodeMatch) {
              const nodeId = nodeMatch[1];
              actorMap.set(nodeId, { name, url, pic, id: authorIdMatch ? authorIdMatch[1] : null });
            }
          }
        }

        // Encontrar el texto del mensaje para este story_id
        let text = '';
        // Buscar en: comet_sections:{...message:{story:{message:{text:"..."}}}}
        const storyIdx = blobStr.indexOf(storyId);
        if (storyIdx >= 0) {
          // Buscar el message más cercano a este storyId
          const afterStory = blobStr.substring(storyIdx);
          const msgMatch = afterStory.match(/"message":\{"text":"((?:[^"\\]|\\[^])+)"/);
          if (msgMatch) {
            text = this._decodeJsonText(msgMatch[1]);
          }
        }

        // Encontrar group name - buscar "to":{"name":...} o "to":{"__typename":"Group","name":...}
        const groupRegex = /"to":\{[^}]*?"name":"([^"]+)"/g;
        let groupMatch;
        let closestGroupDist = Infinity;
        while ((groupMatch = groupRegex.exec(blobStr)) !== null) {
          const dist = Math.abs(groupMatch.index - storyIdx);
          if (dist < closestGroupDist) {
            closestGroupDist = dist;
            groupName = this._decodeJsonText(groupMatch[1]);
            // Buscar el group id cerca
            const nearbyGroup = blobStr.substring(groupMatch.index, Math.min(blobStr.length, groupMatch.index + 300));
            const gidMatch = nearbyGroup.match(/"id":"(\d+)"/);
            if (gidMatch) {
              groupUrl = gidMatch[1];
            }
          }
        }

        // Encontrar el autor para este story buscando por node_id
        // El node_id está en story_bucket.nodes del actor asociado a este story
        // O podemos buscar el actor más cercano al story_id en el JSON
        let author = null;
        // Buscar cualquier nombre de actor cerca de este story_id
        const actorNameRegex = /"name":"([^"]{2,80})"/g;
        let anMatch;
        while ((anMatch = actorNameRegex.exec(blobStr)) !== null) {
          const name = this._decodeJsonText(anMatch[1]);
            if (!/Bundle|Worker|display|order|className|everyone|checksum|like|love|haha|wow|sad|angry|connection_quality|latency_level|is_ad|content_category|streaming_implementation|is_latency_sensitive|fbls_tier|is_live|GLOBAL|WAWeb|MAW|FileHash|Canvas|VideoPlayer|MWChat/.test(name)) {
            const dist = Math.abs(anMatch.index - storyIdx);
            if (!author || dist < author.dist) {
              // Verificar si este nombre está cerca de un url de perfil de facebook
              const nearby = blobStr.substring(Math.max(0, anMatch.index - 200), Math.min(blobStr.length, anMatch.index + 500));
              const urlMatch = nearby.match(/"url":"((?:https?:)?\\\/\\\/www\.facebook\.com\\\/[^"]+)"/);
              const picMatch = nearby.match(/"profile_picture":\{"uri":"([^"]+)"/);
              const idMatch = nearby.match(/"id":"(\d{5,30})"/);
              if (urlMatch) {
                author = { 
                  name, 
                  url: urlMatch[1].replace(/\\\//g, '/'),
                  pic: picMatch ? picMatch[1].replace(/\\\//g, '/') : null,
                  id: idMatch ? idMatch[1] : null,
                  dist 
                };
              }
            }
          }
        }

        if (author) {
          authorName = author.name;
          authorUrl = author.url;
          authorPic = author.pic;
          authorId = author.id || null;
        }

        // Construir el post si tiene datos suficientes
        if (authorName || text) {
          // Extraer medios y metadata asociada a este story dentro del SSR cercano.
          const images = this._extractImagesFromBlob(blobStr, storyIdx, authorPic);
          const videos = this._extractVideosFromBlob(blobStr, storyIdx);
          const postLink = this._extractPostLinkFromBlob(blobStr, storyIdx);
          const postId = this._extractPostIdFromBlob(blobStr, storyIdx);
          const timestamp = this._extractTimestampFromBlob(blobStr, storyIdx);

          stories.push({
            story_id: storyId,
            author_name: authorName || 'Unknown',
            author_id: authorId || null,
            author_profile_url: authorUrl,
            author_profile_pic: authorPic,
            group_name: groupName,
            group_url: groupUrl,
            text: text || '',
            images: images,
            videos: videos,
            post_link: postLink,
            post_id: postId,
            post_timestamp: timestamp,
            raw_story_id: storyId,
          });
        }

      } catch (e) {
        logger.debug('Error parsing story ' + storyId + ': ' + e.message);
      }
    }

    return stories;
  }

  /**
   * Extrae URLs de imagenes del blob JSON cerca de un story.
   * Deduplica por imagen base (misma imagen en distintas resoluciones se agrupan).
   */
  _extractImagesFromBlob(blobStr, storyIdx, authorPicUrl = null) {
    const dedupMap = new Map(); // baseKey → { url, score }
    const normalizedAuthorPic = authorPicUrl ? this._getImageDedupKey(authorPicUrl) : null;

    const start = Math.max(0, storyIdx - 12000);
    const end = Math.min(blobStr.length, storyIdx + 70000);
    const nearby = blobStr.substring(start, end);

    const patterns = [
      /"(?:uri|url)":"(https?:\\\/\\\/(?:scontent|[^\"]*fbcdn)[^\"]*\.(?:jpg|jpeg|png|webp)[^\"]*)"/gi,
      /"(?:image|large_image|preview_image|preferred_thumbnail|background_image|photo_image)":\{[^}]*?"uri":"(https?:\\\/\\\/[^\"]+)"/gi,
      /"(?:image|large_image|preview_image|preferred_thumbnail|background_image|photo_image)":\{[^}]*?"url":"(https?:\\\/\\\/[^\"]+)"/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(nearby)) !== null) {
        const url = this._decodeJsonUrl(match[1]);
        if (!url || isFbSpinnerOrIcon(url) || !isValidUrl(url)) continue;
        if (!this._isPostImageUrl(url)) continue;

        const key = this._getImageDedupKey(url);
        
        // Ignorar si la imagen base coincide con el avatar del autor
        if (normalizedAuthorPic && key === normalizedAuthorPic) continue;

        const score = this._imageScore(url);
        // Quedarse con la mejor resolucion para cada imagen base
        if (!dedupMap.has(key) || score > dedupMap.get(key).score) {
          dedupMap.set(key, { url, score });
        }
      }
    }

    return Array.from(dedupMap.values())
      .sort((a, b) => b.score - a.score)
      .map(v => v.url);
  }

  /**
   * Normaliza una URL de imagen para identificar la misma imagen en distintas resoluciones.
   */
  _getImageDedupKey(url) {
    const base = url.split('?')[0]; // Quitar query params
    const segments = base.split('/');
    const filename = segments[segments.length - 1] || base;
    // Quitar sufijos de tamano comunes de Facebook: _s750x750_n, _1080x1080_n, _o, _n
    return filename
      .replace(/_s?\d{2,4}x\d{2,4}(_n)?/gi, '')  // _s750x750_n, _1080x1080_n
      .replace(/_n\./gi, '.')                       // _n.jpg → .jpg
      .replace(/_o\./gi, '.')                       // _o.jpg → .jpg
      .replace(/_\d+x\d+(_n)?\./gi, '.');           // Fallback general
  }

  _extractVideosFromBlob(blobStr, storyIdx) {
    const videos = [];
    const seen = new Set();
    const start = Math.max(0, storyIdx - 8000);
    const end = Math.min(blobStr.length, storyIdx + 40000);
    const nearby = blobStr.substring(start, end);

    const patterns = [
      /"(?:playable_url_quality_hd|playable_url|playable_url_dash|browser_native_hd_url|browser_native_sd_url|hd_src|sd_src|hd_src_no_ratelimit|sd_src_no_ratelimit|video_url)":"(https?:\\\/\\\/[^\"]+)"/gi,
      /"(?:url|href|wwwURL|permalink_url|shareURL)":"(https?:\\\/\\\/www\.facebook\.com\\\/[^\"]*(?:watch|video|videos|reel)[^\"]*)"/gi,
      /"(?:url|href|wwwURL|permalink_url|shareURL)":"(\\\/[^\"]*(?:watch|video|videos|reel)[^\"]*)"/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(nearby)) !== null) {
        this._pushVideoUrl(videos, seen, match[1]);
      }
    }

    const videoIdPatterns = [
      /"(?:video_id|videoID)":"(\d{5,30})"/gi,
      /"__typename":"Video"[^}]{0,600}?"id":"(\d{5,30})"/gi,
      /"video":\{[^}]{0,800}?"id":"(\d{5,30})"/gi,
    ];

    for (const pattern of videoIdPatterns) {
      let match;
      while ((match = pattern.exec(nearby)) !== null) {
        this._pushVideoUrl(videos, seen, `https://www.facebook.com/watch/?v=${match[1]}`);
      }
    }

    return videos;
  }

  _extractPostLinkFromBlob(blobStr, storyIdx) {
    const start = Math.max(0, storyIdx - 4000);
    const end = Math.min(blobStr.length, storyIdx + 12000);
    const nearby = blobStr.substring(start, end);
    const patterns = [
      /"(?:url|wwwURL|permalink_url|shareURL)":"(https?:\\\/\\\/www\.facebook\.com\\\/[^\"]*(?:story\.php|permalink|posts|photo\.php|video\.php|reel|watch|videos)[^\"]*)"/i,
      /"(?:url|wwwURL|permalink_url|shareURL)":"(\\\/groups\\\/[^\"]*\\\/(?:posts|permalink)\\\/[^\"]+)"/i,
      /"(?:url|wwwURL|permalink_url|shareURL)":"(\\\/[^\"]*\\\/(?:permalink|posts|videos)\\\/[^\"]+)"/i,
    ];

    for (const pattern of patterns) {
      const match = nearby.match(pattern);
      if (match) {
        const url = this._decodeJsonUrl(match[1]);
        return url.startsWith('/') ? config.fb.baseUrl + url : url;
      }
    }
    return null;
  }

  _extractPostIdFromBlob(blobStr, storyIdx) {
    const start = Math.max(0, storyIdx - 4000);
    const end = Math.min(blobStr.length, storyIdx + 12000);
    const nearby = blobStr.substring(start, end);
    const match = nearby.match(/"post_id":"(\d+)"/);
    return match ? match[1] : null;
  }

  _extractTimestampFromBlob(blobStr, storyIdx) {
    const start = Math.max(0, storyIdx - 4000);
    const end = Math.min(blobStr.length, storyIdx + 12000);
    const nearby = blobStr.substring(start, end);
    const unixMatch = nearby.match(/"(?:creation_time|publish_time|timestamp|creation_timestamp)":(\d{10})/i);
    if (unixMatch) return new Date(parseInt(unixMatch[1], 10) * 1000).toISOString();

    const textMatch = nearby.match(/"(?:publish_time_text|creation_time_text|timestamp_text)":\{?"text":"((?:[^"\\]|\\[^])+)"/i);
    if (textMatch) return this._decodeJsonText(textMatch[1]);
    return null;
  }

  _pushMediaUrl(target, seen, rawUrl, type) {
    const url = this._decodeJsonUrl(rawUrl);
    if (!url || seen.has(url) || isFbSpinnerOrIcon(url) || !isValidUrl(url)) return;
    if (type === 'image' && !this._isPostImageUrl(url)) return;
    if (type === 'video' && !this._isVideoUrl(url)) return;
    seen.add(url);
    target.push(url);
  }

  _pushVideoUrl(target, seen, rawUrl) {
    const decoded = this._decodeJsonUrl(rawUrl);
    const url = decoded.startsWith('/') ? config.fb.baseUrl + decoded : decoded;
    if (!url || seen.has(url) || !isValidUrl(url) || !this._isVideoUrl(url)) return;
    seen.add(url);
    target.push(url);
  }

  _decodeJsonUrl(rawUrl) {
    if (!rawUrl) return '';
    return rawUrl
      .replace(/\\\//g, '/')
      .replace(/\\u002f/gi, '/')
      .replace(/\\u003a/gi, ':')
      .replace(/\\u0025/gi, '%')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u003d/gi, '=')
      .replace(/&amp;/g, '&');
  }

  _decodeJsonText(rawText) {
    return rawText
      .replace(/\\\//g, '/')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
  }

  _isPostImageUrl(url) {
    const hasImageExt = /\.(jpg|jpeg|png|webp)(?:\?|$)/i.test(url);
    const hasFbImageHints = /(?:[?&](?:stp|ext|_nc_cat|_nc_ht)=|dst-(?:jpe?g|png|webp)|format=(?:jpe?g|png|webp))/i.test(url);
    if (!hasImageExt && !hasFbImageHints) return false;
    if (/(?:profile|avatar|emoji|sticker|reaction|static)/i.test(url)) return false;
    // Extraer dimensiones de la URL (ej: /p160x160/ o _160x160_)
    const dimMatch = url.match(/(?:\/|_)[ps]?(\d{2,4})x(\d{2,4})(?:\/|_|\.)/i);
    if (dimMatch) {
      const w = parseInt(dimMatch[1], 10);
      const h = parseInt(dimMatch[2], 10);
      // Bloquear cualquier imagen que sea inferior a 250x250 (usualmente iconos o avatares)
      if (w < 250 && h < 250) return false;
      
      // Ignorar imágenes "banner" o "cover" (típicas portadas de grupos o perfiles)
      // Tienen un ancho muy grande (>= 800) y una altura mucho menor (ratio > 2.5)
      if (w >= 800 && (w / h) > 2.2) return false;
    }
    return /scontent|fbcdn|safe_image/i.test(url);
  }

  _isVideoUrl(url) {
    return /\.mp4(?:\?|$)|video\.[^/]*fbcdn|fbcdn.*video|facebook\.com\/(?:watch|reel|video\.php|video_redirect|.*\/videos?\/|.*[?&]v=)/i.test(url);
  }

  _imageScore(url) {
    const dims = url.match(/_(?:p)?(\d{2,4})x(\d{2,4})/i);
    if (dims) return parseInt(dims[1], 10) * parseInt(dims[2], 10);
    if (/\boh=|\bstp=|\boe=/.test(url)) return 1000000;
    return 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXTRACCION DE TAGS
  // ═══════════════════════════════════════════════════════════════

  _extractTags(text) {
    if (!text) return [];

    const stopwords = new Set([
      'de','la','el','los','las','que','en','un','una','por','para','con','no','se','su','al','del','lo',
      'como','mas','pero','sus','le','ya','este','cuando','muy','sin','sobre','tambien','me','hasta',
      'donde','todo','nos','ha','dos','mi','tu','te','ni','es','si','fue','son','era','mis','cada',
      'otro','entre','porque','esto','solo','asi','tan','desde','tiene','ser','hacer','todos','tiempo',
      'puede','estan','ahora','despues','antes','siendo','estaba','estaban','tienen','tuvo',
      'eso','ahi','alli','aqui','ella','ellos','ellas','alguien','dia','ano','hace','hecho','parte',
      'manera','vez','forma','tipo','caso','durante','hacia','mientras','ademas','poco','mucho','gran',
      'buen','ese','esa','esos','esas','otra','otras','cual','cuales','tus','nuestro','nuestra',
      'suyo','suya','tener','estar','haber','dijo','dice','hizo'
    ]);

    const priorityWords = new Set(['promo','compro','vendo','permuto']);

    const words = text
      .toLowerCase()
      .replace(/https?:\/\/\S+|www\.\S+/gi, '')
      .replace(/[^a-záéíóúñ\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !stopwords.has(w) && !/^\d+$/.test(w));

    const seen = new Set();
    const priority = [];
    const normal = [];

    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      if (priorityWords.has(w)) {
        priority.push(w);
      } else {
        normal.push(w);
      }
    }

    // Ordenar normales por largo descendente (palabras mas largas = mas significativas)
    normal.sort((a, b) => b.length - a.length);

    return priority.concat(normal).slice(0, 4);
  }

  // ═══════════════════════════════════════════════════════════════
  // PROCESS POST & SAVE
  // ═══════════════════════════════════════════════════════════════

  async _processPostData(post) {
    if (!post.text && (!post.images || post.images.length === 0) && (!post.videos || post.videos.length === 0)) {
      this.stats.postsSkipped++;
      return;
    }

    this._lastContent = post.text;

    // Descargar imágenes si está activado
    let imagePaths = post.images || [];
    if (config.scraping.downloadImages && imagePaths.length > 0) {
      imagePaths = await this._downloadImages(post.group_name || post.story_id, imagePaths);
      // Convertir paths locales a URLs públicas
      const imageDir = path.resolve(config.scraping.imageDir);
      const publicBase = config.scraping.imagePublicBaseUrl.replace(/\/+$/, '');
      imagePaths = imagePaths.map(p => {
        // Si ya es URL (http/https), dejarla como está
        if (p.startsWith('http://') || p.startsWith('https://')) return p;
        // Normalizar path (Windows \\ -> /)
        const absPath = path.resolve(p).replace(/\\/g, '/');
        const normalizedDir = imageDir.replace(/\\/g, '/').replace(/\/+$/, '');
        // Si el path tiene /public_html/images/... extraer la parte relativa después de /images/
        const pubMatch = absPath.match(/\/images\/(.+)$/);
        if (pubMatch) {
          return publicBase + '/' + pubMatch[1];
        }
        // Si empieza con normalizedDir
        if (absPath.startsWith(normalizedDir + '/')) {
          const relative = absPath.substring(normalizedDir.length + 1);
          return publicBase + '/' + relative;
        }
        if (absPath.startsWith(normalizedDir)) {
          const relative = absPath.substring(normalizedDir.length).replace(/^\//, '');
          return publicBase + '/' + relative;
        }
        // Si empieza con images/ (relativo)
        if (p.startsWith('images/')) {
          return publicBase + '/' + p;
        }
        // Fallback: devolver el path original
        return p;
      });
    }

    if (!post.text && (!imagePaths || imagePaths.length === 0) && (!post.videos || post.videos.length === 0)) {
      this.stats.postsSkipped++;
      logger.debug('  Post descartado: sin contenido útil tras filtrar imágenes de baja resolución.');
      return;
    }

    logger.debug(`  Medios detectados: ${imagePaths.length} imagen(es), ${(post.videos || []).length} video(s).`);

    // id_unico: author_id + mes + semana_mes + primeros_20_chars_limpios_del_contenido
    const cleanText = (post.text || '')
      .replace(/\s+/g, '')
      .replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]/g, '')
      .substring(0, 20);
    const uidAuthor = post.author_id || '0';
    const tsDate = post.post_timestamp ? new Date(post.post_timestamp) : new Date();
    const month = tsDate.getUTCMonth() + 1;
    const weekOfMonth = Math.ceil(tsDate.getUTCDate() / 7);
    const idUnico = `${uidAuthor}${month}${weekOfMonth}${cleanText}`;

    const postData = {
      id_unico: idUnico,
      author_name: post.author_name,
      author_id: post.author_id || null,
      group_name: post.group_name,
      group_url: post.group_url,
      content: post.text,
      content_hash: crypto.createHash('sha256').update(JSON.stringify({
        text: post.text || '',
        images: imagePaths,
        videos: post.videos || [],
        timestamp: post.post_timestamp || null,
      })).digest('hex'),
      images: imagePaths,
      video_links: post.videos || [],
      tags: this._extractTags(post.text),
      post_url: (() => {
        if (post.post_id) return post.post_id;
        const link = post.post_link || '';
        const m = link.match(/\/(?:posts|permalink|videos|reel|photo\.php\?fbid=|story\.php\?story_fbid=)(\d+)/);
        return m ? m[1] : null;
      })(),
    };

    if (config.dryRun) {
      const groupLabel = postData.group_name ? `[${postData.group_name}] ` : '';
      logger.info(`  [DRY RUN] Post ${idUnico.substring(0, 18)}... ${groupLabel}por ${postData.author_name}: "${postData.content.substring(0, 80)}..."`);
      this.stats.postsNew++;
      this.stats.newPosts.push({
        id: idUnico,
        author: postData.author_name,
        author_id: postData.author_id || null,
        group: postData.group_name || '',
        group_url: postData.group_url || null,
        text: postData.content || '',
        images: imagePaths,
        videos: postData.video_links || [],
        tags: postData.tags || [],
        post_url: postData.post_url || null,
      });
    } else {
      const result = await db.upsertPost(postData);
      if (result.action === 'inserted') {
        this.stats.postsNew++;
        this.stats.newPosts.push({
          id: idUnico,
          author: postData.author_name,
          author_id: postData.author_id || null,
          group: postData.group_name || '',
          group_url: postData.group_url || null,
          text: postData.content || '',
          images: imagePaths,
          videos: postData.video_links || [],
          tags: postData.tags || [],
          post_url: postData.post_url || null,
        });
        logger.info(`  NUEVO: ${idUnico.substring(0, 18)}... - ${postData.author_name}`);
      } else if (result.action === 'updated') {
        this.stats.postsUpdated++;
        logger.info(`  ACTUALIZADO: ${idUnico.substring(0, 18)}... - ${postData.author_name}`);
      } else {
        this.stats.postsSkipped++;
        logger.debug(`  SKIP: ${idUnico.substring(0, 18)}... sin cambios.`);
      }
    }

    this.totalPostsProcessed++;
  }

  /**
   * Descarga imágenes de URLs de Facebook a disco local.
   * Retorna array de paths locales.
   */
  async _downloadImages(groupOrId, urls) {
    // Sanitizar nombre de carpeta y evitar espacios en blanco
    const folderName = String(groupOrId || 'sin_grupo')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .replace(/_+/g, '_')
      .trim()
      .substring(0, 50) || 'sin_grupo';
    const dir = path.join(config.scraping.imageDir, folderName);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const localPaths = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const url = urls[i];
        const ext = url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i)?.[1] || 'jpg';
        const hash = crypto.createHash('sha1').update(url).digest('hex').substring(0, 16);
        const filename = `${hash}.${ext}`;
        const filepath = path.join(dir, filename);

        // Smarter dedup: check if file with same hash already exists on disk
        let existingPath = null;
        if (fs.existsSync(filepath)) {
          existingPath = filepath;
        } else {
          const existingFiles = fs.readdirSync(dir).filter((f) => {
            const lower = f.toLowerCase();
            return lower.startsWith(`${hash}.`) && !lower.includes('_.');
          });
          if (existingFiles.length > 0) {
            const candidate = path.join(dir, existingFiles[0]);
            if (fs.existsSync(candidate)) {
              existingPath = candidate;
            }
          }
        }

        if (existingPath) {
          const existingBuffer = fs.readFileSync(existingPath);
          const existingDimensions = getImageDimensionsFromBuffer(existingBuffer);
          if (isImageBelowMinimumDimensions(existingDimensions)) {
            logger.debug(
              `    Imagen existente descartada por baja resolución: ${existingDimensions.width}x${existingDimensions.height} (${path.basename(existingPath)})`
            );
            continue;
          }
          await this._compressImageIfNeeded(existingPath);
          localPaths.push(existingPath);
          await this._createThumbnail(existingPath);
          logger.debug(`    Imagen ya existe: ${path.basename(existingPath)}`);
          continue;
        }

        const resp = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 15000,
          maxContentLength: 15 * 1024 * 1024,
          headers: {
            'User-Agent': this._uaProfile.ua,
            'Referer': 'https://www.facebook.com/',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site',
            'Priority': 'u=4, i',
          },
          httpsAgent: this._httpsAgent,
          httpAgent: this._httpsAgent,
        });

        const contentType = String(resp.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('image/')) {
          throw new Error(`respuesta no es imagen (${contentType || 'sin content-type'})`);
        }

        const dimensions = getImageDimensionsFromBuffer(Buffer.from(resp.data));
        if (isImageBelowMinimumDimensions(dimensions)) {
          logger.debug(
            `    Imagen descartada por baja resolución: ${dimensions.width}x${dimensions.height} (${filename})`
          );
          continue;
        }

        fs.writeFileSync(filepath, Buffer.from(resp.data));
        await this._compressImageIfNeeded(filepath);
        await this._createThumbnail(filepath);
        localPaths.push(filepath);
        logger.debug(`    Imagen descargada: ${folderName}/${filename} (${Math.round(resp.data.length / 1024)}KB)`);
      } catch (err) {
        logger.warn(`    No se pudo descargar imagen [${i}]: ${err.message}`);
        localPaths.push(urls[i]);
      }
    }

    return localPaths;
  }

  async _createThumbnail(originalPath) {
    if (!config.scraping.generateThumbnails) return;

    const parsed = path.parse(originalPath);
    const thumbPath = path.join(parsed.dir, `${parsed.name}_${parsed.ext}`);

    if (fs.existsSync(thumbPath)) return;

    if (!sharp) {
      if (!this._thumbnailWarned) {
        logger.warn('Sharp no está instalado; miniaturas deshabilitadas. Ejecuta: npm install sharp');
        this._thumbnailWarned = true;
      }
      return;
    }

    try {
      let quality = Math.max(35, Math.min(85, config.scraping.thumbnailQuality));
      const maxThumbBytes = Math.max(40, config.scraping.thumbnailMaxSizeKb) * 1024;
      const ext = parsed.ext.toLowerCase();
      const tempPath = path.join(parsed.dir, `${parsed.name}_.tmp${parsed.ext}`);

      for (let attempt = 0; attempt < 4; attempt++) {
        let transformer = sharp(originalPath)
          .rotate()
          .resize({
            width: config.scraping.thumbnailWidth,
            height: config.scraping.thumbnailHeight,
            fit: 'cover',
            position: 'centre',
            withoutEnlargement: false,
          });

        if (ext === '.png') {
          transformer = transformer.png({ quality, compressionLevel: 9, palette: true });
        } else if (ext === '.webp') {
          transformer = transformer.webp({ quality });
        } else {
          transformer = transformer.jpeg({ quality, mozjpeg: true });
        }

        await transformer.toFile(tempPath);
        const size = fs.statSync(tempPath).size;
        if (size <= maxThumbBytes || quality <= 38) break;
        quality -= 8;
      }

      if (fs.existsSync(tempPath)) {
        fs.renameSync(tempPath, thumbPath);
      }
      logger.debug(`    Miniatura creada: ${path.basename(thumbPath)}`);
    } catch (err) {
      try {
        const tempPath = path.join(parsed.dir, `${parsed.name}_.tmp${parsed.ext}`);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch { /* ignore */ }
      logger.warn(`    No se pudo crear miniatura: ${err.message}`);
    }
  }

  async _compressImageIfNeeded(imagePath) {
    if (!config.scraping.compressImages) return;

    let stat;
    try {
      stat = fs.statSync(imagePath);
    } catch {
      return;
    }

    const maxBytes = Math.max(100, config.scraping.maxImageSizeKb) * 1024;
    if (stat.size <= maxBytes) return;

    if (!sharp) {
      if (!this._compressionWarned) {
        logger.warn('Sharp no está instalado; compresión deshabilitada. Ejecuta: npm install sharp');
        this._compressionWarned = true;
      }
      return;
    }

    const parsed = path.parse(imagePath);
    const ext = parsed.ext.toLowerCase();
    const tempPath = path.join(parsed.dir, `${parsed.name}.tmp${parsed.ext}`);

    try {
      let quality = Math.max(60, Math.min(90, config.scraping.imageCompressionQuality));
      let transformer;

      for (let attempt = 0; attempt < 3; attempt++) {
        transformer = sharp(imagePath).rotate();
        if (ext === '.png') {
          transformer = transformer.png({ quality, compressionLevel: 9, palette: true });
        } else if (ext === '.webp') {
          transformer = transformer.webp({ quality });
        } else {
          transformer = transformer.jpeg({ quality, mozjpeg: true });
        }

        await transformer.toFile(tempPath);
        const newSize = fs.statSync(tempPath).size;
        if (newSize <= maxBytes || quality <= 62) {
          break;
        }
        quality -= 8;
      }

      const finalSize = fs.statSync(tempPath).size;
      if (finalSize < stat.size) {
        fs.renameSync(tempPath, imagePath);
        logger.debug(`    Imagen comprimida: ${path.basename(imagePath)} (${Math.round(stat.size / 1024)}KB -> ${Math.round(finalSize / 1024)}KB)`);
      } else {
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch { /* ignore */ }
      logger.warn(`    No se pudo comprimir imagen: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  async _fetchPage(url) {
    const jitterMs = config.human.requestJitterMin +
      Math.floor(Math.random() * (config.human.requestJitterMax - config.human.requestJitterMin));
    await sleep(jitterMs);

    return retryWithBackoff(async () => {
      const resp = await axios.get(url, {
        headers: this.headers,
        timeout: config.scraping.requestTimeoutMs,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
        httpsAgent: this._httpsAgent,
        httpAgent: this._httpsAgent,
        // Deshabilitar el agente por defecto de axios para usar nuestro TLS
        maxContentLength: 10 * 1024 * 1024,
      });
      this._processSetCookies(resp.headers['set-cookie']);
      return resp.data;
    }, config.scraping.maxRetries, 2000);
  }

  _processSetCookies(setCookieHeaders) {
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      this.cookies = mergeCookies(this.cookies, setCookieHeaders);
      this.cookieHeader = cookiesToHeader(this.cookies);
      saveCookies(this.cookies);
    }
  }

  _detectLoginPage(html) {
    if (!html) return false;
    if (html.length < 200) return false;
    return /name="email"/.test(html) && /name="pass"/.test(html) ||
           /"login_form"/.test(html) ||
           /id="loginbutton"/.test(html);
  }

  _detectCheckpoint(html) {
    if (!html) return false;
    if (html.length < 200) return false;
    return /\/checkpoint\//.test(html) ||
           /security check/i.test(html) ||
           /confirm your identity/i.test(html) ||
           /suspicious (login )?activity/i.test(html) ||
           /unusual (login )?activity/i.test(html) ||
           /\/two_factor\//.test(html) ||
           /login (approval|code)/i.test(html);
  }

  _naturalDelay(min, max) {
    const u1 = Math.random();
    const u2 = Math.random();
    const triangular = (u1 + u2) / 2;
    return Math.floor(min + triangular * (max - min));
  }

  async _humanPostDelay(contentText) {
    const baseDelay = this._naturalDelay(config.human.postDelayMin, config.human.postDelayMax);
    let readingTime = 0;
    if (contentText && contentText.length > 0) {
      readingTime = Math.floor((contentText.length / 100) * config.human.readingTimePer100Chars);
      readingTime = Math.min(readingTime, config.human.readingTimeMax);
      readingTime = Math.max(readingTime, config.human.readingTimeMin);
    }
    const totalDelay = baseDelay + readingTime;
    logger.debug(`  Delay entre posts: ${totalDelay}ms (base: ${baseDelay}ms, lectura: ${readingTime}ms)`);
    await sleep(totalDelay);
  }

  async _maybeDistractionPause() {
    this._postCountSinceDistraction++;
    if (this._postCountSinceDistraction >= config.human.distractionInterval) {
      if (Math.random() < config.human.distractionChance) {
        const pauseMs = config.human.distractionMin +
          Math.floor(Math.random() * (config.human.distractionMax - config.human.distractionMin));
        logger.debug(`  Pausa de distraccion: ${Math.round(pauseMs / 1000)}s...`);
        await sleep(pauseMs);
        this._postCountSinceDistraction = 0;
      }
    }
  }

  _rotateProfile() {
    const newProfile = getRandomUserAgentProfile();
    // Si hay mas de un perfil, evitar repetir el mismo
    if (config.userAgentProfiles.length > 1 && newProfile.ua === this._uaProfile.ua) {
      const others = config.userAgentProfiles.filter(p => p.ua !== this._uaProfile.ua);
      if (others.length > 0) {
        this._uaProfile = others[Math.floor(Math.random() * others.length)];
        return;
      }
    }
    this._uaProfile = newProfile;
  }

  _extractNextPageUrl(html, currentUrl) {
    // Buscar cursor de paginación en el SSR JSON
    const pattern = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const content = match[1];
      // Buscar cursor en estructura Relay de paginación
      const cursorRegex = /"cursor":"([A-Za-z0-9_\-=]{40,})"/g;
      let cm;
      while ((cm = cursorRegex.exec(content)) !== null) {
        const cursor = cm[1];
        const baseUrl = currentUrl.split('?')[0];
        const sep = '?';
        return `${baseUrl}${sep}cursor=${encodeURIComponent(cursor)}`;
      }
    }
    return null;
  }
}

module.exports = FacebookScraper;
