'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import type { ProtectedRouteProps } from '@/types/auth';
import { Loader2 } from 'lucide-react'; // For loading indicator

export function ProtectedRoute({ children }: ProtectedRouteProps): ReactNode {
  const { currentUser, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // If not loading and no user, redirect to signin
    if (!loading && !currentUser) {
      router.push('/signin');
    }
  }, [currentUser, loading, router]);

  // Show loading indicator while checking auth status
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // If user is logged in, render the children components
  // If not logged in, useEffect will trigger redirect, return null or loader temporarily
  return currentUser ? children : null; // Or return a loader until redirect happens
}
