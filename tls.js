const https = require('https');
const http = require('http');
const config = require('./config');
const logger = require('./logger');

// Proxy agents son opcionales - solo se necesitan si hay proxy configurado
let HttpsProxyAgent = null;
let HttpProxyAgent = null;
try {
  HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
} catch { /* opcional */ }
try {
  HttpProxyAgent = require('http-proxy-agent').HttpProxyAgent;
} catch { /* opcional */ }

let _proxyIndex = 0;
let _lastProxyUrl = null;

/**
 * Crea un https.Agent con cipher suite y curvas elipticas similares a Chrome.
 * Esto NO es un reemplazo completo del TLS fingerprint, pero ayuda a reducir
 * la deteccion basada en cipher suites anómalas de Node.js.
 */
function createBrowserLikeHttpsAgent(proxyUrl = null) {
  const tlsOpts = {
    ciphers: config.tls.ciphers,
    minVersion: config.tls.minVersion,
    maxVersion: config.tls.maxVersion,
    ecdhCurve: config.tls.ecdhCurve,
    honorCipherOrder: config.tls.honorCipherOrder,
    rejectUnauthorized: true,
  };

  const agentOpts = {
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 6,
    maxFreeSockets: 2,
    timeout: config.scraping.requestTimeoutMs,
  };

  if (proxyUrl) {
    if (proxyUrl.startsWith('https://')) {
      if (!HttpsProxyAgent) {
        logger.warn('https-proxy-agent no instalado. Proxy deshabilitado.');
        return new https.Agent({ ...agentOpts, ...tlsOpts });
      }
      return new HttpsProxyAgent(proxyUrl, { ...agentOpts, ...tlsOpts });
    } else {
      if (!HttpProxyAgent) {
        logger.warn('http-proxy-agent no instalado. Proxy deshabilitado.');
        return new https.Agent({ ...agentOpts, ...tlsOpts });
      }
      return new HttpProxyAgent(proxyUrl, { ...agentOpts, ...tlsOpts });
    }
  }

  return new https.Agent({ ...agentOpts, ...tlsOpts });
}

/**
 * Selecciona un proxy de la lista. Si hay multiples, rota aleatoriamente.
 * Evita reusar el mismo proxy dos veces seguidas.
 */
function getProxyUrl() {
  const proxies = config.proxies;
  if (!proxies || proxies.length === 0) return null;

  if (proxies.length === 1) return proxies[0];

  // Rotar aleatoriamente, evitando repetir el ultimo
  let available = proxies;
  if (_lastProxyUrl && proxies.length > 1) {
    available = proxies.filter(p => p !== _lastProxyUrl);
    if (available.length === 0) available = proxies;
  }

  const picked = available[Math.floor(Math.random() * available.length)];
  _lastProxyUrl = picked;
  return picked;
}

/**
 * Obtiene el proxy actual sin cambiar la rotacion (para reusar en la misma pagina).
 */
function getCurrentProxyUrl() {
  return _lastProxyUrl;
}

module.exports = {
  createBrowserLikeHttpsAgent,
  getProxyUrl,
  getCurrentProxyUrl,
};
