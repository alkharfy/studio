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
      cvSchema.parse(normalizedData);
      form.reset(normalizedData, { keepDefaultValues: false });
      console.info("[updateFormWithData] Form reset successful with new data.");
    } catch (error: any) {
      console.error("[updateFormWithData] Zod validation failed on normalized data for form reset:", error.errors);
      toast({ title: 'خطأ في تحديث النموذج', description: 'البيانات المستلمة غير متوافقة مع النموذج.', variant: 'destructive' });
    }
  }, [form, currentUser, toast, currentResumeId]); // Added currentResumeId for context in logs

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
          // Do not set isProcessingPdf to false here; Firestore listener will handle it.
          return 100;
        }
        return newProgress;
      });
    }, intervalTime);
  }, [setIsProcessingPdf, setProcessingProgress, processingProgress]);

  const stopProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
      console.info("[ProcessingTimer] Stopping PDF processing timer.");
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    // Only set isProcessingPdf to false if it's currently true, to avoid unnecessary re-renders
    if (isProcessingPdf) {
        console.info("[ProcessingTimer] Setting isProcessingPdf to false.");
        setIsProcessingPdf(false);
    }
    setProcessingProgress(0);
  }, [setIsProcessingPdf, setProcessingProgress, isProcessingPdf]);


  const loadInitialCv = useCallback(async (userId: string) => {
    console.info(`[loadInitialCv] Attempting to load or create initial CV for user: ${userId}. Current isLoadingCv: ${isLoadingCv}`);
    if(!isLoadingCv) setIsLoadingCv(true); // Ensure loading state is true during this operation
    setCurrentRawResumeData(null);
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
          setCurrentRawResumeData(loadedCvData);
          updateFormWithData(loadedCvData);
          setCurrentResumeId(loadedCvData.resumeId); // This will trigger the resume listener
        } else {
           console.warn(`[loadInitialCv] latestResumeId ${initialResumeIdToLoad} points to a non-existent document. Will create new draft.`);
           initialResumeIdToLoad = null; // Force creation of new draft
        }
      }
      
      if (!initialResumeIdToLoad) { // No existing resume found or latest was invalid
        console.info("[loadInitialCv] No existing CV found, creating a new draft.");
        const newResumeRef = doc(collection(db, 'users', userId, 'resumes'));
        const newResumeId = newResumeRef.id;
        const defaultDraftData: FirestoreResumeData = {
          resumeId: newResumeId,
          userId: userId,
          title: 'مسودة السيرة الذاتية',
          personalInfo: { fullName: currentUser?.displayName || '', email: currentUser?.email || '', jobTitle: '', phone: '', address: '' },
          summary: '', education: [], experience: [], skills: [], languages: [], hobbies: [], customSections: [],
          parsingDone: true, parsingError: null, storagePath: null, originalFileName: null, // Important: parsingDone=true for new drafts
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
        
        setCurrentRawResumeData(defaultDraftData);
        updateFormWithData(defaultDraftData);
        setCurrentResumeId(newResumeId); // This will trigger the resume listener
      }
    } catch (error) {
      console.error('[loadInitialCv] Error loading/creating initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل أو إنشاء بيانات السيرة الذاتية.', variant: 'destructive' });
      updateFormWithData(null);
    } finally {
      console.info("[loadInitialCv] Finished. Setting isLoadingCv to false.");
      setIsLoadingCv(false);
    }
  }, [updateFormWithData, toast, currentUser, isLoadingCv]); // Added isLoadingCv to deps to ensure it can be set correctly.

  // Effect for initial load or when user changes
  useEffect(() => {
    console.info(`[User/Mount Effect] currentUser?.uid: ${currentUser?.uid}, currentResumeId: ${currentResumeId}`);
    if (currentUser?.uid && !currentResumeId) {
      console.info("[User/Mount Effect] User available, no currentResumeId. Calling loadInitialCv.");
      loadInitialCv(currentUser.uid);
    } else if (!currentUser?.uid) {
      console.info("[User/Mount Effect] No user. Resetting states.");
      setCurrentResumeId(null);
      setCurrentRawResumeData(null);
      updateFormWithData(null);
      setIsLoadingCv(true); // Prepare for next user
      stopProcessingTimer();
      processedResumeIdRef.current = null;
      form.reset(normalizeResumeData(null, null)); // Reset form to absolute defaults
    }
  }, [currentUser?.uid, currentResumeId, loadInitialCv, updateFormWithData, stopProcessingTimer, form]);

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
        // This will trigger the resume document listener to fetch the new resume
        setCurrentResumeId(latestIdFromFirestore);
      } else if (!latestIdFromFirestore && currentResumeId) {
        // This case might mean the latestResumeId was cleared.
        // The app could decide to load the most recent one or create a new one if currentResumeId becomes invalid.
        // For now, we let the resume listener handle if the currentResumeId document disappears.
        console.info(`[User Listener] latestResumeId is null in Firestore, but app has currentResumeId: ${currentResumeId}. No change initiated by user listener.`);
      }
    }, (error) => {
      console.error("[User Listener] Error:", error);
      toast({ title: "خطأ في مزامنة المستخدم", description: "تعذر تحديث بيانات المستخدم.", variant: "destructive" });
    });
    return () => {
      console.info("[User Listener] Unsubscribing.");
      unsubscribeUser();
    };
  }, [currentUser?.uid, currentResumeId, toast]); // Only depends on user and current ID for re-subscribing if they change

  // Resume document listener
  useEffect(() => {
    if (!currentUser?.uid || !currentResumeId) {
      console.info(`[Resume Listener] Skipping setup: User UID: ${currentUser?.uid}, Resume ID: ${currentResumeId}`);
      if (isLoadingCv && !isProcessingPdf) setIsLoadingCv(false); // If no resume to load, stop loading state
      return;
    }

    console.info(`[Resume Listener] Setting up for: users/${currentUser.uid}/resumes/${currentResumeId}. Current isLoadingCv: ${isLoadingCv}, isProcessingPdf: ${isProcessingPdf}`);
    if (!isLoadingCv && !isProcessingPdf) setIsLoadingCv(true); // Set loading if not already processing a PDF

    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap) => {
      console.info(`[Resume Listener] Snapshot received for resume: ${currentResumeId}. Exists: ${docSnap.exists()}`);
      if (docSnap.exists()) {
        const updatedCvData = { resumeId: docSnap.id, ...docSnap.data() } as FirestoreResumeData;
        console.info("[Resume Listener] Raw data from Firestore:", updatedCvData);
        
        // Only update form if data is different or if it's the initial load for this resume
        const isDifferentData = JSON.stringify(updatedCvData) !== JSON.stringify(currentRawResumeData);
        if (isDifferentData || !currentRawResumeData) {
            setCurrentRawResumeData(updatedCvData); // Update raw data state
            updateFormWithData(updatedCvData);
            console.info("[Resume Listener] Form updated with new resume data.");
        } else {
            console.info("[Resume Listener] Data is same as currentRawResumeData, no form update needed.");
        }

        const isNewlyProcessedOrErrored = processedResumeIdRef.current !== updatedCvData.resumeId && (updatedCvData.parsingDone || updatedCvData.parsingError);

        if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
          console.info(`[Resume Listener] Parsing completed successfully for ${updatedCvData.resumeId}.`);
          stopProcessingTimer(); // This will set isProcessingPdf to false
          if (isNewlyProcessedOrErrored) {
            toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
            processedResumeIdRef.current = updatedCvData.resumeId;
          }
        } else if (updatedCvData.parsingError) {
          console.info(`[Resume Listener] Parsing error for ${updatedCvData.resumeId}: ${updatedCvData.parsingError}.`);
          stopProcessingTimer();
          if (isNewlyProcessedOrErrored) {
            toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 7000 });
            processedResumeIdRef.current = updatedCvData.resumeId;
          }
        } else if (updatedCvData.storagePath && !updatedCvData.parsingDone && !updatedCvData.parsingError) {
          console.info(`[Resume Listener] PDF ${updatedCvData.resumeId} uploaded, awaiting parsing. Starting timer.`);
          startProcessingTimer();
          if (processedResumeIdRef.current === updatedCvData.resumeId) {
            processedResumeIdRef.current = null; // Reset if it's a re-process
          }
        } else {
            console.info(`[Resume Listener] Resume ${updatedCvData.resumeId} status: parsingDone=${updatedCvData.parsingDone}, parsingError=${updatedCvData.parsingError}, storagePath=${!!updatedCvData.storagePath}. Timer stopped if not applicable.`);
            if(!updatedCvData.storagePath || updatedCvData.parsingDone || updatedCvData.parsingError){
                stopProcessingTimer(); // Ensure timer is off if no active processing
            }
        }
        setIsLoadingCv(false); // Data received, stop general loading state
      } else {
        console.warn(`[Resume Listener] Resume document ${currentResumeId} does not exist. User: ${currentUser.uid}.`);
        // This might mean the resume was deleted or ID is wrong. Try to load/create another.
        setCurrentRawResumeData(null);
        setIsLoadingCv(false); // Stop loading for this attempt
        stopProcessingTimer(); // Stop any processing timer
        if (currentUser?.uid) loadInitialCv(currentUser.uid); // Attempt to recover by loading/creating initial
      }
    }, (error) => {
      console.error(`[Resume Listener] Firestore listener error for ${currentResumeId}:`, error);
      setIsLoadingCv(false); // Stop loading on error
      stopProcessingTimer();
      setCurrentRawResumeData(null);
      toast({ title: 'خطأ في المزامنة', description: 'حدث خطأ أثناء تحديث السيرة الذاتية.', variant: 'destructive' });
    });

    return () => {
      console.info(`[Resume Listener] Unsubscribing from resume: ${currentResumeId}`);
      unsubscribeResume();
    };
  }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, loadInitialCv, currentRawResumeData, isLoadingCv, isProcessingPdf]); // Added dependencies to re-evaluate listener when critical states change

  const currentFormData = form.watch();

  let statusMessage = '';
  if (isLoadingCv && !isProcessingPdf) { 
    statusMessage = "جاري تحميل البيانات...";
  } else if (isProcessingPdf) {
    statusMessage = "جاري استخراج البيانات...";
  }


  const handleDownloadCv = () => {
    // Check if there's data to print, otherwise, it might print a blank or incomplete page
    if (!currentRawResumeData || Object.keys(currentFormData).length === 0) {
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

  // Determine if the main content should be hidden due to loading
  // Show loader if:
  // 1. isLoadingCv is true AND there's no current raw data yet (initial load for a resume)
  // 2. OR if isProcessingPdf is true (actively waiting for PDF parsing)
  const showOverallLoader = (isLoadingCv && !currentRawResumeData) || isProcessingPdf;


  return (
    <div className="flex flex-col h-screen bg-muted/40 print:bg-white">
      <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0 print:hidden">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
          {(isLoadingCv || isProcessingPdf) && ( // Show status if either general loading or PDF processing
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
            <Button variant="outline" onClick={handleDownloadCv} size="sm" disabled={showOverallLoader}>
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
                isLoadingCv={isLoadingCv || isProcessingPdf} // Pass combined loading state
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

