const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const keyPath = path.join(__dirname, 'firebase-sa-key.json');
if (!fs.existsSync(keyPath)) {
  console.log('no key');
  process.exit();
}
const sa = require(keyPath);
admin.initializeApp({
  credential: admin.credential.cert(sa),
  databaseURL: 'https://cdeluar-ddefc-default-rtdb.firebaseio.com'
});
admin.database().ref('/c').orderByKey().limitToLast(3).once('value').then(snap => {
  const data = snap.val();
  for (const key of Object.keys(data).reverse()) {
    const post = data[key];
    console.log('ID:', key);
    console.log('Author:', post.author_name);
    console.log('Images:', JSON.stringify(post.images, null, 2));
    console.log('---');
  }
  process.exit(0);
}).catch(e => {
  console.log('Error:', e.message);
  process.exit(1);
});
