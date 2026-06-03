# Troubleshooting: Problemas con Imágenes en Scraper de Facebook

> Documento para consultar cuando las imágenes no se cargan en la web o en Firebase.
> Creado: 2026-06-01 (fix aplicado)

---

## Problema Recurrente

Las URLs de imágenes guardadas en MySQL/Firebase no apuntan a las URLs públicas sino a **rutas locales del servidor**, causando que:
- Las imágenes no se carguen en `cdelu.ar` / la web
- Firebase guarde URLs rotas
- La web muestre imágenes faltantes

## Causa Raíz

En `scraper.js`, la función `_downloadImages()` descarga imágenes exitosamente pero **devuelve paths absolutos del sistema de archivos** (ej: `/home/u692901087/domains/bot.cdelu.io/public_html/images/Grupo/archivo.jpg`). 

El método `_processPostData()` guarda ese path directamente en MySQL como `images: ["images/Grupo/archivo.jpg"]` en vez de convertirlo a la URL pública `https://bot.cdelu.io/images/Grupo/archivo.jpg`.

## ⚠️ BUG 1: Fix Original (2026-06-01) - ROTO

El primer fix en `scraper.js` convertía paths locales a URLs públicas pero tenía bugs:
- `path.resolve()` podía normalizar paths de forma diferente según el S.O.
- No manejaba correctamente paths relativos vs absolutos

```javascript
// ❌ ESTE CÓDIGO ROMPIÓ LA WEB
imagePaths = imagePaths.map(p => {
  const absPath = path.resolve(p);
  if (absPath.startsWith(imageDir)) {
    const relative = absPath.substring(imageDir.length).replace(/\\/g, '/');
    return publicBase + relative;
  }
  return p;
});
```

**Consecuencia:** Generó URLs con `images/images/` duplicado (ej: `https://bot.cdelu.io/images/images/Grupo/archivo.jpg`) y rompió 778 posts en la DB.

## ✅ Fix Correcto (2026-06-01, v2)

```javascript
// Después de descargar imágenes, ANTES de guardar en postData
imagePaths = imagePaths.map(p => {
  if (p.startsWith('http://') || p.startsWith('https://')) return p;
  const absPath = path.resolve(p).replace(/\\\\/g, '/');
  const normalizedDir = imageDir.replace(/\\\\/g, '/').replace(/\\/+$/, '');
  
  // Path absoluto con /images/ en medio -> extraer lo que sigue
  const pubMatch = absPath.match(/\\/images\\/(.+)$/);
  if (pubMatch) return publicBase + '/' + pubMatch[1];
  
  // Empieza con el directorio de imágenes
  if (absPath.startsWith(normalizedDir + '/')) {
    return publicBase + '/' + absPath.substring(normalizedDir.length + 1);
  }
  
  // Path relativo images/...
  if (p.startsWith('images/')) return publicBase + '/' + p;
  
  return p;
});
```

## Cómo Verificar si Está Funcionando

Las URLs en la DB de MySQL (`fb_posts.images`) y Firebase (`/c/{id_unico}/images`) deben comenzar con:
- ✅ `https://bot.cdelu.io/images/...`
- ❌ `images/...`
- ❌ `/home/u692901087/domains/bot.cdelu.io/...`
- ❌ `./images/...`

## Scripts de Corrección (en el server en `/nodejs/`)

| Script | Qué hace | Cuándo usarlo |
|--------|----------|---------------|
| `fix_image_urls.js` | ⚠️ ROTO: Causó el bug de doble `images/images/`. No usar. | ❌ |
| `restore_images_db.js` | Restaura URLs duplicadas + corrige relativas | Después de aplicar fix v2 en `scraper.js` |
| `fix_thumbnails.js` | Reemplaza thumbnails inexistentes por originales | Si hay imágenes con `_.jpg` que no cargan |
| `sync_recent_firebase.js` | Sincroniza los últimos 30 posts de MySQL a Firebase | Para refrescar Firebase con URLs corregidas |
| `sync_all_firebase.js` | Sincroniza hasta 800 posts a Firebase | Después de restaurar la DB |

## Prevención Futura

1. **NUNCA** guardar paths locales en la DB. Siempre usar `config.scraping.imagePublicBaseUrl` para convertir.
2. Si agregás una nueva función que descargue imágenes, asegurate de que el resultado pase por el mapeo de conversión.
3. **Verificación rápida de URLs rotas en Firebase:**
   ```
   SELECT images FROM fb_posts WHERE images LIKE '%images/images/%' LIMIT 1
   ```
   Si devuelve algo, correr `restore_images_db.js`.
4. Los thumbnails (`_createThumbnail`) requieren `sharp` — si no está instalado, se genera el warn `"Sharp no está instalado"` pero las imágenes originales se guardan igual.
5. **Después de tocar el fix de URLs**, SIEMPRE:
   - Correr `restore_images_db.js` (para limpiar la DB)
   - Correr `sync_all_firebase.js` (para sincronizar a Firebase)

## Config de Directorios

| Variable | Valor |
|----------|-------|
| `IMAGE_DIR` (server) | `/home/u692901087/domains/bot.cdelu.io/public_html/images` |
| `IMAGE_PUBLIC_BASE_URL` | `https://bot.cdelu.io/images` |
| `DOWNLOAD_IMAGES` | `true` |

> **IMPORTANTE**: Si corrés el scraper desde tu PC local con `IMAGE_DIR=./images`, las imágenes se descargan en tu PC pero NO se suben al server. La URL pública apunta a Hostinger, no a tu PC. Para desarrollo local usá `DRY_RUN=true` o asegurate de que `IMAGE_DIR` apunte a `public_html/images/` del server.

---

*Referencia: bug reportado por Matias el 2026-06-01. Fix en scraper.js, línea ~696.*
