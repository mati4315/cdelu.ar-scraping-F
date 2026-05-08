const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const logger = require('./logger');

let db = null;

function initFirebase() {
  if (db) return db;

  const keyPath = path.join(__dirname, 'firebase-sa-key.json');
  if (!fs.existsSync(keyPath)) {
    logger.warn('firebase-sa-key.json no encontrado. Firebase sync deshabilitado.');
    return null;
  }

  if (!admin.apps.length) {
    const serviceAccount = require(keyPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: 'https://cdeluar-ddefc-default-rtdb.firebaseio.com',
    });
  }

  db = admin.database();
  logger.info('Firebase inicializado correctamente.');
  return db;
}

async function syncToFirebase(post) {
  const database = initFirebase();
  if (!database) return;

  if (!post.id_unico) {
    logger.warn('Firebase sync: falta id_unico, saltando.');
    return;
  }

  const postUrl = (post.group_url && post.post_url)
    ? `https://facebook.com/groups/${post.group_url}/posts/${post.post_url}`
    : (post.post_url || '');

  const now = new Date().toISOString();

  const payload = {
    id_unico: post.id_unico,
    type: 'comunidad',
    author_name: post.author_name || 'Desconocido',
    author_id: post.author_id || '',
    group_name: post.group_name || '',
    group_url: post.group_url || '',
    content: post.content || '',
    images: Array.isArray(post.images) ? post.images : [],
    video_links: Array.isArray(post.video_links) ? post.video_links : [],
    tags: Array.isArray(post.tags) ? post.tags : [],
    post_url: postUrl,
    createdAt: now,
    updatedAt: now.replace('T', ' ').substring(0, 19),
    deletedAt: null,
    stats: {
      likesCount: 0,
      commentsCount: 0,
      viewsCount: 0,
    },
  };

  try {
    const ref = database.ref(`/c/${post.id_unico}`);
    await ref.set(payload);
    logger.debug(`Firebase sync OK: /c/${post.id_unico}`);
  } catch (err) {
    logger.warn(`Error Firebase sync ${post.id_unico}: ${err.message}`);
  }
}

module.exports = { syncToFirebase };
