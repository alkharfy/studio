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
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY, // Reads from .env
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  // Note: The storage bucket domain in the user's provided config was incorrect (had .firebasestorage.app). Corrected to .appspot.com.
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID, // Optional: Add if you use Analytics
};

// Validate required config values
if (!firebaseConfig.apiKey) {
  console.error("Firebase Error: Missing Firebase API Key. Set NEXT_PUBLIC_FIREBASE_API_KEY environment variable.");
  // Optionally throw an error or handle it appropriately
  // throw new Error("Missing Firebase API Key. Set NEXT_PUBLIC_FIREBASE_API_KEY environment variable.");
}
if (!firebaseConfig.authDomain) {
    console.error("Firebase Error: Missing Firebase Auth Domain. Set NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN environment variable.");
    // throw new Error("Missing Firebase Auth Domain. Set NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN environment variable.");
}
if (!firebaseConfig.projectId) {
    console.error("Firebase Error: Missing Firebase Project ID. Set NEXT_PUBLIC_FIREBASE_PROJECT_ID environment variable.");
    // throw new Error("Missing Firebase Project ID. Set NEXT_PUBLIC_FIREBASE_PROJECT_ID environment variable.");
}


// Initialize Firebase only if it hasn't been initialized yet
// Add checks to ensure config values exist before initializing
const app = !getApps().length && firebaseConfig.apiKey && firebaseConfig.projectId
  ? initializeApp(firebaseConfig)
  : getApp();

// Initialize services only if app initialization was successful or already existed
const auth = app ? getAuth(app) : null; // Check if app exists
const db = app ? getFirestore(app) : null; // Check if app exists
const googleProvider = new GoogleAuthProvider();
// const analytics = app ? getAnalytics(app) : null; // Uncomment if Analytics is needed and app exists

export { app, auth, db, googleProvider };
