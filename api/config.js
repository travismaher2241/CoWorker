// Vercel serverless function: hands the browser the Firebase web settings
// from environment variables, so they live in Vercel rather than in the code.
// (Firebase web settings are not secret; your data is protected by sign-in
// plus the Firestore security rules in firestore.rules.)
export default function handler(req, res) {
  const env = process.env;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    apiKey: env.FIREBASE_API_KEY || '',
    authDomain: env.FIREBASE_AUTH_DOMAIN || (env.FIREBASE_PROJECT_ID ? `${env.FIREBASE_PROJECT_ID}.firebaseapp.com` : ''),
    projectId: env.FIREBASE_PROJECT_ID || '',
    appId: env.FIREBASE_APP_ID || '',
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || undefined,
  });
}
