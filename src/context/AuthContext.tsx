'use client';

import type { ReactNode } from 'react';
import React, { createContext, useState, useEffect, useContext } from 'react';
import {
  type User,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, googleProvider } from '@/lib/firebase/config';
import { useToast } from '@/hooks/use-toast';
import type { AuthProviderProps, AuthContextType, SignUpCredentials, SignInCredentials } from '@/types/auth'; // Create this type definition file

// Create the context
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Create the provider component
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  // Store user data in Firestore
  const createUserDocument = async (user: User) => {
    const userRef = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      try {
        await setDoc(userRef, {
          email: user.email,
          displayName: user.displayName || user.email?.split('@')[0], // Use part of email if no display name
          createdAt: serverTimestamp(),
          // Add any other initial user data here
        });
      } catch (error) {
        console.error('Error creating user document:', error);
        toast({
          title: 'خطأ في قاعدة البيانات',
          description: 'لم نتمكن من إنشاء ملف تعريف المستخدم الخاص بك.',
          variant: 'destructive',
        });
      }
    }
  };

  // Sign up with email and password
  const signUp = async ({ email, password }: SignUpCredentials): Promise<User | null> => {
    setLoading(true);
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      await createUserDocument(userCredential.user);
      setCurrentUser(userCredential.user);
      toast({ title: 'تم التسجيل بنجاح', description: 'مرحباً بك!' });
      return userCredential.user;
    } catch (error: any) {
      console.error('Sign Up Error:', error);
       let message = 'حدث خطأ أثناء التسجيل. الرجاء المحاولة مرة أخرى.';
       if (error.code === 'auth/email-already-in-use') {
         message = 'هذا البريد الإلكتروني مسجل بالفعل.';
       } else if (error.code === 'auth/weak-password') {
         message = 'كلمة المرور ضعيفة جدًا. يجب أن تكون 6 أحرف على الأقل.';
       }
      toast({ title: 'خطأ في التسجيل', description: message, variant: 'destructive' });
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Sign in with email and password
  const signInWithEmail = async ({ email, password }: SignInCredentials): Promise<User | null> => {
    setLoading(true);
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      setCurrentUser(userCredential.user);
      toast({ title: 'تم تسجيل الدخول بنجاح', description: 'مرحباً بعودتك!' });
      return userCredential.user;
    } catch (error: any) {
      console.error('Sign In Error:', error);
       let message = 'فشل تسجيل الدخول. يرجى التحقق من بريدك الإلكتروني وكلمة المرور.';
       if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
         message = 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
       }
      toast({ title: 'خطأ في تسجيل الدخول', description: message, variant: 'destructive' });
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Sign in with Google
  const signInWithGoogle = async (): Promise<User | null> => {
    setLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      await createUserDocument(result.user); // Create doc if it's the first time
      setCurrentUser(result.user);
      toast({ title: 'تم تسجيل الدخول بنجاح', description: `مرحباً بك, ${result.user.displayName || ''}!` });
      return result.user;
    } catch (error: any) {
      console.error('Google Sign In Error:', error);
       // Handle specific errors like popup closed by user
       if (error.code !== 'auth/popup-closed-by-user') {
           toast({ title: 'خطأ في تسجيل الدخول بجوجل', description: 'حدث خطأ ما. الرجاء المحاولة مرة أخرى.', variant: 'destructive' });
       }
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Sign out
  const signOut = async () => {
    setLoading(true);
    try {
      await firebaseSignOut(auth);
      setCurrentUser(null);
      toast({ title: 'تم تسجيل الخروج بنجاح' });
    } catch (error) {
      console.error('Sign Out Error:', error);
      toast({ title: 'خطأ في تسجيل الخروج', description: 'حدث خطأ ما. الرجاء المحاولة مرة أخرى.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // Listener for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setLoading(false);
    });

    // Cleanup subscription on unmount
    return () => unsubscribe();
  }, []);

  const value = {
    currentUser,
    loading,
    signUp,
    signInWithEmail,
    signInWithGoogle,
    signOut,
  };

  // Render children only when loading is false initially to avoid flicker
  return (
    <AuthContext.Provider value={value}>
       {children}
    </AuthContext.Provider>
  );
};

// Custom hook to use the auth context
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
