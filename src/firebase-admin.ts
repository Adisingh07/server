import admin from "firebase-admin";

let adminDb: FirebaseFirestore.Firestore;
let adminAuth: admin.auth.Auth;

export function initializeFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return;
  }

  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!serviceAccountBase64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set.");
  }

  try {
    const serviceAccountJson = Buffer.from(serviceAccountBase64, "base64").toString("utf8");
    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    adminDb = admin.firestore();
    adminAuth = admin.auth();

    console.log("✅ Firebase Admin SDK initialized successfully.");
  } catch (error: any) {
    console.error("Firebase Admin SDK Initialization Error:", error.message);
    throw new Error("Failed to initialize Firebase Admin SDK.");
  }
}

export { adminDb, adminAuth };
