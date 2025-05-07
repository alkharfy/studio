// src/app/page.tsx
'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form'; // RHF import
import { zodResolver } from '@hookform/resolvers/zod';
import type { z as Zod } from 'zod'; // aliased z to Zod to avoid conflict if z is used as a variable
import { Button } from '@/components/ui/button';
import { Loader2, LogOut } from 'lucide-react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/AuthContext';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, where, orderBy, limit, onSnapshot, type DocumentData, doc, type QuerySnapshot } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form';
import { CvPreview } from '@/components/cv-preview';
import { useToast } from '@/hooks/use-toast';
import { Form } from '@/components/ui/form'; // Import the Form component from ShadCN
import { Progress } from '@/components/ui/progress'; // Import Progress component


// Main page component managing layout and data fetching
function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); // For initial load or when switching resumes
  const [isProcessingPdf, setIsProcessingPdf] = useState(false); // True when PDF is uploaded and backend is processing
  const [processingProgress, setProcessingProgress] = useState(0); // Progress for the UI timer
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth();
  const processedResumeIdRef = useRef<string | null>(null); // Tracks the ID of the resume that has been processed by AI
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null); // The ID of the resume being actively listened to
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null); // Ref for the processing timer interval

  // Initialize React Hook Form
  const form = useForm<CvFormData>({ // Pass the Zod schema for validation
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser), // Initialize with default or user-specific values
    mode: 'onChange', // Validate on change for better UX
  });

    // Callback to update the form with new data (from Firestore or initial load)
    const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null) => {
        console.info(`[updateFormWithData] Data Received:`, parsedData); // Log incoming data
        const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
        console.info("[updateFormWithData] Normalized Data:", normalizedData);

        try {
            // Validate normalized data against schema before resetting form
            // This helps catch issues if Firestore data doesn't match form expectations
            cvSchema.parse(normalizedData);
            form.reset(normalizedData, { keepDefaultValues: false }); // Update the entire form state
            console.info("[updateFormWithData] Form reset successful.");
        } catch (error: any) { // Explicitly type error
            console.error("[updateFormWithData] Error resetting form:", error);
            // If Zod validation fails, log the specific errors
             if (error.name === 'ZodError') { // Check if it's a ZodError
               console.warn("[updateFormWithData] Zod validation failed on normalized data:", error.errors);
               // Optionally, show a less technical toast to the user if this happens often
               // toast({ title: "خطأ في البيانات", description: "تعذر تحديث النموذج ببيانات غير متوافقة.", variant: "destructive" });
             } else {
                toast({
                    title: "خطأ في تحديث النموذج",
                    description: `حدث خطأ أثناء تحديث بيانات النموذج.`,
                    variant: "destructive",
                });
             }
            // If form update fails, ensure any processing state is cleared
            setIsProcessingPdf(false);
            if (processingTimerRef.current) clearInterval(processingTimerRef.current);
             setProcessingProgress(0);
        }
    }, [form, currentUser, toast]);

    // Function to start a simulated progress timer for PDF processing
    const startProcessingTimer = useCallback(() => {
        setIsProcessingPdf(true);
        setProcessingProgress(0);

        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current); // Clear any existing timer
        }

        const totalDuration = 30000; // 30 seconds for simulation
        const intervalTime = 100; // Update every 100ms
        const steps = totalDuration / intervalTime;
        const increment = 100 / steps; // Progress increment per step

        processingTimerRef.current = setInterval(() => {
            setProcessingProgress((prevProgress) => {
                const newProgress = prevProgress + increment;
                if (newProgress >= 100) {
                    if (processingTimerRef.current) clearInterval(processingTimerRef.current);
                    processingTimerRef.current = null; // Clear ref after finishing
                    return 100;
                }
                return newProgress;
            });
        }, intervalTime);
    }, []);

    // Function to stop the progress timer and reset processing state
    const stopProcessingTimer = useCallback(() => {
        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current);
            processingTimerRef.current = null; // Clear ref
        }
        setIsProcessingPdf(false);
        setProcessingProgress(0); // Reset progress
    }, []);


    // Effect to load the initial CV data when the component mounts or user changes
    // This now primarily sets up the listener for `latestResumeId` on the user document.
    const loadInitialCv = useCallback(async (userId: string) => {
        console.info("[loadInitialCv] Loading initial CV for user:", userId);
        setIsLoadingCv(true);
        stopProcessingTimer(); // Ensure no old timers are running
        processedResumeIdRef.current = null; // Reset processed ID tracker
        let loadedCvData: FirestoreResumeData | null = null;
        try {
            // Fetch the most recently updated resume as a fallback or initial state
            const resumesRef = collection(db, 'users', userId, 'resumes');
            const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                loadedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                 console.info("[loadInitialCv] Loaded initial CV data:", loadedCvData);
                 updateFormWithData(loadedCvData); // Populate form with this data
                 // If the loaded CV is still processing, the main listener will handle the timer
                 // No need to start timer here explicitly, rely on the main listener's logic.
                 if (!loadedCvData.parsingDone && !loadedCvData.parsingError && loadedCvData.storagePath) {
                     console.info("[loadInitialCv] Initial CV might still be processing, listener will confirm or start timer.");
                     // The main listener will check this and start the timer if needed.
                 } else {
                    stopProcessingTimer(); // Explicitly stop if it's done or errored
                 }
                 // Track if this initial CV was already processed or errored
                 if (loadedCvData.parsingDone && !loadedCvData.parsingError) {
                      processedResumeIdRef.current = loadedCvData.resumeId;
                 } else if (loadedCvData.parsingError) {
                    processedResumeIdRef.current = loadedCvData.resumeId; // Mark as "processed" in terms of UI handling
                    toast({
                         title: "❌ تعذّر استخراج البيانات تلقائيًا",
                         description: `لم نتمكن من استخراج البيانات من هذا الملف (${loadedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                         variant: "destructive",
                         duration: 7000,
                     });
                 }

            } else {
                console.info("[loadInitialCv] No existing CV found, using defaults.");
                updateFormWithData(null); // Reset form to defaults
                 stopProcessingTimer(); // No processing to do
            }
        } catch (error) {
            console.error('[loadInitialCv] Error loading initial CV:', error);
            toast({
                title: 'خطأ',
                description: 'لم نتمكن من تحميل بيانات السيرة الذاتية الأولية.',
                variant: 'destructive',
            });
             updateFormWithData(null); // Reset form on error
              stopProcessingTimer(); // Stop any timers
        } finally {
            setIsLoadingCv(false);
             console.info("[loadInitialCv] Finished loading initial CV.");
        }
    }, [updateFormWithData, toast, stopProcessingTimer]);

    // Effect to listen for changes to `latestResumeId` on the user's document
    // This drives which resume document the main listener below will attach to.
   useEffect(() => {
        if (!currentUser?.uid) {
            console.info("[User Listener] No user, skipping listener setup.");
            setCurrentResumeId(null); // Clear current resume ID if no user
            return () => { /* No-op cleanup */ };
        }

        console.info(`[User Listener] Setting up Firestore listener for user document: users/${currentUser.uid}`);
        const userDocRef = doc(db, "users", currentUser.uid);

       const unsubscribe = onSnapshot(userDocRef, (docSnap: DocumentData) => {
            const latestId = docSnap.data()?.latestResumeId || null;
            console.info("[User Listener] latestResumeId updated to:", latestId);
            setCurrentResumeId(latestId); // Update state, which triggers the resume listener
        });
        return unsubscribe; // Cleanup listener on unmount or user change
    }, [currentUser?.uid]); // Rerun when user changes

   // Effect to handle initial load or when user logs out
   useEffect(() => {
        if (currentUser?.uid && currentResumeId === null) { // User is logged in, but no latestResumeId yet (or it was null)
            // This case might mean the user document doesn't have `latestResumeId` or it's explicitly null.
            // `loadInitialCv` will be called to fetch the most recent one by timestamp as a fallback.
            loadInitialCv(currentUser.uid);
        } else if (!currentUser?.uid) {
             // User logged out or was never logged in
             console.info("[Effect] User logged out or not present, resetting form and stopping timers.");
             updateFormWithData(null); // Reset form to defaults
             setIsLoadingCv(false); // Not loading anymore
             stopProcessingTimer(); // Stop any active timers
             processedResumeIdRef.current = null; // Reset processed ID tracker
        } else if (currentUser?.uid && currentResumeId) {
            // If there's a user and a specific resume ID to load (either from latestResumeId or direct navigation)
            // This will be handled by the main listener effect below.
            // We no longer call loadInitialCv directly from here, to avoid race conditions with the listener.
        }
    }, [currentUser?.uid, currentResumeId, updateFormWithData, loadInitialCv, stopProcessingTimer]);

    // Main effect to listen to the specific resume document (`currentResumeId`)
    // This effect handles updates to the resume data, including parsing status.
    useEffect(() => {
        // If no user or no current resume ID, don't set up a listener
        if (!currentUser?.uid || !currentResumeId) {
           console.info("[Listener Effect] No user or currentResumeId, skipping listener setup.");
             // If there's no currentResumeId but a user exists, it implies either no resumes or initial state.
             // `loadInitialCv` (called from the effect above) handles loading the default/latest one.
             // If user is null, the other effect handles resetting the form.
             return () => { /* No-op cleanup */ };
        }

        // Reference to the specific resume document
        const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);

        console.info(`[Listener Effect] Setting up Firestore listener for document: users/${currentUser.uid}/resumes/${currentResumeId}`);

        const unsubscribe = onSnapshot(resumeDocRef, (docSnap: DocumentData) => { // Firestore DocumentData type
            const currentResumeIdInForm = form.getValues('resumeId');

            if (docSnap.exists()) { // Check if the document exists
                const cvDoc = docSnap; // Use docSnap directly
                const updatedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;

                 console.info("[Listener Effect] Received update for ID:", updatedCvData.resumeId, " | Current form ID:", currentResumeIdInForm);
                 console.info("[Listener Effect] Update data:", updatedCvData); // Log the received data for debugging
                
                // Determine if the form should be updated based on the incoming data.
                // This helps prevent unnecessary form resets if the listener picks up an old event
                // or if the data is for a different resume than what's currently intended.
                const shouldUpdateForm = updatedCvData.resumeId === currentResumeIdInForm || !currentResumeIdInForm || updatedCvData.resumeId === currentResumeId;

                if (shouldUpdateForm) {
                    updateFormWithData(updatedCvData);
                }

                 // Check if this update is for a newly processed (or errored) resume
                 // We use processedResumeIdRef to avoid showing toasts repeatedly for the same processed/errored resume.
                 const isNewlyProcessedOrErrored = processedResumeIdRef.current !== updatedCvData.resumeId;

                 if (updatedCvData.parsingDone && !updatedCvData.parsingError && isNewlyProcessedOrErrored) {
                    console.info("[Listener Effect] Detected completed parsing for new/updated resume ID:", updatedCvData.resumeId);
                    stopProcessingTimer(); // Stop the simulated progress
                     toast({
                         title: "✅ تم استخراج البيانات",
                         description: "تم تحديث النموذج بالبيانات المستخرجة من ملف PDF. يمكنك الآن المراجعة والتعديل.",
                         variant: "default", // Success variant
                         duration: 7000,
                     });
                    processedResumeIdRef.current = updatedCvData.resumeId; // Mark this ID as processed
                 }
                  else if (updatedCvData.parsingError && isNewlyProcessedOrErrored) {
                     console.info("[Listener Effect] Detected parsing error for new/updated resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer(); // Stop the simulated progress
                     toast({
                         title: "❌ تعذّر استخراج البيانات تلقائيًا",
                         description: `لم نتمكن من استخراج البيانات من هذا الملف (${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                         variant: "destructive",
                         duration: 7000,
                     });
                     processedResumeIdRef.current = updatedCvData.resumeId; // Mark this ID as "processed" (with error)
                 }
                 // If the resume is not yet parsed, not errored, has a storage path (meaning it was uploaded),
                 // and the form should be updated (meaning this is the relevant resume),
                 // and a timer isn't already running, then start the processing timer.
                 else if (shouldUpdateForm && !isLoadingCv && !updatedCvData.parsingDone && !updatedCvData.parsingError && updatedCvData.storagePath) {
                    console.info("[Listener Effect] Inferring PDF processing state for resume ID:", updatedCvData.resumeId);
                     // Start timer only if it's not already running for this resume
                     if (!isProcessingPdf) { // Check against the component's processing state
                         startProcessingTimer();
                         if (isNewlyProcessedOrErrored) { // If it's a new PDF upload being tracked
                             processedResumeIdRef.current = null; // Reset, so we can show toast when it's done/errored
                         }
                     }
                 }
                 // If the form should update, and it was processing, but now it's done or errored, stop the timer.
                 else if (shouldUpdateForm && isProcessingPdf && (updatedCvData.parsingDone || updatedCvData.parsingError)) {
                     // This condition handles the case where the timer was running and the status changed.
                     // The toasts above already cover the "newly processed/errored" case.
                     console.info("[Listener Effect] Processing finished for resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer();
                 } else if (shouldUpdateForm && !isProcessingPdf) {
                      // This covers cases where data changes but it's not related to a new PDF processing cycle
                      // e.g., manual edits saved, or a pre-parsed resume is loaded.
                      console.info("[Listener Effect] Regular update or already processed state for resume ID:", updatedCvData.resumeId);
                      stopProcessingTimer(); // Ensure timer is stopped if it's not a processing scenario
                 }


            } else {
                // Document does not exist (e.g., deleted or never created)
                console.info(`[Listener Effect] Document users/${currentUser.uid}/resumes/${currentResumeId} does not exist.`);
                // If this was the resume the form was showing, reset the form
                if (currentResumeId === currentResumeIdInForm || !currentResumeIdInForm) {
                    updateFormWithData(null);
                }
                 stopProcessingTimer();
                 processedResumeIdRef.current = null;
            }
        }, (error) => { // Error callback for the listener
           console.error(`[Listener Effect] Firestore listener error for ${currentResumeId}:`, error);
            toast({
                title: 'خطأ في المزامنة',
                description: 'حدث خطأ أثناء الاستماع لتحديثات السيرة الذاتية.',
                variant: 'destructive',
            });
             stopProcessingTimer(); // Stop timer on listener error
        });

        // Cleanup function for the effect
        return () => {
            console.info("[Listener Effect] Unsubscribing Firestore listener.");
            unsubscribe();
            if (processingTimerRef.current) { // Also clear the interval if the component unmounts
                clearInterval(processingTimerRef.current);
                processingTimerRef.current = null;
            }
        };
   // Key dependencies for this effect. Rerun if user, currentResumeId, or certain callbacks change.
   // `isProcessingPdf` is included because `startProcessingTimer` depends on its current value.
   // `form` is included because `form.getValues` is used.
   // `isLoadingCv` is included to ensure timer logic doesn't start prematurely.
   }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, form, isLoadingCv]);


   // Watch the entire form data to pass to the CvPreview component
   const currentFormData = form.watch(); // This gets all form values

    // Determine status message for loading/processing states
    let statusMessage = '';
    if (isLoadingCv) {
        statusMessage = "جاري تحميل البيانات...";
    } else if (isProcessingPdf) {
        statusMessage = "جاري استخراج البيانات...";
    }

    // The main layout is a flex container that fills the screen height
    // On large screens (lg), it's a row (RTL reversed). On smaller screens, it stacks.
    // `hide-scrollbar` is a utility class to hide scrollbars on specific elements.

  return (
    <div className="flex flex-col h-screen bg-muted/40">
        {/* Header Section */}
        <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
                {/* Display loading/processing status */}
                {(isLoadingCv || isProcessingPdf) && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{statusMessage}</span>
                        {isProcessingPdf && ( // Show progress bar only when processing PDF
                            <div className="w-24"> {/* Fixed width for the progress bar container */}
                                <Progress value={processingProgress} className="h-2" />
                            </div>
                        )}
                    </div>
                )}
            </div>
            {/* User information and Sign Out button */}
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

        {/* Main content area: Two-column layout for CV Preview and Form */}
         <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden"> {/* Added overflow-hidden */}

            {/* Left Section (CV Preview) - Takes up more space on lg screens */}
            <section
                // `flex-1` makes it take available space. `lg:w-[65%]` could also work.
                className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar" 
                dir="ltr" // Force LTR for consistent preview rendering
            >
                <CvPreview data={currentFormData} />
            </section>

            {/* Right Section (CV Form) - Fixed width on lg screens */}
            <section
                 // `lg:w-[35%]` and `lg:min-w-[340px]` control width on large screens
                 className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar" 
            >
                 {/* Wrap CvForm in the FormProvider */}
                 <Form {...form}> 
                      <CvForm
                         isLoadingCv={isLoadingCv || isProcessingPdf} // Pass combined loading state
                         // updateCvData is no longer passed; form context handles updates
                         // onPdfUploadInitiated={startProcessingTimer} // No longer needed here, handled by listener
                      />
                 </Form>
            </section>
        </main>
    </div>
  );
}

// Exported Home component that wraps CvBuilderPageContent with ProtectedRoute
export default function Home() {
  return (
    <ProtectedRoute>
      <CvBuilderPageContent />
    </ProtectedRoute>
  );
}

