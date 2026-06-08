require('dotenv').config();

var mysql = require('mysql2/promise');
var config = require('./config');

function parseJson(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [];
  try { return JSON.parse(value); } catch { return []; }
}

(async () => {
  var limit = parseInt(process.env.CHECK_DB_LIMIT, 10) || 10;
  var p = await mysql.createPool(config.db);

  var [countRows] = await p.execute('SELECT COUNT(*) AS total FROM fb_posts');
  var total = countRows[0].total;

  var [rows] = await p.execute(
    'SELECT id_unico, author_name, group_name, images, video_links, scraped_at FROM fb_posts ORDER BY scraped_at DESC LIMIT ?',
    [limit]
  );

  console.log('Mostrando ' + rows.length + ' de ' + total + ' posts\n');

  rows.forEach(function(r) {
    var imgs = parseJson(r.images);
    var videos = parseJson(r.video_links);
    console.log(r.author_name + ' | ' + (r.group_name || '') + ' | ' + (r.id_unico || '').substring(0, 30) + ' | imgs:' + imgs.length + ' | videos:' + videos.length);
    imgs.forEach(function(img, i) { console.log('  img ' + (i + 1) + ': ' + img); });
    videos.forEach(function(video, i) { console.log('  video ' + (i + 1) + ': ' + video); });
  });

  await p.end();
})().catch(function(err) {
  console.error('check_db error: ' + err.message);
  process.exit(1);
});
