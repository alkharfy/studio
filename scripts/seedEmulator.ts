// scripts/seedEmulator.ts
import admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore'; // Use admin Timestamp

// IMPORTANT: Download your service account key from Firebase Project Settings > Service accounts
// and save it securely. DO NOT commit it to your repository.
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to the path of your key file
// OR initialize explicitly as shown below (less secure for production).

// Example explicit initialization (if GOOGLE_APPLICATION_CREDENTIALS is not set):
// import serviceAccount from './path/to/your-service-account-key.json'; // Adjust path
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
//   // Use your actual projectId if not deploying to Firebase Hosting/Functions
//   // projectId: 'arabic-cv-architect'
// });

// Prefer initializing without explicit credentials if GOOGLE_APPLICATION_CREDENTIALS is set
try {
    // Check if already initialized (useful if run multiple times or in certain environments)
    if (admin.apps.length === 0) {
        admin.initializeApp({
            projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'arabic-cv-architect' // Use env var or default
        });
         console.log('Firebase Admin initialized successfully using Application Default Credentials.');
    }
} catch (error: any) {
     console.error(`Error initializing Firebase Admin: ${error.message}`);
     console.log('Ensure the GOOGLE_APPLICATION_CREDENTIALS environment variable is set correctly, or initialize explicitly in the script (less secure).');
     process.exit(1); // Exit if initialization fails
}


const db = admin.firestore();

const seedDatabase = async () => {
  const demoUid = 'demoUserUid123'; // Consistent UID for demo user
  const demoEmail = 'demo@example.com';
  const demoDisplayName = 'المستخدم التجريبي'; // Demo User in Arabic

  console.log(`Seeding database for user: ${demoUid}`);

  try {
    // 1. Seed User Document
    const userRef = db.collection('users').doc(demoUid);
    await userRef.set({
      uid: demoUid, // Store UID in the document as well
      email: demoEmail,
      displayName: demoDisplayName,
      createdAt: Timestamp.now(),
    });
    console.log(`User document created for ${demoUid}`);

    // 2. Seed Empty Resume Document
    const resumeCollectionRef = userRef.collection('resumes');
    const newResumeRef = resumeCollectionRef.doc(); // Auto-generate ID
    const resumeId = newResumeRef.id;

    await newResumeRef.set({
      resumeId: resumeId, // Store the generated ID within the document
      userId: demoUid, // Link resume back to the user
      title: 'مسودة السيرة الذاتية', // Draft Resume Title in Arabic
      personalInfo: {
        fullName: demoDisplayName,
        email: demoEmail,
        jobTitle: 'مطور برامج', // Example job title
        phone: '',
        address: '',
      },
      summary: 'هذه نبذة شخصية تجريبية.', // Example summary
      education: [],
      experience: [],
      skills: [],
      languages: [],
      hobbies: [],
      customSections: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    console.log(`Empty resume document (ID: ${resumeId}) created for ${demoUid}`);

    console.log('Database seeding completed successfully.');
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1); // Exit with error code
  }
};

// Check Firestore emulator connection before seeding
db.listCollections().then(() => {
    console.log('Successfully connected to Firestore emulator.');
    seedDatabase();
}).catch((error) => {
    console.error(`Failed to connect to Firestore emulator: ${error.message}`);
    console.log('Please ensure the Firestore emulator is running. Start it with: firebase emulators:start --only firestore');
    process.exit(1);
});
