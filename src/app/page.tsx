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
    console.info(`[updateFormWithData] Received data to update form with. Current Resume ID: ${currentResumeId}. Has data: ${!!parsedData}`, parsedData ? JSON.stringify(Object.keys(parsedData)) : 'null');
    const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
    console.info("[updateFormWithData] Normalized Data for form reset:", JSON.stringify(normalizedData, null, 2));

    try {
      cvSchema.parse(normalizedData); // Validate before reset
      form.reset(normalizedData, { keepDefaultValues: false });
      setCurrentRawResumeData(parsedData as FirestoreResumeData | null); 
      console.info("[updateFormWithData] Form reset successful with new data.");
    } catch (error: any) {
      console.error("[updateFormWithData] Zod validation failed on normalized data for form reset:", error.errors);
      toast({ title: 'خطأ في تحديث النموذج', description: 'البيانات المستلمة غير متوافقة مع النموذج.', variant: 'destructive' });
    }
  }, [form, currentUser, toast, currentResumeId]); 

  const startProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
        console.info("[ProcessingTimer] Timer already running. Progress:", processingProgress);
        return;
    }
    console.info("[ProcessingTimer] Starting PDF processing timer.");
    setIsProcessingPdf(true); // Set processing state
    setProcessingProgress(0);

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
          console.info("[ProcessingTimer] Timer reached 100%, but waiting for Firestore confirmation to stop 'isProcessingPdf'.");
          return 100;
        }
        return newProgress;
      });
    }, intervalTime);
  }, [processingProgress]);

  const stopProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
      console.info("[ProcessingTimer] Stopping PDF processing timer.");
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    // Only change state if it's currently true, to avoid unnecessary re-renders
    if (isProcessingPdf) { 
        console.info("[ProcessingTimer] Setting isProcessingPdf to false.");
        setIsProcessingPdf(false);
    }
    setProcessingProgress(0);
  }, [isProcessingPdf]);


  const loadInitialCv = useCallback(async (userId: string) => {
    console.info(`[loadInitialCv] Attempting to load or create initial CV for user: ${userId}. Current state: currentResumeId=${currentResumeId}, isLoadingCv=${isLoadingCv}`);
    setIsLoadingCv(true);
    // setCurrentRawResumeData(null); // Reset before loading new data - this might cause issues if called while processing another resume
    // processedResumeIdRef.current = null; // Don't reset this here, it's for tracking toasts
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
          updateFormWithData(loadedCvData);
          setCurrentResumeId(loadedCvData.resumeId); // Set currentResumeId to the one loaded
          setIsLoadingCv(false); // Data loaded
          return; // Exit after successful load
        } else {
           console.warn(`[loadInitialCv] latestResumeId ${initialResumeIdToLoad} points to a non-existent document. Will create new draft if no other found.`);
           initialResumeIdToLoad = null; // Proceed to create new if this path failed
        }
      }
      
      // If no initialResumeIdToLoad was found or it pointed to a non-existent document
      console.info("[loadInitialCv] No existing valid CV found, creating a new draft.");
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
      updateFormWithData(defaultDraftData);
      setCurrentResumeId(newResumeId);
      setIsLoadingCv(false); // New draft created and loaded
    } catch (error) {
      console.error('[loadInitialCv] Error loading/creating initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل أو إنشاء بيانات السيرة الذاتية.', variant: 'destructive' });
      updateFormWithData(null); 
      setIsLoadingCv(false); // Stop loading on error
    }
  }, [currentUser, toast, updateFormWithData]); // form is stable. currentResumeId removed, isLoadingCv removed

  // Effect for initial load or when user changes
  useEffect(() => {
    console.info(`[User/Mount Effect] currentUser?.uid: ${currentUser?.uid}. App's currentResumeId: ${currentResumeId}`);
    if (currentUser?.uid && !currentResumeId && !isProcessingPdf) { 
      console.info("[User/Mount Effect] User available, no currentResumeId, not processing. Calling loadInitialCv.");
      loadInitialCv(currentUser.uid);
    } else if (!currentUser?.uid) {
      console.info("[User/Mount Effect] No user. Resetting states.");
      setCurrentResumeId(null);
      setCurrentRawResumeData(null); // Reset raw data
      updateFormWithData(null); 
      setIsLoadingCv(true); 
      stopProcessingTimer();
      processedResumeIdRef.current = null;
      form.reset(normalizeResumeData(null, null)); 
    }
  }, [currentUser?.uid, loadInitialCv, updateFormWithData, stopProcessingTimer, form, isProcessingPdf, currentResumeId]);

  // User document listener (for latestResumeId changes AFTER initial load)
  useEffect(() => {
    if (!currentUser?.uid) {
      console.info("[User Listener] No user, skipping setup.");
      return;
    }
    const userDocRef = doc(db, "users", currentUser.uid);
    console.info(`[User Listener] Setting up for users/${currentUser.uid}. Listening for latestResumeId changes. Current app resumeId: ${currentResumeId}`);

    const unsubscribeUser = onSnapshot(userDocRef, (docSnap) => {
      const latestIdFromFirestore = docSnap.data()?.latestResumeId || null;
      console.info(`[User Listener] Snapshot received. Firestore latestResumeId: ${latestIdFromFirestore}. App's currentResumeId: ${currentResumeId}`);
      if (latestIdFromFirestore && latestIdFromFirestore !== currentResumeId) {
        console.info(`[User Listener] latestResumeId changed from ${currentResumeId} to ${latestIdFromFirestore}. Updating app's currentResumeId. Setting isLoadingCv=true.`);
        setIsLoadingCv(true); // Set loading true as we are about to switch to a new resume
        setCurrentRawResumeData(null); // Clear old raw data
        setCurrentResumeId(latestIdFromFirestore); 
      }
    }, (error) => {
      console.error("[User Listener] Error:", error);
      toast({ title: "خطأ في مزامنة المستخدم", description: "تعذر تحديث بيانات المستخدم.", variant: "destructive" });
    });
    return () => {
      console.info("[User Listener] Unsubscribing.");
      unsubscribeUser();
    };
  }, [currentUser?.uid, currentResumeId, toast]); // Removed setIsLoadingCv, setCurrentRawResumeData from deps

  // Resume document listener
  useEffect(() => {
    if (!currentUser?.uid || !currentResumeId) {
      console.info(`[Resume Listener] Skipping setup: User UID: ${currentUser?.uid}, Resume ID: ${currentResumeId}`);
      // If no resume ID, but not processing, ensure loading is false
      if (!isProcessingPdf && isLoadingCv) setIsLoadingCv(false);
      return;
    }

    console.info(`[Resume Listener] Setting up for: users/${currentUser.uid}/resumes/${currentResumeId}. isProcessingPdf: ${isProcessingPdf}, isLoadingCv: ${isLoadingCv}`);
    
    // Don't set isLoadingCv to true if we are already processing a PDF and this listener is just re-subscribing
    // or if data for this currentResumeId is already loaded.
    // isLoadingCv should have been set by the User Listener when currentResumeId changed.
    // Or by loadInitialCv if this is the first load.

    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap) => {
      console.info(`[Resume Listener] Snapshot received for resume: ${currentResumeId}. Exists: ${docSnap.exists()}`);
      if (docSnap.exists()) {
        const updatedCvData = { resumeId: docSnap.id, ...docSnap.data() } as FirestoreResumeData;
        console.info("[Resume Listener] Raw data from Firestore:", JSON.stringify(updatedCvData, null, 2));
        
        // Check if the new data is substantially different from currentRawResumeData to avoid unnecessary updates
        const isDataDifferent = JSON.stringify(updatedCvData) !== JSON.stringify(currentRawResumeData);

        if (isDataDifferent) { 
            console.info("[Resume Listener] Data is different. Calling updateFormWithData.");
            updateFormWithData(updatedCvData); 
        } else {
            console.info("[Resume Listener] Data is same as currentRawResumeData, no form update needed. Checking processing status.");
        }
        
        setIsLoadingCv(false); // Data for currentResumeId is loaded (or confirmed same), so stop general loading

        // Check parsing status for PDF processing
        if (updatedCvData.parsingDone || updatedCvData.parsingError) {
          console.info(`[Resume Listener] Parsing status for ${updatedCvData.resumeId}: done=${updatedCvData.parsingDone}, error=${updatedCvData.parsingError}. Stopping timer.`);
          stopProcessingTimer(); 
          
          // Only show toast if this specific resume ID was not the one last processed and toasted for
          if (processedResumeIdRef.current !== updatedCvData.resumeId) {
            if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
              toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
            } else if (updatedCvData.parsingError) {
              toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 7000 });
            }
            processedResumeIdRef.current = updatedCvData.resumeId; // Mark this resumeId as processed for toasts
          }
        } else if (updatedCvData.storagePath && !isProcessingPdf) { // If there's a storage path, not done/error, and not already processing
          console.info(`[Resume Listener] PDF ${updatedCvData.resumeId} uploaded, awaiting parsing. Starting timer.`);
          startProcessingTimer(); 
          // If we start processing for a new resume, reset the processedRef
          if (processedResumeIdRef.current !== updatedCvData.resumeId) {
            processedResumeIdRef.current = null; 
          }
        } else if (!updatedCvData.storagePath && isProcessingPdf) {
            // If storage path is gone (e.g. manual deletion?) and we were processing, stop.
            console.info(`[Resume Listener] No storage path for ${updatedCvData.resumeId} but was processing. Stopping timer.`);
            stopProcessingTimer();
        }

      } else {
        console.warn(`[Resume Listener] Resume document ${currentResumeId} does not exist. User: ${currentUser.uid}.`);
        setIsLoadingCv(false); // Stop loading as doc doesn't exist
        stopProcessingTimer(); // Stop any processing timer
        // If the currentResumeId doc is deleted, loadInitialCv will eventually be triggered if user doc listener runs or on refresh.
        // Consider if immediate action is needed here, e.g., clearing form
        // updateFormWithData(null); // Clears the form if the active resume is deleted.
      }
    }, (error) => {
      console.error(`[Resume Listener] Firestore listener error for ${currentResumeId}:`, error);
      setIsLoadingCv(false); 
      stopProcessingTimer();
      toast({ title: 'خطأ في المزامنة', description: 'حدث خطأ أثناء تحديث السيرة الذاتية.', variant: 'destructive' });
    });

    return () => {
      console.info(`[Resume Listener] Unsubscribing from resume: ${currentResumeId}`);
      unsubscribeResume();
    };
  // Dependencies: `currentUser?.uid` and `currentResumeId` are the main drivers.
  // Callbacks `toast`, `updateFormWithData`, `startProcessingTimer`, `stopProcessingTimer` should be stable.
  // `isProcessingPdf` is included because `startProcessingTimer` condition depends on it.
  // `currentRawResumeData` is included for the `isDataDifferent` check to prevent unnecessary `updateFormWithData` calls.
  // `isLoadingCv` is used to determine if loading state needs to be changed.
  }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, currentRawResumeData, isLoadingCv]); 


  const currentFormData = form.watch();

  let statusMessage = '';
  // Prioritize processing message if isProcessingPdf is true
  if (isProcessingPdf) {
    statusMessage = "جاري استخراج البيانات...";
  } else if (isLoadingCv) { // Show general loading if not processing PDF but still loading CV data
    statusMessage = "جاري تحميل البيانات...";
  }


  const handleDownloadCv = () => {
    // Check currentFormData as it's live from the form. currentRawResumeData might be slightly stale.
    const hasDataToPrint = Object.values(currentFormData).some(value => {
        if (Array.isArray(value)) return value.length > 0;
        return value !== null && value !== undefined && value !== '';
    });

    if (!hasDataToPrint) {
        toast({
            title: "لا توجد بيانات للطباعة",
            description: "الرجاء التأكد من تحميل أو ملء السيرة الذاتية أولاً.",
            variant: "default"
        });
        return;
    }
    console.info("Attempting to print CV preview with data:", currentFormData);
    window.print();
  };
  
  const showOverallLoader = isProcessingPdf || (isLoadingCv && !currentRawResumeData);


  return (
    <div className="flex flex-col h-screen bg-muted/40 print:bg-white">
      <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0 print:hidden">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
          {(isLoadingCv || isProcessingPdf) && statusMessage && ( 
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
            <Button variant="outline" onClick={handleDownloadCv} size="sm" disabled={showOverallLoader || Object.keys(form.getValues()).length === 0}>
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

