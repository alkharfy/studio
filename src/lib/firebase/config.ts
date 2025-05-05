// src/lib/firebase/config.ts
import { initializeApp, getApps, getApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, enableIndexedDbPersistence, connectFirestoreEmulator } from 'firebase/firestore'; // Import persistence and emulator connector
// import { getAnalytics } from "firebase/analytics"; // Uncomment if Analytics is needed

// Your web app's Firebase configuration from environment variables
const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// Validate required config values only once during initialization
function validateConfig(config: FirebaseOptions) {
    if (!config.apiKey) {
      console.error("Firebase Error: Missing Firebase API Key. Set NEXT_PUBLIC_FIREBASE_API_KEY environment variable.");
      return false;
    }
    if (!config.authDomain) {
        console.error("Firebase Error: Missing Firebase Auth Domain. Set NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN environment variable.");
         return false;
    }
    if (!config.projectId) {
        console.error("Firebase Error: Missing Firebase Project ID. Set NEXT_PUBLIC_FIREBASE_PROJECT_ID environment variable.");
         return false;
    }
    return true;
}

// Initialize Firebase App (Client-side)
let app: ReturnType<typeof initializeApp>;
let auth: ReturnType<typeof getAuth> | null = null;
let db: ReturnType<typeof getFirestore> | null = null;
// let analytics: ReturnType<typeof getAnalytics> | null = null; // Uncomment if needed

// Ensure initialization happens only once and only on the client-side
if (typeof window !== 'undefined' && !getApps().length) {
    if (validateConfig(firebaseConfig)) {
        try {
            app = initializeApp(firebaseConfig);
            auth = getAuth(app);
            db = getFirestore(app);
            // analytics = getAnalytics(app); // Uncomment if needed

             // Enable offline persistence (only works in browser environments)
             enableIndexedDbPersistence(db)
               .then(() => {
                 console.log("Firestore offline persistence enabled.");
               })
               .catch((err) => {
                 if (err.code == 'failed-precondition') {
                   // Multiple tabs open, persistence can only be enabled
                   // in one tab at a time.
                   console.warn("Firestore persistence failed: Multiple tabs open.");
                 } else if (err.code == 'unimplemented') {
                   // The current browser does not support all of the
                   // features required to enable persistence
                   console.warn("Firestore persistence failed: Browser does not support required features.");
                 } else {
                     console.error("Firestore persistence failed:", err);
                 }
               });

             // Connect to Emulators if running in development mode
             // Ensure process.env.NODE_ENV is correctly set (e.g., 'development')
             if (process.env.NODE_ENV === 'development') {
                 console.log("Connecting to Firebase Emulators...");
                 // Make sure the ports match your firebase.json configuration
                 connectFirestoreEmulator(db, 'localhost', 8080);
                // connectAuthEmulator(auth, 'http://localhost:9099'); // Connect Auth emulator if needed
                 console.log("Connected to Firestore Emulator.");
             }

        } catch (e) {
            console.error("Error initializing Firebase app:", e);
            // Handle initialization error appropriately
        }
    } else {
        console.error("Firebase initialization skipped due to missing configuration.");
    }

} else if (getApps().length) {
  // Get existing app if already initialized (e.g., during hot-reloads)
  app = getApp();
  auth = getAuth(app);
  db = getFirestore(app);
   // analytics = getAnalytics(app); // Uncomment if needed
}


// Export the initialized services (potentially null if initialization failed or on server)
const googleProvider = new GoogleAuthProvider();
export { app, auth, db, googleProvider }; // Note: app, auth, db might be undefined on server or if init failed
