const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, 'firebase-sa-key.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://cdeluar-ddefc-default-rtdb.firebaseio.com',
  });
}

const db = admin.database();

async function check() {
  console.log('Checking RTDB node /c/ ...');
  const snapshot = await db.ref('/c/').limitToLast(5).once('value');
  console.log('Data:', JSON.stringify(snapshot.val(), null, 2));
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
