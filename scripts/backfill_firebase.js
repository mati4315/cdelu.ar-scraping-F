require('dotenv').config();
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

// Load config manually (avoid winston logger issues in one-off scripts)
const imageDir = process.env.IMAGE_DIR || './images';
const imagePublicBaseUrl = (process.env.IMAGE_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

function mapImagesToPublicUrls(images) {
  if (!imagePublicBaseUrl) return images;
  const imageRoot = path.resolve(imageDir);
  const imageRootWithSep = `${imageRoot}${path.sep}`;

  return (images || []).map((img) => {
    const value = String(img || '').trim();
    if (!value) return value;
    if (/^https?:\/\//i.test(value)) return value;

    let normalized = path.normalize(value);
    let absolutePath = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(normalized);

    if (!absolutePath.startsWith(imageRootWithSep)) {
      const imageRootName = path.basename(imageRoot);
      const stripped = normalized.replace(new RegExp(`^${imageRootName}[/\\\\]`, 'i'), '');
      if (stripped !== normalized) {
        absolutePath = path.join(imageRoot, stripped);
      }
    }

    if (!absolutePath.startsWith(imageRootWithSep)) {
      return value;
    }

    const relativePath = path.relative(imageRoot, absolutePath).replace(/\\/g, '/');
    return `${imagePublicBaseUrl}/${encodeURI(relativePath)}`;
  });
}

async function main() {
  const keyPath = path.join(__dirname, '..', 'firebase-sa-key.json');
  if (!fs.existsSync(keyPath)) {
    console.error('firebase-sa-key.json no encontrado');
    process.exit(1);
  }

  const serviceAccount = require(keyPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://cdeluar-ddefc-default-rtdb.firebaseio.com',
  });

  const db = admin.database();
  const ref = db.ref('/c');

  console.log('Leyendo todos los posts de Firebase RTDB...');
  const snapshot = await ref.once('value');
  const allPosts = snapshot.val();

  if (!allPosts) {
    console.log('No hay posts en Firebase.');
    process.exit(0);
  }

  const entries = Object.entries(allPosts);
  console.log(`Total de posts: ${entries.length}`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [id, post] of entries) {
    try {
      const oldImages = Array.isArray(post.images) ? post.images : [];
      const newImages = mapImagesToPublicUrls(oldImages);
      const newImagesV2 = newImages.map((url) => ({ url }));
      const newImgMiniatura = newImages[0] || '';

      const changed = oldImages.length !== newImages.length ||
        oldImages.some((v, i) => v !== newImages[i]) ||
        JSON.stringify(post.imagesV2 || []) !== JSON.stringify(newImagesV2) ||
        (post.imgMiniatura || '') !== newImgMiniatura;

      if (!changed) {
        skipped++;
        continue;
      }

      await ref.child(id).child('images').set(newImages);
      await ref.child(id).child('imagesV2').set(newImagesV2);
      await ref.child(id).child('imgMiniatura').set(newImgMiniatura);
      console.log(`  [OK] ${id}: ${oldImages.length} -> ${newImages.length} imagenes`);
      updated++;
    } catch (err) {
      console.error(`  [ERR] ${id}: ${err.message}`);
      errors++;
    }

    if (updated % 10 === 0 && updated > 0) {
      console.log(`  Progreso: ${updated} actualizados, ${skipped} saltados, ${errors} errores`);
    }
  }

  console.log('\n--- Resumen ---');
  console.log(`Actualizados: ${updated}`);
  console.log(`Saltados:    ${skipped}`);
  console.log(`Errores:     ${errors}`);
  console.log('Backfill completado.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
