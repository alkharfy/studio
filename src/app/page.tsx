// src/app/page.tsx
'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
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
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null);
  const [currentRawResumeData, setCurrentRawResumeData] = useState<FirestoreResumeData | null>(null);

  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const processedResumeIdRef = useRef<string | null>(null); // Tracks if a toast has been shown for the current processing
  const [hasPrintableData, setHasPrintableData] = React.useState(false);

  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser),
    mode: 'onChange',
  });

  const updateFormWithData = useCallback((parsedData: FirestoreResumeData | null) => {
    console.info(`[updateFormWithData] Received data. CurrentResumeId: ${currentResumeId}. Has data: ${!!parsedData}`, parsedData ? `Keys: ${Object.keys(parsedData).join(', ')}` : 'null');
    const normalizedData = normalizeResumeData(parsedData, currentUser);
    console.info("[updateFormWithData] Normalized Data for form reset:", JSON.stringify(normalizedData).substring(0,200) + "...");

    try {
      // cvSchema.parse(normalizedData); // This can be re-enabled if strict validation on load is desired
      form.reset(normalizedData, { keepDefaultValues: false });
      setCurrentRawResumeData(parsedData);
      // Ensure currentResumeId is updated if the incoming data has a resumeId
      // and it's different from the current one.
      if(parsedData?.resumeId && currentResumeId !== parsedData.resumeId) {
          console.log(`[updateFormWithData] Updating currentResumeId from ${currentResumeId} to ${parsedData.resumeId}`);
          setCurrentResumeId(parsedData.resumeId);
      } else if (parsedData && !parsedData.resumeId && currentResumeId) {
          // This case might indicate a new draft or an issue, ensure resumeId is part of normalizedData if possible
          // For now, we primarily rely on parsedData.resumeId
      }
      console.info("[updateFormWithData] Form reset successful.");
    } catch (error: any) {
      console.error("[updateFormWithData] Zod validation failed on normalized data for form reset:", error.errors);
      toast({ title: 'خطأ في تحديث النموذج', description: 'البيانات المستلمة غير متوافقة مع النموذج.', variant: 'destructive' });
    }
  }, [form, currentUser, toast, currentResumeId]); // Added currentResumeId dependency

  const startProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
        console.info("[ProcessingTimer] Timer already running.");
        return;
    }
    console.info("[ProcessingTimer] Starting PDF processing timer.");
    setIsProcessingPdf(true);
    setProcessingProgress(0);

    const totalDuration = 30000; // 30 seconds
    const intervalTime = 100; // Update every 100ms
    const steps = totalDuration / intervalTime;
    const increment = 100 / steps;

    processingTimerRef.current = setInterval(() => {
      setProcessingProgress((prevProgress) => {
        const newProgress = prevProgress + increment;
        if (newProgress >= 99) { // Stop just before 100 to allow final update from snapshot
          return 99;
        }
        return newProgress;
      });
    }, intervalTime);
  }, [setIsProcessingPdf, setProcessingProgress]);

  const stopProcessingTimer = useCallback((isSuccess: boolean = true) => {
    if (processingTimerRef.current) {
      console.info("[ProcessingTimer] Stopping PDF processing timer.");
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    setIsProcessingPdf(false); // Always set this to false when stopping
    setProcessingProgress(isSuccess ? 100 : 0); // Show 100% on success, 0 on failure/stop
     if(isSuccess) {
        // Optionally hide progress bar after a delay
        setTimeout(()=> setProcessingProgress(0), 2000);
     }
  }, [setIsProcessingPdf, setProcessingProgress]);


  // Effect to load the initial CV or create a new one if none exists
  const loadInitialCv = useCallback(async (userId: string) => {
    console.info(`[loadInitialCv] Attempting for user: ${userId}. Current App Resume ID: ${currentResumeId}`);
    setIsLoadingCv(true);
    let resumeIdToLoad: string | null = currentResumeId; // Start with current if available
    let loadedData: FirestoreResumeData | null = null;

    try {
      // 1. Check user document for latestResumeId
      if (!resumeIdToLoad) {
          const userDocRef = doc(db, 'users', userId);
          const userDocSnap = await getDoc(userDocRef);
          if (userDocSnap.exists() && userDocSnap.data()?.latestResumeId) {
              resumeIdToLoad = userDocSnap.data()?.latestResumeId;
              console.info(`[loadInitialCv] Found latestResumeId from user doc: ${resumeIdToLoad}.`);
          }
      }

      // 2. If a resumeId is identified (from current state or user doc), try to load it
      if (resumeIdToLoad) {
          console.info(`[loadInitialCv] Attempting to load resume: ${resumeIdToLoad}`);
          const cvDocRef = doc(db, 'users', userId, 'resumes', resumeIdToLoad);
          const cvDocSnap = await getDoc(cvDocRef);
          if (cvDocSnap.exists()) {
              loadedData = { ...cvDocSnap.data(), resumeId: cvDocSnap.id } as FirestoreResumeData; // Spread data first, then assign ID
              console.info(`[loadInitialCv] Successfully loaded resume: ${loadedData.resumeId}`);
              if (currentResumeId !== loadedData.resumeId) {
                  setCurrentResumeId(loadedData.resumeId); // Set the app's currentResumeId
              }
              updateFormWithData(loadedData);
              // The onSnapshot listener will take over for subsequent updates
              setIsLoadingCv(false);
              return; // Exit after successful load
          } else {
              console.warn(`[loadInitialCv] Resume ID ${resumeIdToLoad} not found. Will query or create new.`);
              if (currentResumeId === resumeIdToLoad) setCurrentResumeId(null); // Clear invalid ID from app state
              resumeIdToLoad = null; // Reset as it's invalid
          }
      }

      // 3. If no valid resumeId found yet, query for the most recent resume
      if (!resumeIdToLoad) {
        console.info("[loadInitialCv] No valid resume ID yet. Querying for most recent resume.");
        const resumesRef = collection(db, 'users', userId, 'resumes');
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          const docData = querySnapshot.docs[0].data() as FirestoreResumeData;
          // Fix: Spread docData first, then explicitly set resumeId from snapshot ID
          loadedData = { ...docData, resumeId: querySnapshot.docs[0].id };
          console.info(`[loadInitialCv] Found most recent resume by query: ${loadedData.resumeId}`);
          setCurrentResumeId(loadedData.resumeId); // Set the app's currentResumeId <<< Capture the ID here
          updateFormWithData(loadedData);
          setIsLoadingCv(false);
          return; // Exit after successful load
        }
      }

      // 4. If still no resume (user has no resumes), create a new draft
      console.info("[loadInitialCv] No existing CV found, creating new draft.");
      const newResumeRef = doc(collection(db, 'users', userId, 'resumes'));
      const newResumeId = newResumeRef.id;
      const defaultDraftData: FirestoreResumeData = {
        resumeId: newResumeId, userId: userId, title: 'مسودة السيرة الذاتية',
        personalInfo: { fullName: currentUser?.displayName || '', email: currentUser?.email || '', jobTitle: '', phone: '', address: '' },
        summary: '', education: [], experience: [], skills: [], languages: [], hobbies: [], customSections: [],
        parsingDone: true, parsingError: null, storagePath: null, originalFileName: null,
        createdAt: firestoreServerTimestamp() as any, updatedAt: firestoreServerTimestamp() as any,
      };
      await setDoc(newResumeRef, defaultDraftData);
      console.info(`[loadInitialCv] New draft resume created with ID: ${newResumeId}`);
      await updateDoc(doc(db, "users", userId), { latestResumeId: newResumeId, updatedAt: firestoreServerTimestamp() });
      console.info(`[loadInitialCv] Updated latestResumeId for user ${userId} to ${newResumeId}`);
      setCurrentResumeId(newResumeId); // Set the app's currentResumeId
      updateFormWithData(defaultDraftData);

    } catch (error) {
      console.error('[loadInitialCv] Error loading/creating initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل أو إنشاء بيانات السيرة الذاتية.', variant: 'destructive' });
    } finally {
        setIsLoadingCv(false);
    }
  }, [currentUser, toast, updateFormWithData, currentResumeId]);


  // Effect to load the initial CV or create a new one if none exists
  useEffect(() => {
    if (currentUser?.uid && !currentResumeId && isLoadingCv) { // Only load if no current ID and still in initial loading phase
        console.info("[User/Mount Effect] User available, no currentResumeId set, initial load. Calling loadInitialCv.");
        loadInitialCv(currentUser.uid);
    } else if (!currentUser?.uid) {
        console.info("[User/Mount Effect] No user. Resetting states.");
        setCurrentResumeId(null);
        setCurrentRawResumeData(null);
        form.reset(normalizeResumeData(null, null));
        setIsLoadingCv(false); // Ensure loading stops if no user
        stopProcessingTimer(false);
        processedResumeIdRef.current = null;
    } else if (currentUser?.uid && currentResumeId && isLoadingCv) {
        // If there's a user and a resumeId, but we are still in isLoadingCv,
        // it implies loadInitialCv might have set currentResumeId but hasn't finished loading data for it,
        // or the snapshot listener is about to kick in.
        // This state should resolve once loadInitialCv completes or the listener provides data.
        console.info(`[User/Mount Effect] User ${currentUser.uid} and resumeId ${currentResumeId} exist, but still isLoadingCv. Waiting for data load or listener.`);
    }

  }, [currentUser?.uid, currentResumeId, loadInitialCv, stopProcessingTimer, form, isLoadingCv]);


  // Effect to listen to the current resume document
  useEffect(() => {
    if (!currentUser?.uid || !currentResumeId) { // << GUARD: Only subscribe when we have a currentResumeId
      console.info(`[Resume Listener] Skipping setup: User UID: ${currentUser?.uid}, Resume ID: ${currentResumeId}`);
      if (!isProcessingPdf && !currentUser?.uid && !currentResumeId) setIsLoadingCv(false);
      return;
    }

    console.info(`[Resume Listener] Setting up for: users/${currentUser.uid}/resumes/${currentResumeId}.`);

    // Only set main loading state if not already processing a PDF and no raw data yet
    if (!isProcessingPdf && !currentRawResumeData) {
        setIsLoadingCv(true);
    }

    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap) => {
      console.info(`[Resume Listener] Snapshot received for resume: ${currentResumeId}. Exists: ${docSnap.exists()}`);
      if (docSnap.exists()) {
        const updatedCvData = { ...docSnap.data(), resumeId: docSnap.id } as FirestoreResumeData; // Spread data first, then ID
        console.info("[Resume Listener] Raw data from Firestore:", JSON.stringify(updatedCvData).substring(0, 300) + "...");

        // No need to re-set currentResumeId here, it's already the correct one we're listening to
        updateFormWithData(updatedCvData); // Update form with data from the snapshot

        if (!isProcessingPdf) {
            setIsLoadingCv(false);
        }

        const wasProcessingPdf = isProcessingPdf; // Capture state before potential update
        const alreadyProcessedThisCycle = processedResumeIdRef.current === updatedCvData.resumeId;

        if (updatedCvData.parsingDone || updatedCvData.parsingError) {
          if (wasProcessingPdf || !alreadyProcessedThisCycle) {
            console.info(`[Resume Listener] Parsing status for ${updatedCvData.resumeId}: done=${updatedCvData.parsingDone}, error=${updatedCvData.parsingError}. Was processing: ${wasProcessingPdf}. Stopping timer.`);
            stopProcessingTimer(!updatedCvData.parsingError);

            if (!alreadyProcessedThisCycle) {
              if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
                toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
              } else if (updatedCvData.parsingError) {
                toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 10000 });
              }
              processedResumeIdRef.current = updatedCvData.resumeId; // Mark this resumeId's toast as shown
            }
          }
        } else if (updatedCvData.storagePath && !updatedCvData.parsingDone && !updatedCvData.parsingError && !wasProcessingPdf && !processingTimerRef.current) {
          console.info(`[Resume Listener] PDF ${updatedCvData.resumeId} (storage: ${updatedCvData.storagePath}) awaiting parsing. Starting timer.`);
          startProcessingTimer();
          processedResumeIdRef.current = null; // Reset toast shown flag for new processing cycle
        } else if (!updatedCvData.storagePath && wasProcessingPdf) {
            console.info(`[Resume Listener] No storage path for ${updatedCvData.resumeId} but was processing. Stopping timer.`);
            stopProcessingTimer(false);
        }

      } else {
        console.warn(`[Resume Listener] Resume document ${currentResumeId} does not exist for user ${currentUser.uid}. Will attempt to load/create initial if not already doing so.`);
        if (!isProcessingPdf) setIsLoadingCv(false);
        stopProcessingTimer(false);
        // Consider setting currentResumeId to null here to trigger a reload via the other useEffect
        setCurrentResumeId(null); // Clear the non-existent ID
      }
    }, (error) => {
      console.error(`[Resume Listener] Firestore listener error for users/${currentUser.uid}/resumes/${currentResumeId}:`, error);
      setIsLoadingCv(false);
      stopProcessingTimer(false);
      toast({ title: 'خطأ في المزامنة', description: 'حدث خطأ أثناء تحديث السيرة الذاتية.', variant: 'destructive' });
    });

    return () => {
      console.info(`[Resume Listener] Unsubscribing from resume: ${currentResumeId}`);
      unsubscribeResume();
      // Clear timer if component unmounts or dependencies change
      if (processingTimerRef.current) {
        clearInterval(processingTimerRef.current);
        processingTimerRef.current = null;
        console.info("[Resume Listener Cleanup] Cleared processing timer on unmount/re-run.");
      }
    };
   }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, currentRawResumeData]); // Depends on currentResumeId now


  const currentFormData = form.watch();

  useEffect(() => {
      const hasPersonalInfo = Object.values(currentFormData.personalInfo ?? {}).some(v => !!v);
      const hasSummary = !!currentFormData.summary;
      const hasExperience = currentFormData.experience && currentFormData.experience.length > 0 && currentFormData.experience.some(e => Object.values(e).some(v => !!v));
      const hasEducation = currentFormData.education && currentFormData.education.length > 0 && currentFormData.education.some(e => Object.values(e).some(v => !!v));
      const hasSkills = currentFormData.skills && currentFormData.skills.length > 0 && currentFormData.skills.some(s => !!s.name);

      setHasPrintableData(hasPersonalInfo || hasSummary || hasExperience || hasEducation || hasSkills);
  }, [currentFormData]);


  let statusMessage = '';
  if (isProcessingPdf) {
    statusMessage = "جاري استخراج البيانات...";
  } else if (isLoadingCv && (!currentRawResumeData || !currentResumeId) && currentUser) {
    statusMessage = "جاري تحميل البيانات...";
  }

  const showOverallLoader = isLoadingCv && (!currentRawResumeData || !currentResumeId) && !!currentUser && !isProcessingPdf;


  const handleDownloadCv = () => {
    if (!hasPrintableData) {
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

  return (
    <div className="flex flex-col h-screen bg-muted/40 print:bg-white">
      <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0 print:hidden">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
          {(isProcessingPdf || (isLoadingCv && statusMessage && !isProcessingPdf && !currentRawResumeData && !!currentUser)) && (
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
            <Button variant="outline" onClick={handleDownloadCv} size="sm" disabled={isProcessingPdf || !hasPrintableData}>
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
            <p className='mr-4 text-muted-foreground text-lg'>{statusMessage || "التحميل..."}</p>
         </div>
      ) : (
        <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden print:p-0 print:overflow-visible print:block">
          <section
            id="cv-preview-section"
            className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar print:shadow-none print:rounded-none print:border-none"
            dir="ltr"
          >
             {/* Render preview if not loading OR if we have some data/form is dirty */}
             {(!isLoadingCv || currentRawResumeData || form.formState.isDirty || hasPrintableData) && <CvPreview data={currentFormData} />}
          </section>

          <section
            className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar print:hidden"
          >
             {/* Wrap CvForm in the FormProvider and use key for remounting */}
             <FormProvider {...form}>
                 <CvForm
                     key={currentResumeId || 'new-cv'} // Use resumeId as key
                     isLoadingCv={isLoadingCv && !currentRawResumeData}
                 />
             </FormProvider>
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
