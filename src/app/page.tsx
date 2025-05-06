'use client';

import * as React from 'react';
import { useState, useCallback, useEffect } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Loader2, LogOut } from 'lucide-react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/AuthContext';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, where, orderBy, limit, onSnapshot, QuerySnapshot, DocumentData, doc } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form';
import { CvPreview } from '@/components/cv-preview';
import { useToast } from '@/hooks/use-toast';
import { Form } from '@/components/ui/form'; // Import the Form component

// Main page component managing layout and data fetching
function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); // State for loading initial CV
  const [isProcessingPdf, setIsProcessingPdf] = useState(false); // State to track if PDF is currently being processed
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth();

  // Initialize the form using react-hook-form
  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser), // Start with empty/default normalized data
    mode: 'onChange', // Validate on change for live preview updates
  });

    // State to track if the "parsing complete" toast has been shown for the current upload
    const [parsingToastShown, setParsingToastShown] = useState(false);

    // Function to handle data population from PDF Uploader (or Firestore listener)
    const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null, source: 'firestore') => {
        console.log(`[updateFormWithData] Source: ${source}, Data Received:`, parsedData);
        // Pass parsedData (which can be null) to normalizeResumeData
        const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
        console.log("[updateFormWithData] Normalized Data:", normalizedData);

        // Preserve the current resumeId if the incoming data doesn't have one
        const currentResumeId = form.getValues('resumeId');
        if (currentResumeId && !normalizedData.resumeId) {
            normalizedData.resumeId = currentResumeId;
            console.log("[updateFormWithData] Preserved existing resumeId:", currentResumeId);
        }
        // Ensure the incoming resumeId (if exists) is used
        else if (parsedData?.resumeId) {
             normalizedData.resumeId = parsedData.resumeId;
        }


        try {
            // No need to manually parse here, resolver handles it on submit/change
            form.reset(normalizedData, { keepDefaultValues: false }); // Update the entire form state
            console.log("[updateFormWithData] Form reset successful.");

            // Check if parsing just completed successfully
            if (source === 'firestore' && parsedData?.parsingDone && !parsedData?.parsingError && !parsingToastShown) {
                 toast({
                     title: "✅ تم استخراج البيانات",
                     description: "تم تحديث النموذج بالبيانات المستخرجة من ملف PDF. يمكنك الآن المراجعة والتعديل.",
                     variant: "default",
                     duration: 7000, // Show longer
                 });
                 setParsingToastShown(true); // Mark toast as shown for this cycle
                 setIsProcessingPdf(false); // Mark processing as finished
            }
             // Check for parsing error
            else if (source === 'firestore' && parsedData?.parsingError && !parsingToastShown) {
                 toast({
                     title: "❌ تعذّر استخراج البيانات تلقائيًا",
                     description: `لم نتمكن من استخراج البيانات من هذا الملف (${parsedData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                     variant: "destructive",
                     duration: 7000,
                 });
                 setParsingToastShown(true); // Mark toast as shown for this cycle
                 setIsProcessingPdf(false); // Mark processing as finished
                 // Optionally reset to defaults if error occurs, or keep partially parsed data?
                 // form.reset(normalizeResumeData(null, currentUser));
            }

        } catch (error) {
            // Catch errors during form.reset if they occur.
            console.error("[updateFormWithData] Error resetting form:", error);
            toast({
                title: "خطأ في تحديث النموذج",
                description: `حدث خطأ أثناء تحديث بيانات النموذج.`,
                variant: "destructive",
            });
            setIsProcessingPdf(false); // Ensure processing state is reset on error
        }
    }, [form, currentUser, toast, parsingToastShown]); // Include parsingToastShown dependency

    // Function to load the most recent CV once
    const loadInitialCv = useCallback(async (userId: string) => {
        console.log("[loadInitialCv] Loading initial CV for user:", userId);
        setIsLoadingCv(true);
        let loadedCvData: FirestoreResumeData | null = null;
        try {
            const resumesRef = collection(db, 'users', userId, 'resumes');
            const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                loadedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                 console.log("[loadInitialCv] Loaded initial CV data:", loadedCvData);
                 // Don't show toast on initial load, let the listener handle parsing messages
                 // toast({
                 //     title: 'تم تحميل السيرة الذاتية',
                 //     description: `تم تحميل "${loadedCvData.title || 'السيرة الذاتية المحفوظة'}".`,
                 // });
                 updateFormWithData(loadedCvData, 'firestore'); // Update form with initial data
            } else {
                console.log("[loadInitialCv] No existing CV found, using defaults.");
                // Reset form with defaults if no CV exists
                updateFormWithData(null, 'firestore');
                 // Optionally toast that a new CV is being started
                 // toast({
                 //     title: 'سيرة ذاتية جديدة',
                 //     description: 'ابدأ بملء النموذج أو قم برفع ملف PDF.',
                 // });
            }
        } catch (error) {
            console.error('[loadInitialCv] Error loading initial CV:', error);
            toast({
                title: 'خطأ',
                description: 'لم نتمكن من تحميل بيانات السيرة الذاتية الأولية.',
                variant: 'destructive',
            });
             updateFormWithData(null, 'firestore'); // Reset form on error
        } finally {
            setIsLoadingCv(false);
             console.log("[loadInitialCv] Finished loading initial CV.");
        }
    }, [updateFormWithData, toast]); // Dependencies for initial load


   // Effect to load initial CV data only once when currentUser is available
   useEffect(() => {
        if (currentUser?.uid && form.getValues('resumeId') === undefined) { // Load only if no resumeId is set yet
            loadInitialCv(currentUser.uid);
        } else if (!currentUser?.uid) {
            // If user logs out, reset the form to defaults
             console.log("[Effect] User logged out, resetting form.");
             updateFormWithData(null, 'firestore');
             setIsLoadingCv(false); // Stop loading if no user
             setIsProcessingPdf(false); // Reset processing state
             setParsingToastShown(false); // Reset toast state
        }
       // We only want this effect to run when the user ID becomes available *initially*
       // or when the user logs out. updateFormWithData is stable.
       // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.uid, loadInitialCv]);


    // Effect to listen for real-time updates (including PDF parsing completion)
    useEffect(() => {
        if (!currentUser?.uid) {
             console.log("[Listener Effect] No user, skipping listener setup.");
             return; // No user, no listener
        }

        const resumesRef = collection(db, 'users', currentUser.uid, 'resumes');
        // Listen to the *most recently updated* document in the resumes subcollection
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));

        console.log(`[Listener Effect] Setting up Firestore listener for user: ${currentUser.uid}`);

        // Reset toast shown flag when setting up a new listener (e.g., after re-login or page refresh)
         setParsingToastShown(false);
         setIsProcessingPdf(false); // Assume not processing initially

        // Set up the listener
        const unsubscribe = onSnapshot(q, (querySnapshot: QuerySnapshot<DocumentData>) => {
            console.log("[Listener Effect] Firestore listener triggered.");
            // Don't set loading here, let updateFormWithData handle UI state based on parsing status
            // setIsLoadingCv(true);

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                const updatedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                console.log("[Listener Effect] Received update:", updatedCvData);

                // Determine if this update represents a *new* PDF being processed
                // Check if parsingDone is true but toast hasn't been shown yet
                if (updatedCvData.parsingDone && !updatedCvData.parsingError && !parsingToastShown) {
                    console.log("[Listener Effect] Detected completed parsing.");
                    setIsProcessingPdf(false); // Processing finished
                    updateFormWithData(updatedCvData, 'firestore'); // Update form and show toast
                }
                // Check if parsing resulted in an error and toast hasn't been shown
                else if (updatedCvData.parsingError && !parsingToastShown) {
                     console.log("[Listener Effect] Detected parsing error.");
                     setIsProcessingPdf(false); // Processing finished (with error)
                     updateFormWithData(updatedCvData, 'firestore'); // Update form and show error toast
                }
                // Handle regular updates (saving, initial load without parsing flag)
                else {
                    // Check if this document is still being processed (upload finished, function running)
                    // We infer this if parsingDone and parsingError are both absent/false
                    if (!updatedCvData.parsingDone && !updatedCvData.parsingError && !isLoadingCv) {
                         // This state means an upload likely just finished, and the function is processing.
                         // We don't have an explicit "processing" flag from the backend, so we infer.
                         console.log("[Listener Effect] Inferring PDF processing state.");
                         setIsProcessingPdf(true); // Show processing indicator
                         // Don't reset the form here, wait for parsingDone or parsingError
                    } else {
                         // Regular save update or initial load state already reflected
                         console.log("[Listener Effect] Regular update or already processed state.");
                         setIsProcessingPdf(false); // Ensure processing indicator is off
                         // Only update form if the data is different from current form state? Maybe not necessary with reset.
                         updateFormWithData(updatedCvData, 'firestore');
                    }
                }

            } else {
                // Handle case where the last resume might have been deleted or no resumes exist yet
                console.log("[Listener Effect] No resumes found for user.");
                // Reset form to defaults if no resumes exist
                updateFormWithData(null, 'firestore');
                 setIsProcessingPdf(false); // Ensure processing indicator is off
            }
            // setIsLoadingCv(false); // Finished processing update notification
        }, (error) => {
            console.error("[Listener Effect] Firestore listener error:", error);
            toast({
                title: 'خطأ في المزامنة',
                description: 'حدث خطأ أثناء الاستماع لتحديثات السيرة الذاتية.',
                variant: 'destructive',
            });
            // setIsLoadingCv(false);
             setIsProcessingPdf(false); // Ensure processing indicator is off on error
        });

        // Cleanup function to unsubscribe the listener when the component unmounts or user changes
        return () => {
            console.log("[Listener Effect] Unsubscribing Firestore listener.");
            unsubscribe();
        };
    // Re-run listener if user changes or the update function ref changes (should be stable)
    }, [currentUser?.uid, toast, updateFormWithData, parsingToastShown, isLoadingCv]);


   // Get current form data for the preview component
   const currentFormData = form.watch();

  return (
     // Main container with flex layout
    <div className="flex flex-col h-screen bg-muted/40">
         {/* Header Section */}
        <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
                {/* You can add a logo here if needed */}
                 {(isLoadingCv || isProcessingPdf) && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{isLoadingCv ? 'جاري تحميل البيانات...' : 'جاري معالجة الملف...'}</span>
                    </div>
                 )}
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

        {/* Main Content Area (Handles responsive layout internally) */}
         {/* Apply flex and direction classes directly to main */}
         <main className="flex-1 flex flex-col-reverse lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden">

            {/* Left Pane (Preview) - Takes remaining space */}
            {/* Force LTR direction for the preview content itself */}
            <section
                className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar"
                dir="ltr" // Keep LTR for preview content consistency
            >
                {/* Pass form data to the preview component */}
                <CvPreview data={currentFormData} />
            </section>

            {/* Right Pane (Form) - Fixed width on lg+, full width on smaller */}
             {/* Use w-full and lg:w-[35%] etc. for responsiveness */}
            <section
                 className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar"
                 // No specific padding here, handled by CvForm's internal padding
            >
                 {/* Wrap CvForm in the FormProvider */}
                 <Form {...form}>
                     <CvForm
                         isLoadingCv={isLoadingCv || isProcessingPdf} // Pass combined loading state
                         // PDF uploader triggers the Cloud Function, listener handles the result
                      />
                 </Form>
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
