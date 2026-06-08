const c = require('./config');
console.log('imageDir:', c.scraping.imageDir);
console.log('publicBase:', c.scraping.imagePublicBaseUrl);
console.log('download:', c.scraping.downloadImages);
console.log('maxPages:', c.scraping.maxPages);

const imageDir = String(c.scraping.imageDir || '');
const publicBase = String(c.scraping.imagePublicBaseUrl || '');

if (!/public_html[\\/]+images$/i.test(imageDir)) {
  console.log('WARN: IMAGE_DIR should point to /public_html/images in production.');
}

if (!publicBase) {
  console.log('WARN: IMAGE_PUBLIC_BASE_URL is empty; public URLs can break.');
}
