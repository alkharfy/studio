
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
    jobTitle?: string | null; // Added by function
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;

  summary?: string | null; // Changed from 'objective' based on function update
  objective?: string | null; // Keep objective field if it might still be populated by older versions or direct writes

  education?: { // Keep optional
    degree?: string | null;
    institution?: string | null; // Mapped from institute
    institute?: string | null; // Keep institute for backward compatibility?
    graduationYear?: string | null; // Mapped from year
    year?: string | null; // Keep year for backward compatibility?
    details?: string | null; // Added details field
  }[] | null;

  experience?: { // Keep optional
    jobTitle?: string | null; // Mapped from title
    title?: string | null; // Keep title for backward compatibility?
    company?: string | null;
    startDate?: string | null; // Mapped from start
    start?: string | null; // Keep start for backward compatibility?
    endDate?: string | null; // Mapped from end
    end?: string | null; // Keep end for backward compatibility?
    description?: string | null;
  }[] | null;

  // Skills expected as array of objects { name: string | null } based on function output
  skills?: {
      name?: string | null;
   }[] | null;

  // Languages expected as array of objects { name: string | null, level: string | null } based on function output
  languages?: {
      name?: string | null;
      level?: string | null;
  }[] | null;

   // Hobbies expected as string[] based on function output
  hobbies?: string[] | null;

  // Custom sections added based on function schema (array of objects)
  customSections?: {
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
