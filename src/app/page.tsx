'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
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
import { Progress } from '@/components/ui/progress'; // Import Progress component

// Main page component managing layout and data fetching
function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); // State for loading initial CV
  const [isProcessingPdf, setIsProcessingPdf] = useState(false); // State to track if PDF is currently being processed
  const [processingProgress, setProcessingProgress] = useState(0); // Progress for the fake timer
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth();
  const processedResumeIdRef = useRef<string | null>(null); // Ref to track shown toast
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null); // Ref for the timer interval

  // Initialize the form using react-hook-form
  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser), // Start with empty/default normalized data
    mode: 'onChange', // Validate on change for live preview updates
  });

    // Function to handle data population from PDF Uploader (or Firestore listener)
    const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null) => {
        console.log(`[updateFormWithData] Data Received:`, parsedData);
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
            // Validate the normalized data before resetting the form
            // We removed the strict validation here to allow partial updates from listeners
            // form validation will still happen on user interaction/submit
            form.reset(normalizedData, { keepDefaultValues: false }); // Update the entire form state
            console.log("[updateFormWithData] Form reset successful.");
        } catch (error) {
            console.error("[updateFormWithData] Error resetting form:", error);
            // Handle Zod validation errors specifically
             if (error instanceof z.ZodError) {
               console.warn("[updateFormWithData] Zod validation failed on normalized data:", error.errors);
               // Decide if a toast is needed here. Usually, the form validation will show errors.
               // We might want to log this warning but not show a user-facing error unless reset fails.
             } else {
                toast({
                    title: "خطأ في تحديث النموذج",
                    description: `حدث خطأ أثناء تحديث بيانات النموذج.`,
                    variant: "destructive",
                });
             }
            setIsProcessingPdf(false); // Ensure processing state is reset on error
             if (processingTimerRef.current) clearInterval(processingTimerRef.current); // Clear timer on error
             setProcessingProgress(0); // Reset progress
        }
    }, [form, currentUser, toast]);

    // Function to start the fake processing timer
    const startProcessingTimer = useCallback(() => {
        setIsProcessingPdf(true);
        setProcessingProgress(0); // Reset progress

        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current); // Clear existing timer
        }

        // Estimate: 30 seconds total (adjust as needed based on function timeout/average time)
        const totalDuration = 30000; // 30 seconds in ms
        const intervalTime = 100; // Update every 100ms
        const steps = totalDuration / intervalTime;
        const increment = 100 / steps;

        processingTimerRef.current = setInterval(() => {
            setProcessingProgress((prevProgress) => {
                const newProgress = prevProgress + increment;
                if (newProgress >= 100) {
                    clearInterval(processingTimerRef.current!);
                    processingTimerRef.current = null;
                    // Don't automatically set isProcessingPdf to false here, wait for Firestore update
                    return 100;
                }
                return newProgress;
            });
        }, intervalTime);
    }, []);

    // Function to stop the processing timer
    const stopProcessingTimer = useCallback(() => {
        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current);
            processingTimerRef.current = null;
        }
        setIsProcessingPdf(false);
        setProcessingProgress(0); // Reset progress fully
    }, []);


    // Function to load the most recent CV once
    const loadInitialCv = useCallback(async (userId: string) => {
        console.log("[loadInitialCv] Loading initial CV for user:", userId);
        setIsLoadingCv(true);
        stopProcessingTimer(); // Stop any previous timers
        processedResumeIdRef.current = null; // Reset processed ID ref on initial load
        let loadedCvData: FirestoreResumeData | null = null;
        try {
            const resumesRef = collection(db, 'users', userId, 'resumes');
            const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                loadedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                 console.log("[loadInitialCv] Loaded initial CV data:", loadedCvData);
                 // Update form with initial data
                 updateFormWithData(loadedCvData);
                 // Set initial processing state based on loaded data
                 if (!loadedCvData.parsingDone && !loadedCvData.parsingError && loadedCvData.storagePath) {
                     // Don't start timer here, wait for listener to confirm processing state
                     // setIsProcessingPdf(true); // Still processing if flags aren't set and storagePath exists
                     console.log("[loadInitialCv] Initial CV might still be processing, listener will confirm.");
                 } else {
                    stopProcessingTimer(); // Ensure it's stopped otherwise
                 }
                 // Pre-populate the ref if the loaded CV was already processed successfully
                 if (loadedCvData.parsingDone && !loadedCvData.parsingError) {
                      processedResumeIdRef.current = loadedCvData.resumeId;
                 }

            } else {
                console.log("[loadInitialCv] No existing CV found, using defaults.");
                // Reset form with defaults if no CV exists
                updateFormWithData(null);
                 stopProcessingTimer(); // Ensure processing state is off
            }
        } catch (error) {
            console.error('[loadInitialCv] Error loading initial CV:', error);
            toast({
                title: 'خطأ',
                description: 'لم نتمكن من تحميل بيانات السيرة الذاتية الأولية.',
                variant: 'destructive',
            });
             updateFormWithData(null); // Reset form on error
              stopProcessingTimer(); // Ensure processing state is off
        } finally {
            setIsLoadingCv(false);
             console.log("[loadInitialCv] Finished loading initial CV.");
        }
    }, [updateFormWithData, toast, stopProcessingTimer]); // Dependencies for initial load


   // Effect to load initial CV data only once when currentUser is available
   useEffect(() => {
        if (currentUser?.uid && form.getValues('resumeId') === undefined) { // Load only if no resumeId is set yet
            loadInitialCv(currentUser.uid);
        } else if (!currentUser?.uid) {
            // If user logs out, reset the form to defaults
             console.log("[Effect] User logged out, resetting form.");
             updateFormWithData(null);
             setIsLoadingCv(false); // Stop loading if no user
             stopProcessingTimer(); // Reset processing state
             processedResumeIdRef.current = null; // Reset ref
        }
       // We only want this effect to run when the user ID becomes available *initially*
       // or when the user logs out.
       // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.uid, loadInitialCv]); // Removed updateFormWithData from here


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

        // Set up the listener
        const unsubscribe = onSnapshot(q, (querySnapshot: QuerySnapshot<DocumentData>) => {
            console.log("[Listener Effect] Firestore listener triggered.");

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                const updatedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                const currentResumeIdInForm = form.getValues('resumeId'); // Get current form resume ID

                 console.log("[Listener Effect] Received update for ID:", updatedCvData.resumeId, " | Current form ID:", currentResumeIdInForm);
                 console.log("[Listener Effect] Update data:", updatedCvData);

                let shouldUpdateForm = false;
                // If the form has no ID yet, or the update is for the current ID, or it's a new resume ID
                if (!currentResumeIdInForm || updatedCvData.resumeId === currentResumeIdInForm || !updatedCvData.resumeId ) {
                    shouldUpdateForm = true;
                     console.log("[Listener Effect] Decided to update form.");
                } else if (updatedCvData.resumeId !== currentResumeIdInForm) {
                    // If the update is for a *different* resume ID than the one currently in the form,
                    // it implies a new upload/parse has completed or a different resume was saved.
                    // We *should* update the form to reflect the latest resume.
                    console.log("[Listener Effect] Received update for a different (likely newer) resume ID. Updating form.");
                    shouldUpdateForm = true;
                    processedResumeIdRef.current = null; // Reset toast ref as we are loading a new resume
                } else {
                    console.log("[Listener Effect] Skipping form update (unclear condition).");
                }


                if (shouldUpdateForm) {
                    // Update form state with the latest data first
                    updateFormWithData(updatedCvData);
                }

                 // --- State Management based on updatedCvData ---
                 const isNewlyProcessed = processedResumeIdRef.current !== updatedCvData.resumeId;

                // Check if parsing finished successfully for the specific resume ID being updated
                 if (updatedCvData.parsingDone && !updatedCvData.parsingError && isNewlyProcessed) {
                    console.log("[Listener Effect] Detected completed parsing for new resume ID:", updatedCvData.resumeId);
                    stopProcessingTimer(); // Stop timer on success
                     toast({
                         title: "✅ تم استخراج البيانات",
                         description: "تم تحديث النموذج بالبيانات المستخرجة من ملف PDF. يمكنك الآن المراجعة والتعديل.",
                         variant: "default",
                         duration: 7000, // Show longer
                     });
                    processedResumeIdRef.current = updatedCvData.resumeId; // Mark this ID as processed
                 }
                 // Check if parsing resulted in an error for the specific resume ID being updated
                  else if (updatedCvData.parsingError && isNewlyProcessed) {
                     console.log("[Listener Effect] Detected parsing error for new resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer(); // Stop timer on error
                     toast({
                         title: "❌ تعذّر استخراج البيانات تلقائيًا",
                         description: `لم نتمكن من استخراج البيانات من هذا الملف (${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                         variant: "destructive",
                         duration: 7000,
                     });
                     processedResumeIdRef.current = updatedCvData.resumeId; // Mark this ID as processed (even with error)
                 }
                 // Check if the document is still being processed (flags not set) after initial load is done
                 // Added check for storagePath to ensure it's an uploaded file being processed
                 else if (!isLoadingCv && !updatedCvData.parsingDone && !updatedCvData.parsingError && updatedCvData.storagePath) {
                    console.log("[Listener Effect] Inferring PDF processing state for resume ID:", updatedCvData.resumeId);
                     // Only start processing timer if it's for the current/latest resume AND it's not already running
                     if (shouldUpdateForm && !isProcessingPdf) {
                         startProcessingTimer(); // Start the fake timer
                         // Reset toast ref if a new upload starts processing for the *current* resume
                         if (isNewlyProcessed) {
                             processedResumeIdRef.current = null;
                         }
                     }
                 }
                 // Handle regular updates or already processed states for the current resume
                 else if (shouldUpdateForm && !isProcessingPdf) { // Make sure timer stops if update is not 'processing'
                     console.log("[Listener Effect] Regular update or already processed state for resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer(); // Ensure processing indicator and timer are off
                 }


            } else {
                // Handle case where the last resume might have been deleted or no resumes exist yet
                console.log("[Listener Effect] No resumes found for user.");
                // Reset form to defaults if no resumes exist
                updateFormWithData(null);
                 stopProcessingTimer(); // Ensure processing indicator is off
                 processedResumeIdRef.current = null; // Reset ref
            }
        }, (error) => {
            console.error("[Listener Effect] Firestore listener error:", error);
            toast({
                title: 'خطأ في المزامنة',
                description: 'حدث خطأ أثناء الاستماع لتحديثات السيرة الذاتية.',
                variant: 'destructive',
            });
             stopProcessingTimer(); // Ensure processing indicator is off on error
        });

        // Cleanup function to unsubscribe the listener when the component unmounts or user changes
        return () => {
            console.log("[Listener Effect] Unsubscribing Firestore listener.");
            unsubscribe();
            if (processingTimerRef.current) { // Clear timer on unmount
                clearInterval(processingTimerRef.current);
                processingTimerRef.current = null;
            }
        };
    // Re-run listener ONLY if user changes OR initial loading finishes. updateFormWithData is stable.
    }, [currentUser?.uid, toast, updateFormWithData, isLoadingCv, form, startProcessingTimer, stopProcessingTimer, isProcessingPdf]); // Added form and timer functions dependency


   // Get current form data for the preview component
   const currentFormData = form.watch();

   // Determine the message based on loading/processing state
    let statusMessage = '';
    if (isLoadingCv) {
        statusMessage = "جاري تحميل البيانات...";
    } else if (isProcessingPdf) {
        statusMessage = "جاري استخراج البيانات...";
    }

  return (
     // Main container with flex layout
    <div className="flex flex-col h-screen bg-muted/40">
         {/* Header Section */}
        <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
                {/* Status Indicator */}
                {(isLoadingCv || isProcessingPdf) && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{statusMessage}</span>
                        {isProcessingPdf && (
                            <div className="w-24"> {/* Fixed width for progress bar */}
                                <Progress value={processingProgress} className="h-2" />
                            </div>
                        )}
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

        {/* Main Content Area */}
         <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden">

            {/* Left Pane (Preview) */}
            <section
                className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar"
                dir="ltr" // Keep LTR for preview content consistency
            >
                <CvPreview data={currentFormData} />
            </section>

            {/* Right Pane (Form) */}
            <section
                 className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar"
            >
                 {/* Wrap CvForm in the Form Provider */}
                 <FormProvider {...form}>
                     <CvForm
                         isLoadingCv={isLoadingCv || isProcessingPdf} // Pass combined loading state
                      />
                 </FormProvider>
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
