try {
  const p = require('mysql2/package.json');
  console.log('mysql2 version:', p.version);
} catch(e) {
  // package.json not found, try node_modules
  const p = require('./node_modules/mysql2/package.json');
  console.log('mysql2 version:', p.version);
}
