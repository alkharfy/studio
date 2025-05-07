// src/lib/dbTypes.ts
import type { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  createdAt: Timestamp;
  latestResumeId?: string | null; // To track the most recent resume
}

// Structure aligning with Firestore data written by the updated Cloud Function
// This interface should exactly match what the cloud function saves.
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
  summary?: string | null; // Changed from objective
  objective?: string | null; // Kept for potential backward compatibility if old data exists

  education?: {
    degree?: string | null;
    institute?: string | null; // From older function output
    institution?: string | null; // Preferred name, used in form
    year?: string | null; // From older function output
    graduationYear?: string | null; // Preferred name, used in form
    details?: string | null;
  }[] | null;

  experience?: {
    title?: string | null; // From older function output
    jobTitle?: string | null; // Preferred name, used in form
    company?: string | null;
    start?: string | null; // From older function output
    startDate?: string | null; // Preferred name, used in form
    end?: string | null; // From older function output
    endDate?: string | null; // Preferred name, used in form
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
  // Fields from form not directly from parsing, but part of resume document
  yearsExperience?: number | null;
  jobDescriptionForAI?: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

