const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const {
  sleep,
  loadCookies,
  cookiesToHeader,
  mergeCookies,
  saveCookies,
  getRandomUserAgent,
  retryWithBackoff,
  filterValidImages,
  isValidContent,
  isValidUrl,
  isFbSpinnerOrIcon,
  triggerCooldown,
} = require('./helpers');
const db = require('./db');

class FacebookScraper {
  constructor(batchId) {
    this.batchId = batchId;
    this.cookies = null;
    this.cookieHeader = '';
    this.userAgent = getRandomUserAgent();
    this.stats = {
      postsNew: 0,
      postsUpdated: 0,
      postsSkipped: 0,
      postsFailed: 0,
      pagesScraped: 0,
      errors: 0,
    };
    this.shouldStop = false;
    this.totalPostsProcessed = 0;
    this._lastContent = '';
    this._postCountSinceDistraction = 0;
    this._seenStoryIds = new Set();
  }

  async init() {
    this.cookies = loadCookies();
    if (!this.cookies) throw new Error('No se pudieron cargar las cookies.');
    this.cookieHeader = cookiesToHeader(this.cookies);
    this.userAgent = getRandomUserAgent();
    logger.info(`User-Agent: ${this.userAgent.substring(0, 60)}...`);
  }

  _getHumanHeaders() {
    const lang = config.headerVariants.acceptLanguage[
      Math.floor(Math.random() * config.headerVariants.acceptLanguage.length)
    ];
    const accept = config.headerVariants.accept[
      Math.floor(Math.random() * config.headerVariants.accept.length)
    ];
    return {
      'User-Agent': this.userAgent,
      'Accept': accept,
      'Accept-Language': lang,
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': Math.random() > 0.5 ? 'max-age=0' : 'no-cache',
      'Cookie': this.cookieHeader,
      'Referer': 'https://www.facebook.com/',
    };
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
    let currentUrl = config.fb.homeUrl;
    let pagesScraped = 0;

    while (pagesScraped < config.scraping.maxPages && !this.shouldStop) {
      logger.info(`Scrapeando página ${pagesScraped + 1}: ${currentUrl}`);

      let html;
      try {
        html = await this._fetchPage(currentUrl);
      } catch (err) {
        logger.error(`Error cargando página: ${err.message}`);
        this.stats.errors++;
        await db.logError(this.batchId, null, err.message, 'page_fetch_error', currentUrl);
        break;
      }

      if (this._detectLoginPage(html) || this._detectCheckpoint(html)) {
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

      pagesScraped++;
      this.stats.pagesScraped = pagesScraped;

      if (!this.shouldStop) {
        const nextUrl = this._extractNextPageUrl(html);
        if (nextUrl) {
          currentUrl = nextUrl;
          const delay = this._naturalDelay(config.scraping.minDelayMs, config.scraping.maxDelayMs);
          logger.debug(`Pausa de ${delay}ms antes de siguiente página...`);
          await sleep(delay);
        } else {
          logger.info('No se encontró enlace de siguiente página. Fin del scraping.');
          break;
        }
      }
    }

    logger.info(`Scraping finalizado. ${this.totalPostsProcessed} posts procesados en ${pagesScraped} páginas.`);
    return this.stats;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXTRACCIÓN DESDE SSR JSON DE www.facebook.com
  // ═══════════════════════════════════════════════════════════════

  _extractPostsFromSSR(html) {
    const blobs = [];
    const pattern = /<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        const content = match[1];
        // Solo procesar blobs que contengan datos de feed
        if (content.includes('story_bucket') && content.includes('"message":')) {
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

    // Encontrar todos los IDs de story (formato Uzpf...)
    const storyIdPattern = /"id":"(Uzpf[A-Za-z0-9_=-]{30,})"/g;
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
        let groupName = null;
        let groupUrl = null;
        let nodeIdMatch;

        // Buscar todos los actores y guardar sus datos
        const actorMap = new Map(); // node_id → actor data
        
        // Encontrar actors: "name":"...", "url":"...facebook.com...", "profile_picture":{"uri":"..."}
        const actorRegex = /"name":"([^"]{2,80})"[^}]*?"url":"((?:https?:)?\\\/\\\/www\.facebook\.com\\\/[^"]+)"[^}]*?"profile_picture":\{"uri":"([^"]+)"/g;
        let actorMatch;
        while ((actorMatch = actorRegex.exec(blobStr)) !== null) {
          const name = actorMatch[1];
          const url = actorMatch[2].replace(/\\\//g, '/');
          const pic = actorMatch[3].replace(/\\\//g, '/');
          
          if (!/Bundle|Worker|display|order|className|everyone|checksum|like|love|haha|wow|sad|angry/.test(name)) {
            // Encontrar el node_id asociado buscando "story_bucket" después de este actor
            const afterActor = blobStr.substring(actorMatch.index);
            const nodeMatch = afterActor.match(/"story_bucket":\{"nodes":\[\{[^}]*"id":"(\d+)"/);
            if (nodeMatch) {
              const nodeId = nodeMatch[1];
              actorMap.set(nodeId, { name, url, pic });
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
            text = msgMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
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
            groupName = groupMatch[1];
            // Buscar el group id cerca
            const nearbyGroup = blobStr.substring(groupMatch.index, Math.min(blobStr.length, groupMatch.index + 300));
            const gidMatch = nearbyGroup.match(/"id":"(\d+)"/);
            if (gidMatch) {
              groupUrl = 'https://www.facebook.com/groups/' + gidMatch[1] + '/';
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
          const name = anMatch[1];
          if (!/Bundle|Worker|display|order|className|everyone|checksum|like|love|haha|wow|sad|angry|connection_quality|latency_level|is_ad|content_category|streaming_implementation|is_latency_sensitive|fbls_tier|is_live|GLOBAL|WAWeb|MAW|FileHash|Canvas|VideoPlayer|MWChat/.test(name)) {
            const dist = Math.abs(anMatch.index - storyIdx);
            if (!author || dist < author.dist) {
              // Verificar si este nombre está cerca de un url de perfil de facebook
              const nearby = blobStr.substring(Math.max(0, anMatch.index - 200), Math.min(blobStr.length, anMatch.index + 500));
              const urlMatch = nearby.match(/"url":"((?:https?:)?\\\/\\\/www\.facebook\.com\\\/[^"]+)"/);
              const picMatch = nearby.match(/"profile_picture":\{"uri":"([^"]+)"/);
              if (urlMatch) {
                author = { 
                  name, 
                  url: urlMatch[1].replace(/\\\//g, '/'),
                  pic: picMatch ? picMatch[1].replace(/\\\//g, '/') : null,
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
        }

        // Construir el post si tiene datos suficientes
        if (authorName || text) {
          stories.push({
            story_id: storyId,
            author_name: authorName || 'Unknown',
            author_profile_url: authorUrl,
            author_profile_pic: authorPic,
            group_name: groupName,
            group_url: groupUrl,
            text: text || '',
            images: [],
            raw_story_id: storyId,
          });
        }

      } catch (e) {
        logger.debug('Error parsing story ' + storyId + ': ' + e.message);
      }
    }

    return stories;
  }

  // ═══════════════════════════════════════════════════════════════
  // PROCESS POST & SAVE
  // ═══════════════════════════════════════════════════════════════

  async _processPostData(post) {
    if (!post.text && (!post.images || post.images.length === 0)) {
      this.stats.postsSkipped++;
      return;
    }

    this._lastContent = post.text;

    // Derivar post_id del raw_story_id
    const postId = post.story_id || crypto.createHash('md5').update(post.text + post.author_name).digest('hex').substring(0, 20);

    const postData = {
      post_id: postId,
      scrape_batch_id: this.batchId,
      author_name: post.author_name,
      author_profile_url: post.author_profile_url,
      author_profile_pic: post.author_profile_pic,
      group_name: post.group_name,
      group_url: post.group_url,
      content: post.text,
      content_hash: crypto.createHash('sha256').update(post.text || '').digest('hex'),
      original_post_link: post.author_profile_url || '',
      post_timestamp: null,
      images: post.images,
      video_links: [],
      reaction_count: 0,
      comment_count: 0,
      share_count: 0,
    };

    if (config.dryRun) {
      const groupLabel = postData.group_name ? `[${postData.group_name}] ` : '';
      logger.info(`  [DRY RUN] Post ${postId.substring(0, 15)}... ${groupLabel}por ${postData.author_name}: "${postData.content.substring(0, 80)}..."`);
      this.stats.postsNew++;
    } else {
      const result = await db.upsertPost(postData);
      if (result.action === 'inserted') {
        this.stats.postsNew++;
        logger.info(`  NUEVO: ${postId.substring(0, 15)}... - ${postData.author_name}`);
      } else if (result.action === 'updated') {
        this.stats.postsUpdated++;
        logger.info(`  ACTUALIZADO: ${postId.substring(0, 15)}... - ${postData.author_name}`);
      } else {
        this.stats.postsSkipped++;
        logger.debug(`  SKIP: ${postId.substring(0, 15)}... sin cambios.`);
      }
    }

    this.totalPostsProcessed++;
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
    return /name="email"/.test(html) && /name="pass"/.test(html) ||
           /"login_form"/.test(html) ||
           /id="loginbutton"/.test(html);
  }

  _detectCheckpoint(html) {
    if (!html) return false;
    return /\/checkpoint\//.test(html) ||
           /security check/i.test(html) ||
           /confirm your identity/i.test(html);
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

  _extractNextPageUrl(html) {
    // Buscar cursor de paginación en el SSR JSON (no en CSS colores)
    // El cursor real tiene un formato largo (base64 o similar)
    const pattern = /<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const content = match[1];
      // Buscar cursor en estructura Relay de paginación (tiene formato de hash largo)
      const cursorRegex = /"cursor":"([A-Za-z0-9_\-=]{50,})"/g;
      let cm;
      while ((cm = cursorRegex.exec(content)) !== null) {
        const cursor = cm[1];
        const baseUrl = config.fb.homeUrl;
        const sep = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${sep}cursor=${encodeURIComponent(cursor)}`;
      }
    }
    return null;
  }
}

module.exports = FacebookScraper;
