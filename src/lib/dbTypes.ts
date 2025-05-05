
// src/lib/dbTypes.ts
import type { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  createdAt: Timestamp;
  // Add other user profile fields as needed
}

export interface Resume {
  resumeId: string;
  title: string;
  userId: string; // Link resume back to the user
  personalInfo: {
    fullName?: string | null; // Make fields optional/nullable where appropriate
    jobTitle?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  };
  summary: string;
  education: {
    degree?: string | null;
    institution?: string | null;
    graduationYear?: string | null;
    details?: string | null;
  }[]; // Array of education objects
  experience: {
    jobTitle?: string | null;
    company?: string | null;
    startDate?: string | null;
    endDate?: string | null; // Can be null if current job
    description?: string | null;
  }[]; // Array of experience objects
  skills: { name?: string | null }[]; // Array of skill objects
  languages?: string[] | null; // Optional array of strings
  hobbies?: string[] | null; // Optional array of strings
  customSections?: { title: string; content: string }[] | null; // Optional array of custom sections
  parsingDone?: boolean; // Flag from PDF parsing simulation/function
  originalFileName?: string | null; // Name of the uploaded PDF
  storagePath?: string | null; // Path to the PDF in Cloud Storage
  createdAt: Timestamp;
  updatedAt: Timestamp;
}


    