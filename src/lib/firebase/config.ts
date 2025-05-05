
// src/lib/firebase/config.ts
import { initializeApp, getApps, getApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth'; // Added connectAuthEmulator
import { getFirestore, enableIndexedDbPersistence, connectFirestoreEmulator } from 'firebase/firestore'; // Import persistence and emulator connector
// import { getAnalytics } from "firebase/analytics"; // Uncomment if Analytics is needed

// Your web app's Firebase configuration from environment variables
// Make sure NEXT_PUBLIC_ environment variables are correctly set in your .env file
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
    const requiredKeys: (keyof FirebaseOptions)[] = ['apiKey', 'authDomain', 'projectId'];
    let isValid = true;
    for (const key of requiredKeys) {
        if (!config[key]) {
            console.error(`Firebase Error: Missing Firebase configuration value for ${key}. Set NEXT_PUBLIC_FIREBASE_${key.toUpperCase()} environment variable.`);
            isValid = false;
        }
    }
    return isValid;
}

// Initialize Firebase App (Client-side)
let app: ReturnType<typeof initializeApp>;
// Use definite assignment assertion (!) assuming initialization must succeed for the app to work.
// Handle potential errors during initialization appropriately in a real app.
let authInstance!: ReturnType<typeof getAuth>;
let dbInstance!: ReturnType<typeof getFirestore>;
// let analytics: ReturnType<typeof getAnalytics> | null = null; // Uncomment if needed
const googleProviderInstance = new GoogleAuthProvider(); // Initialize provider once


// Ensure initialization happens only once and only on the client-side
if (typeof window !== 'undefined' && !getApps().length) {
    if (validateConfig(firebaseConfig)) {
        try {
            app = initializeApp(firebaseConfig);
            authInstance = getAuth(app);
            dbInstance = getFirestore(app);
            // analytics = getAnalytics(app); // Uncomment if needed

            // --- Configuration MUST happen immediately after getting instances ---

            // Connect to Emulators if running in development mode
            // Ensure process.env.NODE_ENV is correctly set (e.g., 'development')
             // Use NEXT_PUBLIC_USE_EMULATOR=true in .env.development.local to enable emulators
            const useEmulator = process.env.NEXT_PUBLIC_USE_EMULATOR === 'true';

            if (useEmulator) {
                console.log("Connecting to Firebase Emulators (Firestore: 8080, Auth: 9099)...");
                // Make sure the ports match your firebase.json configuration
                try {
                    // Use 127.0.0.1 instead of localhost to avoid potential IPv6 issues on some systems
                    connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
                    console.log("Connected to Firestore Emulator.");

                    // Connect Auth Emulator
                    // Ensure the URL scheme (http) is correct and matches emulator settings
                    connectAuthEmulator(authInstance, 'http://127.0.0.1:9099', { disableWarnings: true });
                    console.log("Connected to Auth Emulator.");
                } catch (emulatorError) {
                    console.error("Error connecting to emulators:", emulatorError);
                    // Decide how to handle emulator connection failure (e.g., fallback to production?)
                }
            } else {
                 console.log("Firebase Emulators not enabled (NODE_ENV is not 'development' or NEXT_PUBLIC_USE_EMULATOR is not 'true'). Connecting to production Firebase.");
            }

             // Enable offline persistence (only works in browser environments)
             // This is asynchronous, but setting it up should happen early.
            enableIndexedDbPersistence(dbInstance)
               .then(() => {
                 console.log("Firestore offline persistence enabled.");
               })
               .catch((err) => {
                 if (err.code == 'failed-precondition') {
                   // Multiple tabs open, persistence can only be enabled in one tab at a time.
                   // OR it's already enabled.
                   console.warn("Firestore persistence failed or already enabled: Multiple tabs open or previously enabled.");
                 } else if (err.code == 'unimplemented') {
                   // The current browser does not support all features required to enable persistence.
                   console.warn("Firestore persistence failed: Browser does not support required features.");
                 } else {
                     console.error("Firestore persistence failed:", err);
                 }
               });

             // --- End of immediate configuration ---

        } catch (e) {
            console.error("Error initializing Firebase app:", e);
            // Handle initialization error appropriately (e.g., show error message to user)
        }
    } else {
        console.error("Firebase initialization skipped due to missing or invalid configuration.");
        // Handle missing config error (e.g., show error message)
    }

} else if (typeof window !== 'undefined' && getApps().length) {
  // Get existing app if already initialized (e.g., during hot-reloads)
  app = getApp();
  authInstance = getAuth(app);
  dbInstance = getFirestore(app);
  // analytics = getAnalytics(app); // Uncomment if needed
  // Note: Emulator/Persistence settings from the *initial* load persist.
  // Re-running connectEmulator or enablePersistence here would cause the error.
} else {
    // Handle server-side or non-browser environment if necessary
    // Assign null or throw an error if Firebase services are needed server-side without proper setup
    // console.warn("Firebase initializing outside browser context or already initialized.");
}


// Export the initialized services. Use definite assignment assertion assuming init is mandatory.
// Ensure error handling above prevents app execution if init fails.
export const auth = authInstance;
export const db = dbInstance;
export const googleProvider = googleProviderInstance;
// Export app if needed
// export { app };
