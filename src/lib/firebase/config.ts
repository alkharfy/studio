// src/lib/firebase/config.ts
import { initializeApp, getApps, type FirebaseOptions, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage'; // Import connectStorageEmulator

// Your web app's Firebase configuration from environment variables
const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  // Align storageBucket with default GCS bucket naming convention used in Cloud Functions
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ? `${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}.appspot.com` : undefined, // Corrected bucket name
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// Initialize Firebase App (Client-side)
let app: ReturnType<typeof initializeApp>;
let authInstance!: ReturnType<typeof getAuth>;
let dbInstance!: ReturnType<typeof getFirestore>;
let storageInstance!: ReturnType<typeof getStorage>;
const googleProviderInstance = new GoogleAuthProvider();

if (typeof window !== 'undefined' && !getApps().length) {
    let configIsValid = true;
    const requiredKeys: (keyof FirebaseOptions)[] = ['apiKey', 'authDomain', 'projectId', 'storageBucket'];
    for (const key of requiredKeys) {
        if (!firebaseConfig[key]) {
            console.error(`Firebase Error: Missing Firebase configuration value for ${key}. Check NEXT_PUBLIC_FIREBASE_... environment variables.`);
            configIsValid = false;
        }
    }

    if (configIsValid) {
        try {
            app = initializeApp(firebaseConfig);
            authInstance = getAuth(app);

            // Use initializeFirestore for settings in v9+
            dbInstance = initializeFirestore(app, {
                localCache: persistentLocalCache({
                    tabManager: persistentMultipleTabManager(),
                }),
            });
            console.log("Firestore initialized with persistence settings.");

            storageInstance = getStorage(app);

            const useEmulator = process.env.NEXT_PUBLIC_USE_EMULATOR === 'true';

            if (useEmulator) {
                console.log("Connecting to Firebase Emulators (Firestore: 8080, Auth: 9099, Storage: 9199)...");
                try {
                    connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
                    console.log("Connected to Firestore Emulator.");
                    connectAuthEmulator(authInstance, 'http://127.0.0.1:9099', { disableWarnings: true });
                    console.log("Connected to Auth Emulator.");
                    connectStorageEmulator(storageInstance, '127.0.0.1', 9199); // Ensure Storage emulator connection is here
                    console.log("Connected to Storage Emulator.");
                } catch (emulatorError) {
                    console.error("Error connecting to emulators:", emulatorError);
                }
            } else {
                 console.log("Firebase Emulators not enabled. Connecting to production Firebase.");
            }
        } catch (e) {
            console.error("Error initializing Firebase app:", e);
        }
    } else {
        console.error("Firebase initialization skipped due to missing or invalid configuration.");
    }

} else if (typeof window !== 'undefined' && getApps().length) {
  app = getApp();
  authInstance = getAuth(app);
  dbInstance = getFirestore(app);
  storageInstance = getStorage(app);
  console.log("Firebase app already initialized.");
}

export const auth = authInstance;
export const db = dbInstance;
export const storage = storageInstance;
export const googleProvider = googleProviderInstance;
// export { app };
