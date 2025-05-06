// functions/src/dbTypes.ts
// This file can be a copy of src/lib/dbTypes.ts or a simplified version
// if the function only deals with a subset of the Resume data.
// For consistency, it's often good to keep them aligned if possible.

import type { Timestamp } from 'firebase-admin/firestore'; // Use firebase-admin Timestamp

export interface Resume {
  resumeId: string;
  userId: string;

  title?: string | null;
  personalInfo?: {
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    jobTitle?: string | null;
  } | null;
  summary?: string | null;
  objective?: string | null; // Kept for potential backward compatibility

  education?: {
    degree?: string | null;
    institute?: string | null;
    institution?: string | null;
    year?: string | null;
    graduationYear?: string | null;
    details?: string | null;
  }[] | null;

  experience?: {
    title?: string | null;
    jobTitle?: string | null;
    company?: string | null;
    start?: string | null;
    startDate?: string | null;
    end?: string | null;
    endDate?: string | null;
    description?: string | null;
  }[] | null;

   skills?: {
       name?: string | null;
   }[] | null;

   languages?: {
       name?: string | null;
       level?: string | null;
   }[] | null;

   hobbies?: string[] | null;

   customSections?: {
     title?: string | null;
     content?: string | null;
    }[] | null;

  // --- Metadata ---
  parsingDone?: boolean;
  parsingError?: string | null;
  originalFileName?: string | null;
  storagePath?: string | null;
  yearsExperience?: number | null;
  jobDescriptionForAI?: string | null;

  createdAt: Timestamp; // Firestore Server Timestamp
  updatedAt: Timestamp; // Firestore Server Timestamp
}
