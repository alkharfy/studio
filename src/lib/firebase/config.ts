// src/lib/firebase/config.ts
import { initializeApp, getApps, getApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
// import { getAnalytics } from "firebase/analytics"; // Uncomment if Analytics is needed

// Your web app's Firebase configuration
// !! IMPORTANT !! Replace with your actual Firebase configuration from your Firebase project console.
// It's strongly recommended to use environment variables for security.
// Make sure the environment variables are prefixed with NEXT_PUBLIC_ if they need to be accessed by the client-side browser code.

const firebaseConfig: FirebaseOptions = {
  // Ensure NEXT_PUBLIC_FIREBASE_API_KEY is set in your environment (e.g., .env.local)
  // The fallback key "AIzaSy..." is likely invalid and just a placeholder.
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyCqoVsK5yTYM0K6_Tpb5UU6XeL8gRaYoLc", // Verify this key is correct in your Firebase project
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "arabic-cv-architect.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "arabic-cv-architect",
  // Note: The storage bucket domain in the user's provided config was incorrect (had .firebasestorage.app). Corrected to .appspot.com.
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "arabic-cv-architect.appspot.com",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "720520492823",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:720520492823:web:af70ed03a413164ac72952",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID, // Optional: Add if you use Analytics
};

// Validate required config values
if (!firebaseConfig.apiKey) {
  throw new Error("Missing Firebase API Key. Set NEXT_PUBLIC_FIREBASE_API_KEY environment variable.");
}
if (!firebaseConfig.authDomain) {
    throw new Error("Missing Firebase Auth Domain. Set NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN environment variable.");
}
if (!firebaseConfig.projectId) {
    throw new Error("Missing Firebase Project ID. Set NEXT_PUBLIC_FIREBASE_PROJECT_ID environment variable.");
}


// Initialize Firebase only if it hasn't been initialized yet
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
// const analytics = getAnalytics(app); // Uncomment if Analytics is needed

export { app, auth, db, googleProvider };
