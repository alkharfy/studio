// src/app/page.tsx
'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Loader2, LogOut, Download } from 'lucide-react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/AuthContext';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, where, orderBy, limit, onSnapshot, type DocumentData, doc, type QuerySnapshot, setDoc, updateDoc, serverTimestamp as firestoreServerTimestamp, getDoc } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form';
import { CvPreview } from '@/components/cv-preview';
import { useToast } from '@/hooks/use-toast';
import { Form } from '@/components/ui/form';
import { Progress } from '@/components/ui/progress';


function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true);
  const [isProcessingPdf, setIsProcessingPdf] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth();
  const processedResumeIdRef = useRef<string | null>(null);
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null);
  const [currentRawResumeData, setCurrentRawResumeData] = useState<FirestoreResumeData | null>(null);
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser),
    mode: 'onChange',
  });

  const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null) => {
    console.info(`[updateFormWithData] Received data to update form with. Current Resume ID: ${currentResumeId}`, parsedData);
    const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
    console.info("[updateFormWithData] Normalized Data for form reset:", normalizedData);

    try {
      cvSchema.parse(normalizedData); // Validate before reset
      form.reset(normalizedData, { keepDefaultValues: false });
      setCurrentRawResumeData(parsedData as FirestoreResumeData | null); // Also update currentRawResumeData when form is updated
      console.info("[updateFormWithData] Form reset successful with new data.");
    } catch (error: any) {
      console.error("[updateFormWithData] Zod validation failed on normalized data for form reset:", error.errors);
      toast({ title: 'خطأ في تحديث النموذج', description: 'البيانات المستلمة غير متوافقة مع النموذج.', variant: 'destructive' });
    }
  }, [form, currentUser, toast, currentResumeId]); // setCurrentRawResumeData is stable

  const startProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
        console.info("[ProcessingTimer] Timer already running. Progress:", processingProgress);
        return;
    }
    console.info("[ProcessingTimer] Starting PDF processing timer.");
    setIsProcessingPdf(true);
    setProcessingProgress(0);

    const totalDuration = 30000; // 30 seconds
    const intervalTime = 100;
    const steps = totalDuration / intervalTime;
    const increment = 100 / steps;

    processingTimerRef.current = setInterval(() => {
      setProcessingProgress((prevProgress) => {
        const newProgress = prevProgress + increment;
        if (newProgress >= 100) {
          if (processingTimerRef.current) clearInterval(processingTimerRef.current);
          processingTimerRef.current = null;
          console.info("[ProcessingTimer] Timer reached 100%, but waiting for Firestore confirmation to stop 'isProcessingPdf'.");
          return 100;
        }
        return newProgress;
      });
    }, intervalTime);
  }, [processingProgress]); // Removed state setters from deps as they are stable

  const stopProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
      console.info("[ProcessingTimer] Stopping PDF processing timer.");
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    if (isProcessingPdf) { // Only change state if it's currently true
        console.info("[ProcessingTimer] Setting isProcessingPdf to false.");
        setIsProcessingPdf(false);
    }
    setProcessingProgress(0);
  }, [isProcessingPdf]); // Removed state setters, added isProcessingPdf


  const loadInitialCv = useCallback(async (userId: string) => {
    console.info(`[loadInitialCv] Attempting to load or create initial CV for user: ${userId}.`);
    setIsLoadingCv(true);
    setCurrentRawResumeData(null); // Reset before loading new data
    processedResumeIdRef.current = null;
    let loadedCvData: FirestoreResumeData | null = null;

    try {
      const userDocRef = doc(db, 'users', userId);
      const userDocSnap = await getDoc(userDocRef);
      let initialResumeIdToLoad: string | null = null;

      if (userDocSnap.exists() && userDocSnap.data()?.latestResumeId) {
        initialResumeIdToLoad = userDocSnap.data()?.latestResumeId;
        console.info(`[loadInitialCv] User has latestResumeId: ${initialResumeIdToLoad}`);
      } else {
        console.info("[loadInitialCv] No latestResumeId on user doc. Querying for most recent resume.");
        const resumesRef = collection(db, 'users', userId, 'resumes');
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          initialResumeIdToLoad = querySnapshot.docs[0].id;
          console.info(`[loadInitialCv] Found most recent resume by query: ${initialResumeIdToLoad}`);
        }
      }

      if (initialResumeIdToLoad) {
        console.info(`[loadInitialCv] Attempting to load resume document ID: ${initialResumeIdToLoad}`);
        const cvDocRef = doc(db, 'users', userId, 'resumes', initialResumeIdToLoad);
        const cvDocSnap = await getDoc(cvDocRef);
        if (cvDocSnap.exists()) {
          loadedCvData = { resumeId: cvDocSnap.id, ...cvDocSnap.data() } as FirestoreResumeData;
          console.info("[loadInitialCv] Successfully loaded initial CV data:", loadedCvData);
          // setCurrentRawResumeData(loadedCvData); // updateFormWithData will set this
          updateFormWithData(loadedCvData);
          setCurrentResumeId(loadedCvData.resumeId);
        } else {
           console.warn(`[loadInitialCv] latestResumeId ${initialResumeIdToLoad} points to a non-existent document. Will create new draft.`);
           initialResumeIdToLoad = null;
        }
      }
      
      if (!initialResumeIdToLoad) {
        console.info("[loadInitialCv] No existing CV found, creating a new draft.");
        const newResumeRef = doc(collection(db, 'users', userId, 'resumes'));
        const newResumeId = newResumeRef.id;
        const defaultDraftData: FirestoreResumeData = {
          resumeId: newResumeId,
          userId: userId,
          title: 'مسودة السيرة الذاتية',
          personalInfo: { fullName: currentUser?.displayName || '', email: currentUser?.email || '', jobTitle: '', phone: '', address: '' },
          summary: '', education: [], experience: [], skills: [], languages: [], hobbies: [], customSections: [],
          parsingDone: true, parsingError: null, storagePath: null, originalFileName: null,
          createdAt: firestoreServerTimestamp() as any,
          updatedAt: firestoreServerTimestamp() as any,
        };
        await setDoc(newResumeRef, defaultDraftData);
        console.info(`[loadInitialCv] New draft resume created with ID: ${newResumeId}`);
        
        const userRef = doc(db, "users", userId);
        try {
            await updateDoc(userRef, { latestResumeId: newResumeId, updatedAt: firestoreServerTimestamp() });
            console.info(`[loadInitialCv] Updated latestResumeId for user ${userId} to ${newResumeId}`);
        } catch (userUpdateError) {
            console.error(`[loadInitialCv] Failed to update latestResumeId for user ${userId}:`, userUpdateError);
        }
        // setCurrentRawResumeData(defaultDraftData); // updateFormWithData will set this
        updateFormWithData(defaultDraftData);
        setCurrentResumeId(newResumeId);
      }
    } catch (error) {
      console.error('[loadInitialCv] Error loading/creating initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل أو إنشاء بيانات السيرة الذاتية.', variant: 'destructive' });
      updateFormWithData(null); // Reset form on error
    } finally {
      console.info("[loadInitialCv] Finished. Setting isLoadingCv to false.");
      setIsLoadingCv(false);
    }
  }, [currentUser, toast, updateFormWithData, form]); // Removed state setters, and isLoadingCv from deps. form is stable.

  // Effect for initial load or when user changes
  useEffect(() => {
    console.info(`[User/Mount Effect] currentUser?.uid: ${currentUser?.uid}, currentResumeId: ${currentResumeId}`);
    if (currentUser?.uid && !currentResumeId) { // Only load if no resumeId, meaning it's a fresh start or user changed
      console.info("[User/Mount Effect] User available, no currentResumeId. Calling loadInitialCv.");
      loadInitialCv(currentUser.uid);
    } else if (!currentUser?.uid) {
      console.info("[User/Mount Effect] No user. Resetting states.");
      setCurrentResumeId(null);
      setCurrentRawResumeData(null);
      updateFormWithData(null); // Reset form
      setIsLoadingCv(true); // Prepare for next user
      stopProcessingTimer();
      processedResumeIdRef.current = null;
      form.reset(normalizeResumeData(null, null)); // Reset form to absolute defaults
    }
  }, [currentUser?.uid, loadInitialCv, updateFormWithData, stopProcessingTimer, form]); // currentResumeId removed from deps to prevent re-running if only it changes (handled by other listeners)

  // User document listener (for latestResumeId changes AFTER initial load)
  useEffect(() => {
    if (!currentUser?.uid) {
      console.info("[User Listener] No user, skipping setup.");
      return;
    }
    const userDocRef = doc(db, "users", currentUser.uid);
    console.info(`[User Listener] Setting up for users/${currentUser.uid}. Listening for latestResumeId changes.`);

    const unsubscribeUser = onSnapshot(userDocRef, (docSnap) => {
      const latestIdFromFirestore = docSnap.data()?.latestResumeId || null;
      console.info(`[User Listener] Snapshot received. Firestore latestResumeId: ${latestIdFromFirestore}. App's currentResumeId: ${currentResumeId}`);
      if (latestIdFromFirestore && latestIdFromFirestore !== currentResumeId) {
        console.info(`[User Listener] latestResumeId changed from ${currentResumeId} to ${latestIdFromFirestore}. Updating app's currentResumeId.`);
        setCurrentResumeId(latestIdFromFirestore); // This will trigger the resume document listener
      }
    }, (error) => {
      console.error("[User Listener] Error:", error);
      toast({ title: "خطأ في مزامنة المستخدم", description: "تعذر تحديث بيانات المستخدم.", variant: "destructive" });
    });
    return () => {
      console.info("[User Listener] Unsubscribing.");
      unsubscribeUser();
    };
  }, [currentUser?.uid, currentResumeId, toast]);

  // Resume document listener
  useEffect(() => {
    if (!currentUser?.uid || !currentResumeId) {
      console.info(`[Resume Listener] Skipping setup: User UID: ${currentUser?.uid}, Resume ID: ${currentResumeId}`);
      if (isLoadingCv && !isProcessingPdf) setIsLoadingCv(false);
      return;
    }

    console.info(`[Resume Listener] Setting up for: users/${currentUser.uid}/resumes/${currentResumeId}.`);
    // Only set isLoadingCv if we are not already processing a PDF, and if we are actually about to fetch data.
    if (!isProcessingPdf && !currentRawResumeData) { // Avoid setting loading if data is already there and not processing PDF
        setIsLoadingCv(true);
    }


    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap) => {
      console.info(`[Resume Listener] Snapshot received for resume: ${currentResumeId}. Exists: ${docSnap.exists()}`);
      if (docSnap.exists()) {
        const updatedCvData = { resumeId: docSnap.id, ...docSnap.data() } as FirestoreResumeData;
        console.info("[Resume Listener] Raw data from Firestore:", updatedCvData);
        
        const isDataDifferent = JSON.stringify(updatedCvData) !== JSON.stringify(currentRawResumeData);

        if (isDataDifferent) { // Only update if data truly changed
            updateFormWithData(updatedCvData); // This will also set currentRawResumeData
            console.info("[Resume Listener] Form updated with new resume data.");
        } else {
            console.info("[Resume Listener] Data is same as currentRawResumeData, no form update needed.");
        }

        const isNewlyProcessed = processedResumeIdRef.current !== updatedCvData.resumeId && (updatedCvData.parsingDone || updatedCvData.parsingError);

        if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
          console.info(`[Resume Listener] Parsing completed successfully for ${updatedCvData.resumeId}.`);
          stopProcessingTimer();
          if (isNewlyProcessed) {
            toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
            processedResumeIdRef.current = updatedCvData.resumeId;
          }
        } else if (updatedCvData.parsingError) {
          console.info(`[Resume Listener] Parsing error for ${updatedCvData.resumeId}: ${updatedCvData.parsingError}.`);
          stopProcessingTimer();
          if (isNewlyProcessed) {
            toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 7000 });
            processedResumeIdRef.current = updatedCvData.resumeId;
          }
        } else if (updatedCvData.storagePath && !updatedCvData.parsingDone && !updatedCvData.parsingError) {
          console.info(`[Resume Listener] PDF ${updatedCvData.resumeId} uploaded, awaiting parsing. Starting timer.`);
          if (!isProcessingPdf) startProcessingTimer(); // Only start if not already processing
          if (processedResumeIdRef.current === updatedCvData.resumeId && isNewlyProcessed) { // Check isNewlyProcessed to avoid resetting for same doc
            processedResumeIdRef.current = null; 
          }
        } else {
            console.info(`[Resume Listener] Resume ${updatedCvData.resumeId} status: parsingDone=${updatedCvData.parsingDone}, parsingError=${updatedCvData.parsingError}, storagePath=${!!updatedCvData.storagePath}.`);
            if(!updatedCvData.storagePath || updatedCvData.parsingDone || updatedCvData.parsingError){
                if (isProcessingPdf) stopProcessingTimer(); // Ensure timer is off if no active processing
            }
        }
        setIsLoadingCv(false);
      } else {
        console.warn(`[Resume Listener] Resume document ${currentResumeId} does not exist. User: ${currentUser.uid}. Attempting to recover.`);
        setIsLoadingCv(false);
        stopProcessingTimer();
        // setCurrentRawResumeData(null); // Already handled by loadInitialCv if it's called
        if (currentUser?.uid) loadInitialCv(currentUser.uid); // Attempt to recover
      }
    }, (error) => {
      console.error(`[Resume Listener] Firestore listener error for ${currentResumeId}:`, error);
      setIsLoadingCv(false);
      stopProcessingTimer();
      // setCurrentRawResumeData(null); // Avoid immediate form reset on listener error, could be transient
      toast({ title: 'خطأ في المزامنة', description: 'حدث خطأ أثناء تحديث السيرة الذاتية.', variant: 'destructive' });
    });

    return () => {
      console.info(`[Resume Listener] Unsubscribing from resume: ${currentResumeId}`);
      unsubscribeResume();
    };
  }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, loadInitialCv, currentRawResumeData, isProcessingPdf, isLoadingCv]);
  // currentRawResumeData, isProcessingPdf, isLoadingCv are included because their change might affect logic inside the effect (e.g., when to show toasts or start/stop timers, or manage isLoadingCv state)
  // but the core subscription logic is tied to uid/resumeId.
  // The `isDataDifferent` check helps prevent loops from `currentRawResumeData`.

  const currentFormData = form.watch();

  let statusMessage = '';
  if (isLoadingCv && !isProcessingPdf && !currentRawResumeData) { // More specific condition for initial loading
    statusMessage = "جاري تحميل البيانات...";
  } else if (isProcessingPdf) {
    statusMessage = "جاري استخراج البيانات...";
  }


  const handleDownloadCv = () => {
    if (!currentRawResumeData && Object.keys(currentFormData).length === 0) { // Check currentRawResumeData as well
        toast({
            title: "لا توجد بيانات للطباعة",
            description: "الرجاء التأكد من تحميل أو ملء السيرة الذاتية أولاً.",
            variant: "default"
        });
        return;
    }
    console.info("Attempting to print CV preview.");
    window.print();
  };

  // Show loader if:
  // 1. (isLoadingCv is true AND there's no current raw data yet AND not processing PDF) -> Initial full page load for a resume
  // 2. OR if isProcessingPdf is true (actively waiting for PDF parsing, show progress)
  const showOverallLoader = (isLoadingCv && !currentRawResumeData && !isProcessingPdf) || isProcessingPdf;


  return (
    <div className="flex flex-col h-screen bg-muted/40 print:bg-white">
      <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0 print:hidden">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
          {(isLoadingCv || isProcessingPdf) && statusMessage && ( // Show status message if loading or processing and message exists
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
            <Button variant="outline" onClick={handleDownloadCv} size="sm" disabled={showOverallLoader || (!currentRawResumeData && Object.keys(currentFormData).length === 0)}>
              <Download className="ml-2 h-4 w-4" />
              تحميل
            </Button>
            <Button variant="ghost" onClick={signOut} size="sm">
              <LogOut className="ml-2 h-4 w-4" />
              تسجيل الخروج
            </Button>
          </div>
        )}
      </header>

      {showOverallLoader ? (
         <div className="flex flex-1 items-center justify-center p-8">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className='mr-4 text-muted-foreground text-lg'>{statusMessage}</p>
             {isProcessingPdf && (
                <div className="w-48 ml-4">
                  <Progress value={processingProgress} className="h-3" />
                </div>
              )}
         </div>
      ) : (
        <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden print:p-0 print:overflow-visible print:block">
          <section
            id="cv-preview-section"
            className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar print:shadow-none print:rounded-none print:border-none"
            dir="ltr" 
          >
            <CvPreview data={currentFormData} />
          </section>
          <section
            className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar print:hidden"
          >
            <Form {...form}>
              <CvForm
                isLoadingCv={isLoadingCv || isProcessingPdf}
              />
            </Form>
          </section>
        </main>
      )}
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
