
'use client';

import * as React from 'react';
import { useState, useCallback, useEffect } from 'react'; // Added useEffect
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Loader2, LogOut } from 'lucide-react'; // Added LogOut
import { ProtectedRoute } from '@/components/ProtectedRoute'; // Import ProtectedRoute
import { useAuth } from '@/context/AuthContext'; // Import useAuth
import { db } from '@/lib/firebase/config'; // Import db
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore'; // Firestore functions
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes'; // Use Firestore specific type alias
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form'; // Import CvForm and related items
import { CvPreview } from '@/components/cv-preview'; // Import CvPreview
import { useToast } from '@/hooks/use-toast'; // Import useToast

// Main page component managing layout and data fetching
function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); // State for loading initial CV
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth(); // Get signOut and currentUser

  // Initialize the form using react-hook-form
  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser), // Start with empty/default normalized data
    mode: 'onChange', // Validate on change for live preview updates
  });

  // Function to load the most recent CV for the user
  const loadMostRecentCv = useCallback(async (userId: string) => {
    setIsLoadingCv(true);
    let loadedCvData: FirestoreResumeData | null = null;
    try {
        const resumesRef = collection(db, 'users', userId, 'resumes');
        // Order by updatedAt descending, limit to 1 to get the most recent
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
        const querySnapshot = await getDocs(q);

        if (!querySnapshot.empty) {
            const cvDoc = querySnapshot.docs[0];
            // Combine ID with data
            loadedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
            console.log("Loaded raw CV data:", loadedCvData);
            toast({
                title: 'تم تحميل السيرة الذاتية',
                description: `تم تحميل "${loadedCvData.title || 'السيرة الذاتية المحفوظة'}".`,
            });
        } else {
            console.log("No existing CV found, will use defaults.");
            // Optionally toast that a new CV is being created
             toast({
                 title: 'سيرة ذاتية جديدة',
                 description: 'ابدأ بملء النموذج أو قم برفع ملف PDF.',
             });
        }
    } catch (error) {
        console.error('Error loading CV:', error);
        toast({
            title: 'خطأ',
            description: 'لم نتمكن من تحميل بيانات السيرة الذاتية.',
            variant: 'destructive',
        });
    } finally {
        // Normalize the loaded data (or null if none loaded) and reset the form
        const normalizedData = normalizeResumeData(loadedCvData, currentUser);
        form.reset(normalizedData);
        console.log("Form reset with normalized data:", normalizedData);
        setIsLoadingCv(false);
    }
   }, [currentUser, form, toast]); // Dependencies

   // Effect to load CV when currentUser is available
   useEffect(() => {
      if (currentUser?.uid) {
        loadMostRecentCv(currentUser.uid);
      } else {
          // Handle case where user is not logged in (should be handled by ProtectedRoute)
          // Reset form using normalization with null data just in case
          form.reset(normalizeResumeData(null, null));
          setIsLoadingCv(false); // Stop loading if no user
      }
   }, [currentUser, loadMostRecentCv, form]); // Load when user changes

   // Function to handle data population from PDF Uploader
   const handlePdfParsingComplete = (parsedData: Partial<FirestoreResumeData>) => {
     console.log("Received parsed data:", parsedData);
     const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData, currentUser);

     const currentResumeId = form.getValues('resumeId');
     if (currentResumeId && !normalizedData.resumeId) {
         normalizedData.resumeId = currentResumeId;
     }

     try {
         cvSchema.parse(normalizedData);
         form.reset(normalizedData); // Update the entire form state
         toast({
             title: "تم ملء النموذج",
             description: "تم تحديث النموذج بالبيانات المستخرجة. الرجاء المراجعة والحفظ.",
         });
     } catch (error) {
         console.error("Error validating normalized data:", error);
         toast({
             title: "خطأ في البيانات",
             description: `حدث خطأ أثناء التحقق من البيانات المستخرجة. ${error instanceof z.ZodError ? error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') : 'قد تحتاج إلى إدخالها يدويًا.'}`,
             variant: "destructive",
         });
     }
   };


   // Get current form data for the preview component
   const currentFormData = form.watch();

  return (
     // Main container with responsive grid layout
    <div className="flex flex-col h-screen bg-muted/40">
         {/* Header Section */}
        <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
                {/* You can add a logo here if needed */}
            </div>
            {currentUser && (
                <div className="flex items-center gap-2">
                     <span className="text-sm text-muted-foreground hidden md:inline">
                        {currentUser.displayName || currentUser.email}
                     </span>
                    <Button variant="ghost" onClick={signOut} size="sm">
                        <LogOut className="ml-2 h-4 w-4" />
                        تسجيل الخروج
                    </Button>
                </div>
            )}
        </header>

        {/* Main Content Area (Grid for large screens, Flex for smaller) */}
        <main className="flex-1 grid lg:grid-cols-[1fr_1.4fr] xl:grid-cols-[1fr_1.6fr] lg:rtl:grid-cols-[1.4fr_1fr] xl:rtl:grid-cols-[1.6fr_1fr] gap-0 overflow-hidden">
             {/* Left Pane (Preview) - Order 1 on mobile, Left on desktop */}
             <section
               className="bg-white shadow-lg lg:shadow-none lg:border-l lg:rtl:border-l-0 lg:rtl:border-r border-border overflow-y-auto hide-scrollbar order-2 lg:order-1"
               dir="ltr" // Force LTR for the preview pane content
               >
                {/* Pass form data to the preview component */}
                <CvPreview data={currentFormData} />
             </section>

             {/* Right Pane (Form) - Order 1 on mobile, Right on desktop */}
             <section className="overflow-y-auto hide-scrollbar order-1 lg:order-2">
                 {/* Pass form instance and handlers to the form component */}
                 <CvForm
                     form={form}
                     isLoadingCv={isLoadingCv}
                     handlePdfParsingComplete={handlePdfParsingComplete}
                  />
             </section>
        </main>
    </div>
  );
}

// Wrap the main content with ProtectedRoute
export default function Home() {
  return (
    <ProtectedRoute>
      <CvBuilderPageContent />
    </ProtectedRoute>
  );
}
