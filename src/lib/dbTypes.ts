
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
// and closer to the user's requested interface in the prompt.
export interface Resume {
  resumeId: string;
  userId: string;
  title: string;

  personalInfo?: { // Keep optional for flexibility
    fullName?: string | null;
    jobTitle?: string | null; // Add jobTitle back if needed in UI
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;

  summary?: string | null; // Keep as 'summary' for consistency with function prompt/output

  education?: { // Keep optional
    degree?: string | null;
    institution?: string | null; // Renamed from institute for consistency
    graduationYear?: string | null; // Renamed from year
    details?: string | null; // Added details field based on function prompt
  }[] | null;

  experience?: { // Keep optional
    jobTitle?: string | null; // Renamed from title
    company?: string | null;
    startDate?: string | null; // Renamed from start
    endDate?: string | null; // Renamed from end
    description?: string | null;
  }[] | null;

  skills?: { // Array of objects { name: string }
      name?: string | null;
   }[] | null;

  languages?: string[] | null; // Changed back to simple string array based on function prompt

  hobbies?: string[] | null;

  customSections?: { // Added based on function prompt
    title?: string | null;
    content?: string | null;
   }[] | null;

  // --- Metadata ---
  parsingDone?: boolean;
  originalFileName?: string | null;
  storagePath?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
