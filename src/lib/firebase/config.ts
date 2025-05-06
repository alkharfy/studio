// src/lib/firebase/config.ts
import { initializeApp, getApps, type FirebaseOptions, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth'; // Added connectAuthEmulator
import { getFirestore, connectFirestoreEmulator, type FirestoreSettings, persistentLocalCache, persistentMultipleTabManager, initializeFirestore } from 'firebase/firestore'; // Import persistence, emulator connector, and initializeFirestore
import { getStorage, connectStorageEmulator } from 'firebase/storage'; // Import Firebase Storage and emulator connector
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
    const requiredKeys: (keyof FirebaseOptions)[] = ['apiKey', 'authDomain', 'projectId', 'storageBucket']; // Added storageBucket
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
let dbInstance!: ReturnType<typeof getFirestore>; // Firestore type remains the same
let storageInstance!: ReturnType<typeof getStorage>; // Added storage instance
// let analytics: ReturnType<typeof getAnalytics> | null = null; // Uncomment if needed
const googleProviderInstance = new GoogleAuthProvider(); // Initialize provider once


// Ensure initialization happens only once and only on the client-side
if (typeof window !== 'undefined' && !getApps().length) {
    if (validateConfig(firebaseConfig)) {
        try {
            app = initializeApp(firebaseConfig);
            authInstance = getAuth(app);
            
            // Define Firestore persistence settings
            const firestorePersistenceSettings: FirestoreSettings = {
                localCache: persistentLocalCache({
                    tabManager: persistentMultipleTabManager(),
                }),
            };
            // Initialize Firestore with persistence settings
            dbInstance = initializeFirestore(app, firestorePersistenceSettings);
            console.log("Firestore initialized with persistence settings.");

            storageInstance = getStorage(app); // Initialize Storage
            // analytics = getAnalytics(app); // Uncomment if needed

            // --- Configuration MUST happen immediately after getting instances ---

            // Connect to Emulators if running in development mode
            // Ensure process.env.NODE_ENV is correctly set (e.g., 'development')
             // Use NEXT_PUBLIC_USE_EMULATOR=true in .env.development.local to enable emulators
            const useEmulator = process.env.NEXT_PUBLIC_USE_EMULATOR === 'true';

            if (useEmulator) {
                console.log("Connecting to Firebase Emulators (Firestore: 8080, Auth: 9099, Storage: 9199)...");
                // Make sure the ports match your firebase.json configuration
                try {
                    // Use 127.0.0.1 instead of localhost to avoid potential IPv6 issues on some systems
                    connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
                    console.log("Connected to Firestore Emulator.");

                    // Connect Auth Emulator
                    // Ensure the URL scheme (http) is correct and matches emulator settings
                    connectAuthEmulator(authInstance, 'http://127.0.0.1:9099', { disableWarnings: true });
                    console.log("Connected to Auth Emulator.");

                     // Connect Storage Emulator
                    connectStorageEmulator(storageInstance, '127.0.0.1', 9199);
                    console.log("Connected to Storage Emulator.");

                } catch (emulatorError) {
                    console.error("Error connecting to emulators:", emulatorError);
                    // Decide how to handle emulator connection failure (e.g., fallback to production?)
                }
            } else {
                 console.log("Firebase Emulators not enabled (NODE_ENV is not 'development' or NEXT_PUBLIC_USE_EMULATOR is not 'true'). Connecting to production Firebase.");
            }

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
  app = getApp(); // Get the already initialized app
  authInstance = getAuth(app);
  dbInstance = getFirestore(app); // Get the existing Firestore instance
  storageInstance = getStorage(app); // Get existing storage instance

  // For existing instances, persistence should have been enabled on first init.
  // We don't need to call initializeFirestore again.
  console.log("Firebase app already initialized. Persistence settings should be active from initial setup.");

  // analytics = getAnalytics(app); // Uncomment if needed
} else {
    // Handle server-side or non-browser environment if necessary
    // Assign null or throw an error if Firebase services are needed server-side without proper setup
    // console.warn("Firebase initializing outside browser context or already initialized.");
}


// Export the initialized services. Use definite assignment assertion assuming init is mandatory.
// Ensure error handling above prevents app execution if init fails.
export const auth = authInstance;
export const db = dbInstance;
export const storage = storageInstance; // Export storage
export const googleProvider = googleProviderInstance;
// Export app if needed
// export { app };

