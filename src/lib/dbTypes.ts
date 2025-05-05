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
  userId: string; // Added to link resume to user
  personalInfo: {
    fullName?: string;
    jobTitle?: string;
    email?: string;
    phone?: string;
    address?: string;
  };
  summary: string; // Changed from objective for consistency with form
  education: {
    degree?: string;
    institution?: string;
    graduationYear?: string;
    details?: string;
  }[];
  experience: {
    jobTitle?: string;
    company?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
  }[];
  skills: { name?: string }[]; // Changed to object array for consistency
  languages?: string[]; // Keep as string array or change if needed
  hobbies?: string[]; // Keep as string array or change if needed
  customSections?: { title: string; content: string }[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
