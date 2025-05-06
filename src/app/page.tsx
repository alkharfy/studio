'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form'; // Removed FormProvider import from here as ShadCN's Form is the provider
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Loader2, LogOut } from 'lucide-react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/AuthContext';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, where, orderBy, limit, onSnapshot, type QuerySnapshot, type DocumentData, doc } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form';
import { CvPreview } from '@/components/cv-preview';
import { useToast } from '@/hooks/use-toast';
import { Form } from '@/components/ui/form'; // Import the Form component from ShadCN (which is FormProvider)
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
        console.info(`[updateFormWithData] Data Received:`, parsedData);
        const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
        console.info("[updateFormWithData] Normalized Data:", normalizedData);

        // Preserve the current resumeId if the incoming data doesn't have one
        const currentResumeId = form.getValues('resumeId');
        if (currentResumeId && !normalizedData.resumeId) {
            normalizedData.resumeId = currentResumeId;
            console.info("[updateFormWithData] Preserved existing resumeId:", currentResumeId);
        }
        // Ensure the incoming resumeId (if exists) is used
        else if (parsedData?.resumeId) {
             normalizedData.resumeId = parsedData.resumeId;
        }

        try {
            form.reset(normalizedData, { keepDefaultValues: false }); // Update the entire form state
            console.info("[updateFormWithData] Form reset successful.");
        } catch (error) {
            console.error("[updateFormWithData] Error resetting form:", error);
            // Handle Zod validation errors specifically
             if (error instanceof (z as any).ZodError) { // Type assertion for ZodError
               console.warn("[updateFormWithData] Zod validation failed on normalized data:", error.errors);
             } else {
                toast({
                    title: "خطأ في تحديث النموذج",
                    description: `حدث خطأ أثناء تحديث بيانات النموذج.`,
                    variant: "destructive",
                });
             }
            setIsProcessingPdf(false);
             if (processingTimerRef.current) clearInterval(processingTimerRef.current);
             setProcessingProgress(0);
        }
    }, [form, currentUser, toast]);

    const startProcessingTimer = useCallback(() => {
        setIsProcessingPdf(true);
        setProcessingProgress(0);

        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current);
        }

        const totalDuration = 30000; // 30 seconds for mock processing
        const intervalTime = 100; // Update every 100ms
        const steps = totalDuration / intervalTime;
        const increment = 100 / steps; // Progress increment per step

        processingTimerRef.current = setInterval(() => {
            setProcessingProgress((prevProgress) => {
                const newProgress = prevProgress + increment;
                if (newProgress >= 100) {
                    if (processingTimerRef.current) clearInterval(processingTimerRef.current);
                    processingTimerRef.current = null; // Clear timer ref
                    return 100;
                }
                return newProgress;
            });
        }, intervalTime);
    }, []);

    const stopProcessingTimer = useCallback(() => {
        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current);
            processingTimerRef.current = null; // Clear timer ref
        }
        setIsProcessingPdf(false);
        setProcessingProgress(0); // Reset progress
    }, []);


    // Function to load the most recent CV once
    const loadInitialCv = useCallback(async (userId: string) => {
        console.info("[loadInitialCv] Loading initial CV for user:", userId);
        setIsLoadingCv(true);
        stopProcessingTimer(); // Stop any ongoing processing timer
        processedResumeIdRef.current = null; // Reset processed ID ref
        let loadedCvData: FirestoreResumeData | null = null;
        try {
            const resumesRef = collection(db, 'users', userId, 'resumes');
            const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                loadedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                 console.info("[loadInitialCv] Loaded initial CV data:", loadedCvData);
                 updateFormWithData(loadedCvData);
                 // If the loaded CV indicates it's still processing (no parsingDone/Error, but has storagePath)
                 // The listener will handle showing the progress.
                 if (!loadedCvData.parsingDone && !loadedCvData.parsingError && loadedCvData.storagePath) {
                     console.info("[loadInitialCv] Initial CV might still be processing, listener will confirm or start timer.");
                     // Do not start timer here, let listener handle it to avoid race conditions
                 } else {
                    stopProcessingTimer(); // Explicitly stop if processing is complete or not applicable
                 }
                 // Track if this CV was already processed to avoid redundant toasts from listener
                 if (loadedCvData.parsingDone && !loadedCvData.parsingError) {
                      processedResumeIdRef.current = loadedCvData.resumeId;
                 } else if (loadedCvData.parsingError) {
                    processedResumeIdRef.current = loadedCvData.resumeId; // Also track errored ones
                    toast({
                         title: "❌ تعذّر استخراج البيانات تلقائيًا",
                         description: `لم نتمكن من استخراج البيانات من هذا الملف (${loadedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                         variant: "destructive",
                         duration: 7000,
                     });
                 }

            } else {
                console.info("[loadInitialCv] No existing CV found, using defaults.");
                updateFormWithData(null); // This will use default normalized data
                 stopProcessingTimer(); // No CV, so no processing
            }
        } catch (error) {
            console.error('[loadInitialCv] Error loading initial CV:', error);
            toast({
                title: 'خطأ',
                description: 'لم نتمكن من تحميل بيانات السيرة الذاتية الأولية.',
                variant: 'destructive',
            });
             updateFormWithData(null); // Fallback to defaults on error
              stopProcessingTimer(); // Stop timer on error
        } finally {
            setIsLoadingCv(false);
             console.info("[loadInitialCv] Finished loading initial CV.");
        }
    }, [updateFormWithData, toast, stopProcessingTimer]);


   useEffect(() => {
        if (currentUser?.uid && form.getValues('resumeId') === undefined) { // Check if resumeId is not yet set in form
            void loadInitialCv(currentUser.uid); // Added void to handle promise
        } else if (!currentUser?.uid) {
             // User logged out or no user
             console.info("[Effect] User logged out or not present, resetting form and stopping timers.");
             updateFormWithData(null); // Reset form to defaults
             setIsLoadingCv(false); // No CV to load
             stopProcessingTimer(); // Ensure any timers are stopped
             processedResumeIdRef.current = null; // Reset processed ID
        }
        // If currentUser.uid exists but resumeId is already set, initial load is considered done or in progress by listener.
    }, [currentUser?.uid, loadInitialCv, form, updateFormWithData, stopProcessingTimer]);


    // Firestore listener for real-time updates
    useEffect(() => {
        if (!currentUser?.uid) {
             console.info("[Listener Effect] No user, skipping listener setup.");
             return () => { /* No-op cleanup */ };
        }

        const resumesRef = collection(db, 'users', currentUser.uid, 'resumes');
        // Listen to the most recently updated resume
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));

        console.info(`[Listener Effect] Setting up Firestore listener for user: ${currentUser.uid}`);

        const unsubscribe = onSnapshot(q, (querySnapshot: QuerySnapshot<DocumentData>) => {
            console.info("[Listener Effect] Firestore listener triggered.");

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                const updatedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                const currentResumeIdInForm = form.getValues('resumeId');

                 console.info("[Listener Effect] Received update for ID:", updatedCvData.resumeId, " | Current form ID:", currentResumeIdInForm);
                 console.info("[Listener Effect] Update data:", updatedCvData);

                // Determine if the form should be updated
                // Update if:
                // 1. The form doesn't have a resumeId yet (initial load scenario)
                // 2. The incoming update is for the same resumeId currently in the form
                // 3. The incoming update has a different (likely newer) resumeId
                let shouldUpdateForm = false;
                if (!currentResumeIdInForm || updatedCvData.resumeId === currentResumeIdInForm || !updatedCvData.resumeId /* Should not happen if doc exists */) {
                    shouldUpdateForm = true;
                     console.info("[Listener Effect] Decided to update form (initial or same ID).");
                } else if (updatedCvData.resumeId !== currentResumeIdInForm) {
                    console.info("[Listener Effect] Received update for a different (likely newer) resume ID. Updating form.");
                    shouldUpdateForm = true;
                    processedResumeIdRef.current = null; // Reset processed ref for new CV
                } else {
                    // This case should ideally not be hit if logic is correct.
                    console.info("[Listener Effect] Skipping form update (unexpected condition).");
                }


                if (shouldUpdateForm) {
                    updateFormWithData(updatedCvData);
                }

                 // Handle toasts and processing state based on the update
                 const isNewlyProcessedOrErrored = processedResumeIdRef.current !== updatedCvData.resumeId;

                 if (updatedCvData.parsingDone && !updatedCvData.parsingError && isNewlyProcessedOrErrored) {
                    console.info("[Listener Effect] Detected completed parsing for new/updated resume ID:", updatedCvData.resumeId);
                    stopProcessingTimer(); // Parsing is done, stop the timer
                     toast({
                         title: "✅ تم استخراج البيانات",
                         description: "تم تحديث النموذج بالبيانات المستخرجة من ملف PDF. يمكنك الآن المراجعة والتعديل.",
                         variant: "default", // Changed to "default" for success
                         duration: 7000,
                     });
                    processedResumeIdRef.current = updatedCvData.resumeId; // Mark as processed
                 }
                  else if (updatedCvData.parsingError && isNewlyProcessedOrErrored) {
                     console.info("[Listener Effect] Detected parsing error for new/updated resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer(); // Parsing failed, stop the timer
                     toast({
                         title: "❌ تعذّر استخراج البيانات تلقائيًا",
                         description: `لم نتمكن من استخراج البيانات من هذا الملف (${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                         variant: "destructive",
                         duration: 7000,
                     });
                     processedResumeIdRef.current = updatedCvData.resumeId; // Mark as processed (with error)
                 }
                 // If not loading initial CV, and PDF isn't done parsing, and has a storage path, it means it's processing
                 else if (!isLoadingCv && !updatedCvData.parsingDone && !updatedCvData.parsingError && updatedCvData.storagePath) {
                    console.info("[Listener Effect] Inferring PDF processing state for resume ID:", updatedCvData.resumeId);
                     // Start timer only if form was updated by this listener event and not already processing
                     if (shouldUpdateForm && !isProcessingPdf) {
                         startProcessingTimer();
                         if (isNewlyProcessedOrErrored) { // If it's a new doc being processed, clear old processed ref
                             processedResumeIdRef.current = null;
                         }
                     }
                 }
                 // If it's a regular update (not processing) or processing is already handled
                 else if (shouldUpdateForm && isProcessingPdf && (updatedCvData.parsingDone || updatedCvData.parsingError)) {
                     // This case means processing was ongoing, but now it's finished (either success or error)
                     // The toasts above would have handled it, so just ensure timer stops.
                     console.info("[Listener Effect] Processing finished for resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer();
                 } else if (shouldUpdateForm && !isProcessingPdf) {
                      // General update, not related to PDF processing start/end
                      console.info("[Listener Effect] Regular update or already processed state for resume ID:", updatedCvData.resumeId);
                      stopProcessingTimer(); // Ensure timer is off if no processing state indicated
                 }


            } else {
                // No resumes found for the user
                console.info("[Listener Effect] No resumes found for user.");
                updateFormWithData(null); // Reset form to defaults
                 stopProcessingTimer(); // Stop any timers
                 processedResumeIdRef.current = null; // Clear processed ref
            }
        }, (error) => {
            console.error("[Listener Effect] Firestore listener error:", error);
            toast({
                title: 'خطأ في المزامنة',
                description: 'حدث خطأ أثناء الاستماع لتحديثات السيرة الذاتية.',
                variant: 'destructive',
            });
             stopProcessingTimer(); // Stop timer on error
        });

        // Cleanup on unmount
        return () => {
            console.info("[Listener Effect] Unsubscribing Firestore listener.");
            unsubscribe();
            if (processingTimerRef.current) { // Also clear the interval on unmount
                clearInterval(processingTimerRef.current);
                processingTimerRef.current = null;
            }
        };
    }, [currentUser?.uid, toast, updateFormWithData, isLoadingCv, form, startProcessingTimer, stopProcessingTimer, isProcessingPdf]);


   // Watch form data for preview updates
   const currentFormData = form.watch(); // This gives the current state of all form fields

    // Determine status message for header
    let statusMessage = '';
    if (isLoadingCv) {
        statusMessage = "جاري تحميل البيانات...";
    } else if (isProcessingPdf) {
        statusMessage = "جاري استخراج البيانات...";
    }

  return (
    <div className="flex flex-col h-screen bg-muted/40">
        {/* Header Section */}
        <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
                {/* Loading/Processing Indicator */}
                {(isLoadingCv || isProcessingPdf) && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{statusMessage}</span>
                        {isProcessingPdf && ( // Only show progress bar if PDF is processing
                            <div className="w-24"> {/* Container for progress bar */}
                                <Progress value={processingProgress} className="h-2" />
                            </div>
                        )}
                    </div>
                )}
            </div>
            {/* User Info & Sign Out */}
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

        {/* Main Content Area: Split Pane Layout */}
         <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden"> {/* Added overflow-hidden */}

            {/* Left Pane: CV Preview */}
            <section
                // className="flex-1 bg-white rounded-lg shadow overflow-auto hide-scrollbar" // Original
                className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar" // Consistent shadow
                dir="ltr" // Force LTR for preview content
            >
                <CvPreview data={currentFormData} />
            </section>

            {/* Right Pane: CV Form */}
            <section
                 // className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow overflow-y-auto hide-scrollbar pr-4" // Original
                 className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar" // Consistent shadow, removed pr-4 as form sections have own padding
            >
                 {/*
                    ShadCN's <Form> component IS the FormProvider.
                    We pass the form methods from useForm directly to it.
                 */}
                 <Form {...form}> {/* Pass all form methods here */}
                      <CvForm
                         isLoadingCv={isLoadingCv || isProcessingPdf} // Pass loading state to disable form fields
                         // onDataParse={updateFormWithData} // Replaced by direct Firestore listener
                         // currentResumeId={form.getValues('resumeId')} // Pass current resumeId
                      />
                 </Form>
            </section>
        </main>
    </div>
  );
}

// Main export - wraps content with ProtectedRoute
export default function Home() {
  return (
    <ProtectedRoute>
      <CvBuilderPageContent />
    </ProtectedRoute>
  );
}

