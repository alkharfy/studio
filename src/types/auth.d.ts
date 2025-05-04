// src/types/auth.d.ts
import type { ReactNode } from 'react';
import type { User } from 'firebase/auth';

// Credentials for email/password sign up
export interface SignUpCredentials {
  email: string;
  password?: string; // Make password optional for Google sign-up case if needed, though separate functions are better
  confirmPassword?: string; // Only needed for email sign-up form validation
}

// Credentials for email/password sign in
export interface SignInCredentials {
  email: string;
  password?: string; // Optional for Google sign-in case
}

// Context type definition
export interface AuthContextType {
  currentUser: User | null;
  loading: boolean;
  signUp: (credentials: SignUpCredentials) => Promise<User | null>;
  signInWithEmail: (credentials: SignInCredentials) => Promise<User | null>;
  signInWithGoogle: () => Promise<User | null>;
  signOut: () => Promise<void>;
}

// Props for AuthProvider component
export interface AuthProviderProps {
  children: ReactNode;
}

// Props for ProtectedRoute component
export interface ProtectedRouteProps {
    children: ReactNode;
}
