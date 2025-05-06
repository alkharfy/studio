'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
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

        const totalDuration = 30000;
        const intervalTime = 100;
        const steps = totalDuration / intervalTime;
        const increment = 100 / steps;

        processingTimerRef.current = setInterval(() => {
            setProcessingProgress((prevProgress) => {
                const newProgress = prevProgress + increment;
                if (newProgress >= 100) {
                    if (processingTimerRef.current) clearInterval(processingTimerRef.current);
                    processingTimerRef.current = null;
                    return 100;
                }
                return newProgress;
            });
        }, intervalTime);
    }, []);

    const stopProcessingTimer = useCallback(() => {
        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current);
            processingTimerRef.current = null;
        }
        setIsProcessingPdf(false);
        setProcessingProgress(0);
    }, []);


    // Function to load the most recent CV once
    const loadInitialCv = useCallback(async (userId: string) => {
        console.info("[loadInitialCv] Loading initial CV for user:", userId);
        setIsLoadingCv(true);
        stopProcessingTimer();
        processedResumeIdRef.current = null;
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
                 if (!loadedCvData.parsingDone && !loadedCvData.parsingError && loadedCvData.storagePath) {
                     console.info("[loadInitialCv] Initial CV might still be processing, listener will confirm.");
                 } else {
                    stopProcessingTimer();
                 }
                 if (loadedCvData.parsingDone && !loadedCvData.parsingError) {
                      processedResumeIdRef.current = loadedCvData.resumeId;
                 } else if (loadedCvData.parsingError) {
                    processedResumeIdRef.current = loadedCvData.resumeId;
                    toast({
                         title: "❌ تعذّر استخراج البيانات تلقائيًا",
                         description: `لم نتمكن من استخراج البيانات من هذا الملف (${loadedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                         variant: "destructive",
                         duration: 7000,
                     });
                 }

            } else {
                console.info("[loadInitialCv] No existing CV found, using defaults.");
                updateFormWithData(null);
                 stopProcessingTimer();
            }
        } catch (error) {
            console.error('[loadInitialCv] Error loading initial CV:', error);
            toast({
                title: 'خطأ',
                description: 'لم نتمكن من تحميل بيانات السيرة الذاتية الأولية.',
                variant: 'destructive',
            });
             updateFormWithData(null);
              stopProcessingTimer();
        } finally {
            setIsLoadingCv(false);
             console.info("[loadInitialCv] Finished loading initial CV.");
        }
    }, [updateFormWithData, toast, stopProcessingTimer]);


   useEffect(() => {
        if (currentUser?.uid && form.getValues('resumeId') === undefined) {
            void loadInitialCv(currentUser.uid); // Added void to handle promise
        } else if (!currentUser?.uid) {
             console.info("[Effect] User logged out, resetting form.");
             updateFormWithData(null);
             setIsLoadingCv(false);
             stopProcessingTimer();
             processedResumeIdRef.current = null;
        }
    }, [currentUser?.uid, loadInitialCv, form, updateFormWithData, stopProcessingTimer]);


    useEffect(() => {
        if (!currentUser?.uid) {
             console.info("[Listener Effect] No user, skipping listener setup.");
             return;
        }

        const resumesRef = collection(db, 'users', currentUser.uid, 'resumes');
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

                let shouldUpdateForm = false;
                if (!currentResumeIdInForm || updatedCvData.resumeId === currentResumeIdInForm || !updatedCvData.resumeId ) {
                    shouldUpdateForm = true;
                     console.info("[Listener Effect] Decided to update form.");
                } else if (updatedCvData.resumeId !== currentResumeIdInForm) {
                    console.info("[Listener Effect] Received update for a different (likely newer) resume ID. Updating form.");
                    shouldUpdateForm = true;
                    processedResumeIdRef.current = null;
                } else {
                    console.info("[Listener Effect] Skipping form update (unclear condition).");
                }


                if (shouldUpdateForm) {
                    updateFormWithData(updatedCvData);
                }

                 const isNewlyProcessed = processedResumeIdRef.current !== updatedCvData.resumeId;

                 if (updatedCvData.parsingDone && !updatedCvData.parsingError && isNewlyProcessed) {
                    console.info("[Listener Effect] Detected completed parsing for new resume ID:", updatedCvData.resumeId);
                    stopProcessingTimer();
                     toast({
                         title: "✅ تم استخراج البيانات",
                         description: "تم تحديث النموذج بالبيانات المستخرجة من ملف PDF. يمكنك الآن المراجعة والتعديل.",
                         variant: "default",
                         duration: 7000,
                     });
                    processedResumeIdRef.current = updatedCvData.resumeId;
                 }
                  else if (updatedCvData.parsingError && isNewlyProcessed) {
                     console.info("[Listener Effect] Detected parsing error for new resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer();
                     toast({
                         title: "❌ تعذّر استخراج البيانات تلقائيًا",
                         description: `لم نتمكن من استخراج البيانات من هذا الملف (${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`,
                         variant: "destructive",
                         duration: 7000,
                     });
                     processedResumeIdRef.current = updatedCvData.resumeId;
                 }
                 else if (!isLoadingCv && !updatedCvData.parsingDone && !updatedCvData.parsingError && updatedCvData.storagePath) {
                    console.info("[Listener Effect] Inferring PDF processing state for resume ID:", updatedCvData.resumeId);
                     if (shouldUpdateForm && !isProcessingPdf) {
                         startProcessingTimer();
                         if (isNewlyProcessed) {
                             processedResumeIdRef.current = null;
                         }
                     }
                 }
                 else if (shouldUpdateForm && !isProcessingPdf) {
                     console.info("[Listener Effect] Regular update or already processed state for resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer();
                 }


            } else {
                console.info("[Listener Effect] No resumes found for user.");
                updateFormWithData(null);
                 stopProcessingTimer();
                 processedResumeIdRef.current = null;
            }
        }, (error) => {
            console.error("[Listener Effect] Firestore listener error:", error);
            toast({
                title: 'خطأ في المزامنة',
                description: 'حدث خطأ أثناء الاستماع لتحديثات السيرة الذاتية.',
                variant: 'destructive',
            });
             stopProcessingTimer();
        });

        return () => {
            console.info("[Listener Effect] Unsubscribing Firestore listener.");
            unsubscribe();
            if (processingTimerRef.current) {
                clearInterval(processingTimerRef.current);
                processingTimerRef.current = null;
            }
        };
    }, [currentUser?.uid, toast, updateFormWithData, isLoadingCv, form, startProcessingTimer, stopProcessingTimer, isProcessingPdf]);


   const currentFormData = form.watch();

    let statusMessage = '';
    if (isLoadingCv) {
        statusMessage = "جاري تحميل البيانات...";
    } else if (isProcessingPdf) {
        statusMessage = "جاري استخراج البيانات...";
    }

  return (
    <div className="flex flex-col h-screen bg-muted/40">
        <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
                {(isLoadingCv || isProcessingPdf) && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{statusMessage}</span>
                        {isProcessingPdf && (
                            <div className="w-24">
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

         <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden">

            <section
                className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar"
                dir="ltr"
            >
                <CvPreview data={currentFormData} />
            </section>

            <section
                 className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar"
            >
                 <FormProvider {...form}>
                   <Form> {/* This was missing, ensure FormProvider wraps the actual <form> or Form component from ShadCN */}
                      <CvForm
                         isLoadingCv={isLoadingCv || isProcessingPdf}
                      />
                   </Form>
                 </FormProvider>
            </section>
        </main>
    </div>
  );
}

export default function Home() {
  return (
    <ProtectedRoute>
      <CvBuilderPageContent />
    </ProtectedRoute>
  );
}
