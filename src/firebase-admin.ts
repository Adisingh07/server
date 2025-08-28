
import admin from 'firebase-admin';

// This function initializes the Firebase Admin SDK.
// It checks if the SDK has already been initialized to prevent errors.
export function initializeFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return;
  }

  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!serviceAccountBase64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not set. Please base64 encode your service account JSON file and add it to your .env file in the `backend` directory.');
  }

  try {
    const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('ascii');
    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    console.log("Firebase Admin SDK initialized successfully for Backend Server.");
  } catch (error: any) {
    console.error('Firebase Admin SDK Initialization Error:', error.message);
    throw new Error('Failed to initialize Firebase Admin SDK. Check your FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable.');
  }
}

export const adminDb = admin.firestore();
export const adminAuth = admin.auth();
