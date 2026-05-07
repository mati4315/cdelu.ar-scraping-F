require('dotenv').config();

module.exports = {
  // ─── MySQL ─────────────────────────────────────────────────
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'facebook_scraper',
    waitForConnections: true,
    connectionLimit: 3,       // Bajo para shared hosting
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  },

  // ─── Facebook ──────────────────────────────────────────────
  fb: {
    baseUrl: 'https://www.facebook.com',
    homeUrl: 'https://www.facebook.com/groups/feed/',
    profileUrl: 'https://www.facebook.com/me',    // Health check
    cookiesFile: process.env.FB_COOKIES_FILE || './cookies.json',
  },

  // ─── Scraping ──────────────────────────────────────────────
  scraping: {
    maxPostsPerRun: parseInt(process.env.MAX_POSTS_PER_RUN, 10) || 40,
    minDelayMs: parseInt(process.env.MIN_DELAY_MS, 10) || 4000,
    maxDelayMs: parseInt(process.env.MAX_DELAY_MS, 10) || 12000,
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15000,
    maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
    maxPages: 5,
    downloadImages: process.env.DOWNLOAD_IMAGES === 'true',
    imageDir: process.env.IMAGE_DIR || './images',
  },

  // ─── Human Behavior Simulation ──────────────────────────────
  human: {
    // Delay base entre posts individuales (ms)
    postDelayMin: 1500,
    postDelayMax: 4500,
    // Tiempo de "lectura" por cada 100 caracteres de contenido (ms)
    readingTimePer100Chars: 200,
    readingTimeMin: 800,
    readingTimeMax: 4000,
    // Delay jitter antes de cada request HTTP (ms) - micro-pausa impredecible
    requestJitterMin: 100,
    requestJitterMax: 800,
    // Pausa larga ocasional: cada N posts, probabilidad de pausa
    distractionInterval: 6,
    distractionChance: 0.15,
    distractionMin: 8000,
    distractionMax: 25000,
    // Scroll-down: delay tras "cargar" una nueva página antes de empezar a leer posts
    pageSettlingMin: 1000,
    pageSettlingMax: 3500,
  },

  // ─── HTTP Headers Variants ──────────────────────────────────
  headerVariants: {
    acceptLanguage: [
      'es-ES,es;q=0.9,en;q=0.8',
      'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
      'es-419,es;q=0.9,pt;q=0.8,en;q=0.7',
      'es,en;q=0.9,fr;q=0.5',
    ],
    accept: [
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ],
  },

  // ─── Circuit Breaker ───────────────────────────────────────
  cooldown: {
    baseMinutes: parseInt(process.env.COOLDOWN_BASE_MINUTES, 10) || 30,
    maxHours: parseInt(process.env.MAX_COOLDOWN_HOURS, 10) || 6,
    cooldownFile: './cooldown.json',
  },

  // ─── Lock ──────────────────────────────────────────────────
  lock: {
    lockFile: './scraper.lock',
  },

  // ─── Session State ─────────────────────────────────────────
  session: {
    stateFile: './session_state.json',
  },

  // ─── User Agents ───────────────────────────────────────────
  // www.facebook.com requiere User-Agents de escritorio para servir el SSR completo
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  ],

  // ─── Logging ───────────────────────────────────────────────
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },

  // ─── Telegram ──────────────────────────────────────────────
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // ─── Dry Run ───────────────────────────────────────────────
  dryRun: process.env.DRY_RUN === 'true',

  // ─── CSS Selectors (mbasic.facebook.com) ──────────────────
  selectors: {
    // Contenedor principal de historias
    feedContainer: '#structured_composer_async_container, [role="feed"], #m_news_feed_stream',
    // Cada publicación individual
    postArticle: 'article, [role="article"], div[data-ft*="top_level_post_id"]',
    // Alternativa: divs que contienen data-ft con top_level_post_id
    postById: 'div[data-ft*="top_level_post_id"]',
    // Autor (nombre + link)
    authorLink: 'h3 a, strong a, a[href*="/profile.php?id="], a[href*="/groups/"]',
    // Foto de perfil
    authorImg: 'img[src*="scontent"], img[src*="fbcdn"], img[style*="profile"]',
    // Contenido del post
    postBody: 'div[data-ft*="top_level_post_id"] > div > div, p, div._5rgt, div[style*="margin"]',
    // Enlace a post individual (timestamp)
    postLink: 'a[href*="/story.php?"], a[href*="/permalink.php?"], a[href*="/photo.php?"], a[href*="/video.php?"]',
    // Enlace "See more" para texto truncado
    seeMore: 'a[href*="/story.php"]:contains("See more"), a:contains("See More"), a:contains("see more")',
    // Imágenes dentro del post
    postImages: 'img[src*="scontent"], img[src*="fbcdn"], img[src*="safe_image.php"], img:not([src*="emoji"])',
    // Enlaces de video
    videoLinks: 'a[href*="/video_redirect/"], a[href*="video.php"], a[href*="watch?v="]',
    // Paginación "Show more / See more stories"
    nextPage: 'a[href*="?cursor="], #m_more_item a, a:contains("See more stories"), a:contains("Show more"), a[href*="/home.php"]',
    // Compartido detection
    sharedIndicator: 'text:contains("compartió"), text:contains("shared"), text:contains("publicación de"), text:contains("post of")',
    // Login / Challenge / Checkpoint
    loginForm: 'form[action*="login"], #loginform, input[name="email"]',
    checkpoint: 'a[href*="/checkpoint/"], form[action*="/checkpoint/"]',
    captcha: 'img[src*="captcha"], div#captcha',
    logout: 'a[href*="/logout/"]',
  },
};
