// src/lib/firebase/config.ts
import { initializeApp, getApps, getApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
// import { getAnalytics } from "firebase/analytics"; // Uncomment if Analytics is needed

// Your web app's Firebase configuration
// !! IMPORTANT !! Replace with your actual Firebase configuration
// It's strongly recommended to use environment variables for security
const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyCqoVsK5yTYM0K6_Tpb5UU6XeL8gRaYoLc", // Use environment variable or fallback (less secure)
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "arabic-cv-architect.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "arabic-cv-architect",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "arabic-cv-architect.appspot.com", // Corrected storage bucket domain
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "720520492823",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:720520492823:web:af70ed03a413164ac72952",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID, // Optional: Add if you use Analytics
};


// Initialize Firebase only if it hasn't been initialized yet
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
// const analytics = getAnalytics(app); // Uncomment if Analytics is needed

export { app, auth, db, googleProvider };
