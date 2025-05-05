
// src/lib/dbTypes.ts
import type { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  createdAt: Timestamp;
  // Add other user profile fields as needed
}

// Structure matching the Cloud Function's JSON output + Firestore metadata
export interface Resume {
  resumeId: string;
  userId: string; // Link resume back to the user
  title: string; // Can be set by user or default from function

  personalInfo?: { // Make the whole object optional
    fullName?: string | null;
    jobTitle?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;

  summary?: string | null; // Also called objective or profile

  education?: { // Make the whole array optional
    degree?: string | null;
    institution?: string | null;
    graduationYear?: string | null; // Keep as string if year only
    details?: string | null;
  }[] | null;

  experience?: { // Make the whole array optional
    jobTitle?: string | null;
    company?: string | null;
    startDate?: string | null; // Keep as string for flexibility (e.g., "Jan 2020")
    endDate?: string | null; // Can be null or "Present"
    description?: string | null;
  }[] | null;

  skills?: { // Make the whole array optional
      name?: string | null;
   }[] | null; // Array of skill objects

  languages?: string[] | null; // Optional array of strings

  hobbies?: string[] | null; // Optional array of strings

  customSections?: { // Make the whole array optional
    title?: string | null; // Title might be missing
    content?: string | null;
   }[] | null;

  // --- Metadata added by function/client ---
  parsingDone?: boolean; // Flag from PDF parsing
  originalFileName?: string | null; // Name of the uploaded PDF
  storagePath?: string | null; // Path to the PDF in Cloud Storage
  createdAt: Timestamp; // Added by Firestore
  updatedAt: Timestamp; // Added by Firestore
}
