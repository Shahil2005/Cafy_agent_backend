/**
 * Print resource download metrics from Firestore.
 * Usage: node -r dotenv/config scripts/resourceDownloadStats.js
 */
require('dotenv').config();
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

(async () => {
  const snap = await admin.firestore().collection('resourceMetrics').get();
  if (snap.empty) {
    console.log('No resource downloads recorded yet.');
    process.exit(0);
  }
  for (const doc of snap.docs) {
    const d = doc.data();
    console.log(
      JSON.stringify(
        {
          id: doc.id,
          title: d.title,
          fileName: d.fileName,
          downloadCount: d.downloadCount || 0,
          uniqueDownloaderCount: d.uniqueDownloaderCount || 0,
          updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || null,
        },
        null,
        2
      )
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
