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
// This interface should exactly match what the cloud function saves.
export interface Resume {
  resumeId: string; // Added by frontend or generated before write
  userId: string; // Added by frontend

  // Fields expected from Vertex AI extraction (can be null if not found)
  title?: string | null;
  personalInfo?: {
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    jobTitle?: string | null; // Added jobTitle based on form/schema
  } | null;
  summary?: string | null; // Mapped from 'objective' in older versions? Function now uses 'summary'
  objective?: string | null; // Keep for backward compatibility or if prompt extracts it

  // Arrays from extraction - ensure structure matches function output
  education?: {
    degree?: string | null;
    institute?: string | null; // Function might use 'institute'
    institution?: string | null; // Form uses 'institution' - handle mapping
    year?: string | null; // Function might use 'year'
    graduationYear?: string | null; // Form uses 'graduationYear' - handle mapping
    details?: string | null; // Added details field
  }[] | null;

  experience?: {
    title?: string | null; // Function might use 'title'
    jobTitle?: string | null; // Form uses 'jobTitle' - handle mapping
    company?: string | null;
    start?: string | null; // Function might use 'start'
    startDate?: string | null; // Form uses 'startDate' - handle mapping
    end?: string | null; // Function might use 'end'
    endDate?: string | null; // Form uses 'endDate' - handle mapping
    description?: string | null;
  }[] | null;

   // Skills: function prompt asks for string[], but writes { name: string }[] after mapping
   // Let's assume the function *writes* { name: string }[] now.
   skills?: {
       name?: string | null;
   }[] | null;

   // Languages: function prompt asks for { name, level }[]
   languages?: {
       name?: string | null;
       level?: string | null;
   }[] | null;

    // Hobbies: function prompt asks for string[]
   hobbies?: string[] | null;

   // Custom sections: function prompt doesn't explicitly ask, but Firestore structure allows it
   customSections?: {
     title?: string | null;
     content?: string | null;
    }[] | null;


  // --- Metadata set by Cloud Function / Frontend ---
  parsingDone?: boolean; // Set by function
  parsingError?: string | null; // Set by function on failure
  originalFileName?: string | null; // Added by function
  storagePath?: string | null; // Set by function
  createdAt: Timestamp; // Set on creation (function or frontend)
  updatedAt: Timestamp; // Set on creation/update
}
