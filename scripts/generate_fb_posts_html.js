#!/usr/bin/env node
// Bootstrap-based HTML generator for fb_posts with responsive cards
require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { limit: 10, page: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i+1]) out.limit = parseInt(args[i+1], 10);
    if (args[i] === '--page' && args[i+1]) out.page = parseInt(args[i+1], 10);
  }
  return out;
}

async function main() {
  const { limit, page } = parseArgs();
  const offset = Math.max(0, (page - 1) * limit);

  const db = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'facebook_scraper',
  };
  const pool = await mysql.createPool(db);
  const [rows] = await pool.execute(
    'SELECT id_unico, author_name, group_name, images, video_links, content, scraped_at FROM fb_posts ORDER BY scraped_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );

  function parseJson(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value); } catch { return []; }
  }

  // Build HTML with Bootstrap
  let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FB Posts</title>`;
  html += `<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">`;
  html += `</head><body><div class="container-fluid py-4"><h2 class="text-center mb-4">FB Posts - newest</h2><div class="row g-3" id="posts-grid">`;

  rows.forEach((r) => {
    const images = parseJson(r.images);
    const videos = parseJson(r.video_links);
    const author = r.author_name || 'Unknown';
    const group = r.group_name || '';
    const contentPreview = (r.content || '').replace(/\n/g, ' ').trim().substring(0, 300);

    html += `<div class="col-12 col-sm-6 col-md-6 col-lg-4 mb-3 fb-post-card">`;
    html += `<div class="card h-100">`;

    // Image grid (max 4 thumbnails)
    if (images.length > 0) {
      html += `<div class="images p-2 d-flex flex-wrap">`;
      images.slice(0, 4).forEach((img) => {
        const url = img.toString().replace(/\\/g, '/');
        html += `<img src="${url}" class="img-fluid rounded me-2 mb-2" style="max-height:140px;object-fit:cover;">`;
      });
      html += `</div>`;
    }

    // Metadata: reactions, comments, shares
    html += `<div class="card-body d-flex flex-column">`;
    html += `<h5 class="card-title mb-1">${author}${group ? ' • ' + group : ''}</h5>`;
    html += `<div class="text-muted small mb-1">ID: ${r.id_unico || ''}${r.author_id ? ' | FB: ' + r.author_id : ''}</div>`;
    html += `<p class="card-text mb-2">${contentPreview}${r.content && r.content.length>300 ? '...' : ''}</p>`;
    if (videos.length > 0) {
      html += `<div class="videos mb-2">`;
      videos.forEach((vid, idx) => {
        const v = vid.toString().replace(/\\/g, '/');
        if (/\\.(mp4|webm|ogg)$/i.test(v)) {
          html += `<video class="w-100 mb-2" controls><source src="${v}" type="video/mp4"></video>`;
        } else {
          html += `<a href="${v}" target="_blank" class="btn btn-sm btn-outline-primary me-2 mb-2">Video ${idx+1}</a>`;
        }
      });
      html += `</div>`;
    }
    html += `</div>`; // card-body
    html += `</div>`; // card
    html += `</div>`; // column
  });

  html += `</div>`; // row
  html += `<nav aria-label="Page navigation" class="d-flex justify-content-center mt-4"><ul class="pagination" id="fb-pagination"></ul></nav>`;
  html += `</div>`; // container
  html += `<script>
document.addEventListener('DOMContentLoaded', function(){
  const cards = Array.from(document.querySelectorAll('.fb-post-card'));
  const limit = ${limit};
  const total = cards.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const pager = document.getElementById('fb-pagination');
  function showPage(p){
    const start = (p-1)*limit;
    const end = p*limit;
    cards.forEach((c, idx)=>{ c.style.display = (idx>=start && idx<end) ? 'block' : 'none'; });
  }
  function renderPagination(){
    pager.innerHTML = '';
    for(let i=1;i<=totalPages;i++){
      const li = document.createElement('li');
      li.className = 'page-item' + (i===1 ? ' active':'');
      const a = document.createElement('a');
      a.className = 'page-link';
      a.href = '#'; a.textContent = i;
      a.addEventListener('click', function(e){ e.preventDefault(); showPage(i); pager.querySelectorAll('.page-item').forEach(p=>p.classList.remove('active')); li.classList.add('active'); });
      li.appendChild(a);
      pager.appendChild(li);
    }
  }
  if (totalPages > 1) renderPagination();
  showPage(1);
});
</script>`;

  const outPath = path.resolve(process.cwd(), 'fb_posts_demo.html');
  require('fs').writeFileSync(outPath, html, 'utf8');
  console.log('Generated', outPath);
  await pool.end();
}

main().catch((e) => { console.error('Error generating HTML:', e); process.exit(1); });
