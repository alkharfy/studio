
// src/lib/dbTypes.ts
import type { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  createdAt: Timestamp;
  // Add other user profile fields as needed
}

// Structure aligning with Firestore data written by the updated Cloud Function
// Use alias FirestoreResumeData to distinguish from potential UI/form types if needed
export interface Resume { // Keep name Resume, but structure matches Firestore output
  resumeId: string;
  userId: string;
  title: string;

  personalInfo?: { // Keep optional for flexibility
    fullName?: string | null;
    jobTitle?: string | null; // Function now includes this
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;

  summary?: string | null; // Changed from 'objective' based on function update

  education?: { // Keep optional
    degree?: string | null;
    institution?: string | null; // Renamed from institute
    graduationYear?: string | null; // Renamed from year
    details?: string | null; // Added details field
  }[] | null;

  experience?: { // Keep optional
    jobTitle?: string | null; // Renamed from title
    company?: string | null;
    startDate?: string | null; // Renamed from start
    endDate?: string | null; // Renamed from end
    description?: string | null;
  }[] | null;

  skills?: { // Array of objects { name: string | null } based on function
      name?: string | null;
   }[] | null;

  languages?: string[] | null; // Simple string array based on function

  hobbies?: string[] | null; // Simple string array based on function

  customSections?: { // Added based on function
    title?: string | null;
    content?: string | null;
   }[] | null;

  // --- Metadata ---
  parsingDone?: boolean; // Added by function
  originalFileName?: string | null; // Added by function
  storagePath?: string | null; // Added by function
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// You can keep the FirestoreResumeData alias if you anticipate
// having a different structure for UI state vs Firestore storage.
// For now, Resume directly reflects the Firestore structure.
// export type FirestoreResumeData = Resume;

