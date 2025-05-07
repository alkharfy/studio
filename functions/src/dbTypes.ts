// functions/src/dbTypes.ts
// This file can be a copy of src/lib/dbTypes.ts or a simplified version
// if the function only deals with a subset of the Resume data.
// For consistency, it's often good to keep them aligned if possible.

import type { Timestamp } from 'firebase-admin/firestore'; // Use firebase-admin Timestamp

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  createdAt: Timestamp;
  latestResumeId?: string | null; 
}


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
  objective?: string | null; 

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
  rawAiOutput?: string | null; // For debugging AI response
  originalFileName?: string | null;
  storagePath?: string | null;
  yearsExperience?: number | null;
  jobDescriptionForAI?: string | null;
  extractedData?: any | null; // To store raw AI output if needed for debugging parsing errors

  createdAt: Timestamp; 
  updatedAt: Timestamp; 
}

