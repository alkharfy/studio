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
import { Form } from '@/components/ui/form'; // Import the Form component
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
  // useRef to track if toast was shown for the current cycle, prevents duplicates
  const processedResumeIdRef = useRef<string | null>(null);
  const [hasPrintableData, setHasPrintableData] = React.useState(false);

  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser),
    mode: 'onChange',
  });

  const updateFormWithData = useCallback((parsedData: FirestoreResumeData | null) => {
    console.info(`[updateFormWithData] Received data. Has data: ${!!parsedData}`, parsedData ? `Resume ID: ${parsedData.resumeId}, Keys: ${Object.keys(parsedData).join(', ')}` : 'null');
    const normalizedData = normalizeResumeData(parsedData, currentUser);
    console.info("[updateFormWithData] Normalized Data for form reset:", JSON.stringify(normalizedData).substring(0,200) + "...");

    try {
      // cvSchema.parse(normalizedData); // Temporarily disabled to avoid strict validation on load
      form.reset(normalizedData, { keepDefaultValues: false });
      setCurrentRawResumeData(parsedData); // Store the raw data used for this update
      console.info("[updateFormWithData] Form reset successful.");
    } catch (error: any) {
      console.error("[updateFormWithData] Zod validation failed on normalized data for form reset:", error.errors);
      toast({ title: 'خطأ في تحديث النموذج', description: 'البيانات المستلمة غير متوافقة مع النموذج.', variant: 'destructive' });
    }
  }, [form, currentUser, toast]); // Removed currentResumeId dependency

  const startProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
        console.info("[ProcessingTimer] Timer already running.");
        return;
    }
    console.info("[ProcessingTimer] Starting PDF processing timer.");
    setIsProcessingPdf(true);
    setProcessingProgress(0);

    const totalDuration = 30000; // 30 seconds simulation
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
    console.info(`[loadInitialCv] Attempting for user: ${userId}.`);
    setIsLoadingCv(true);
    let resumeIdToLoad: string | null = null;
    let loadedData: FirestoreResumeData | null = null;

    try {
      // 1. Check user document for latestResumeId
      const userDocRef = doc(db, 'users', userId);
      const userDocSnap = await getDoc(userDocRef);
      if (userDocSnap.exists() && userDocSnap.data()?.latestResumeId) {
          resumeIdToLoad = userDocSnap.data()?.latestResumeId;
          console.info(`[loadInitialCv] Found latestResumeId from user doc: ${resumeIdToLoad}.`);
      }

      // 2. If a resumeId is identified, try to load it
      if (resumeIdToLoad) {
          console.info(`[loadInitialCv] Attempting to load resume: ${resumeIdToLoad}`);
          const cvDocRef = doc(db, 'users', userId, 'resumes', resumeIdToLoad);
          const cvDocSnap = await getDoc(cvDocRef);
          if (cvDocSnap.exists()) {
              loadedData = { ...cvDocSnap.data(), resumeId: cvDocSnap.id } as FirestoreResumeData;
              console.info(`[loadInitialCv] Successfully loaded resume: ${loadedData.resumeId}`);
              // Set the currentResumeId state variable here
              setCurrentResumeId(loadedData.resumeId);
              updateFormWithData(loadedData);
              // The onSnapshot listener will take over for subsequent updates. Don't return here.
          } else {
              console.warn(`[loadInitialCv] Resume ID ${resumeIdToLoad} not found. Will query or create new.`);
              resumeIdToLoad = null; // Reset as it's invalid
          }
      }

      // 3. If still no valid resumeId, query for the most recent resume
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
           // Set the currentResumeId state variable here
          setCurrentResumeId(loadedData.resumeId);
          updateFormWithData(loadedData);
          // The onSnapshot listener will take over for subsequent updates. Don't return here.
        } else {
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
          await updateDoc(userDocRef, { latestResumeId: newResumeId, updatedAt: firestoreServerTimestamp() });
          console.info(`[loadInitialCv] Updated latestResumeId for user ${userId} to ${newResumeId}`);
          // Set the currentResumeId state variable here
          setCurrentResumeId(newResumeId);
          updateFormWithData(defaultDraftData);
        }
      }

    } catch (error) {
      console.error('[loadInitialCv] Error loading/creating initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل أو إنشاء بيانات السيرة الذاتية.', variant: 'destructive' });
    } finally {
        // Removed setIsLoadingCv(false) here; let the snapshot listener handle it
    }
  }, [currentUser, toast, updateFormWithData]); // Removed currentResumeId from deps


  // Effect to load the initial CV ONCE when user logs in
  useEffect(() => {
    if (currentUser?.uid && !currentResumeId && isLoadingCv) { // Only load if no current ID and still in initial loading phase
        console.info("[User/Mount Effect] User available, no currentResumeId set, initial load. Calling loadInitialCv.");
        loadInitialCv(currentUser.uid);
    } else if (!currentUser?.uid) {
        console.info("[User/Mount Effect] No user. Resetting states.");
        setCurrentResumeId(null); // Reset ID when user logs out
        setCurrentRawResumeData(null);
        form.reset(normalizeResumeData(null, null));
        setIsLoadingCv(false); // Ensure loading stops if no user
        stopProcessingTimer(false);
        processedResumeIdRef.current = null;
    }
     // Removed the else if block that was causing re-renders

  }, [currentUser?.uid, loadInitialCv, stopProcessingTimer, form, isLoadingCv, currentResumeId]); // Added currentResumeId here


  // Effect to listen to the current resume document - THIS IS THE MAIN LISTENER
  useEffect(() => {
    // GUARD: Only subscribe when we have a currentResumeId AND a user
    if (!currentUser?.uid || !currentResumeId) {
      console.info(`[Resume Listener] Skipping setup: User UID: ${currentUser?.uid}, Resume ID: ${currentResumeId}`);
       // If we don't have a user or ID, ensure loading is false unless actively processing PDF
       if (!isProcessingPdf) setIsLoadingCv(false);
      return; // Don't setup listener if no user or resumeId
    }

    console.info(`[Resume Listener] Setting up for: users/${currentUser.uid}/resumes/${currentResumeId}.`);

    // Set loading state only if we don't have raw data yet and not processing PDF
    if (!currentRawResumeData && !isProcessingPdf) {
        setIsLoadingCv(true);
    }

    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap) => {
      console.info(`[Resume Listener] Snapshot received for resume: ${currentResumeId}. Exists: ${docSnap.exists()}`);
      if (docSnap.exists()) {
        const updatedCvData = { ...docSnap.data(), resumeId: docSnap.id } as FirestoreResumeData;
        console.info("[Resume Listener] Raw data from Firestore:", JSON.stringify(updatedCvData).substring(0, 300) + "...");

        // No need to call setCurrentResumeId here, it's already the correct one
        updateFormWithData(updatedCvData); // Update form with data from the snapshot
        setIsLoadingCv(false); // Data received, stop loading

        const wasProcessingPdf = isProcessingPdf; // Capture state before potential update
        const alreadyProcessedThisCycle = processedResumeIdRef.current === updatedCvData.resumeId;

        // Check parsing status and handle UI updates/toasts
        if (updatedCvData.parsingDone || updatedCvData.parsingError) {
          if (wasProcessingPdf || !alreadyProcessedThisCycle) {
            console.info(`[Resume Listener] Parsing status for ${updatedCvData.resumeId}: done=${updatedCvData.parsingDone}, error=${updatedCvData.parsingError}. Was processing: ${wasProcessingPdf}. Stopping timer.`);
            stopProcessingTimer(!updatedCvData.parsingError); // Stop timer, success based on no error

            // Show toast only once per processing cycle
            if (!alreadyProcessedThisCycle) {
              if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
                toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
              } else if (updatedCvData.parsingError) {
                toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 10000 });
              }
              processedResumeIdRef.current = updatedCvData.resumeId; // Mark this resumeId's toast as shown
            }
          }
        } else if (updatedCvData.storagePath && !updatedCvData.parsingDone && !updatedCvData.parsingError && !wasProcessingPdf) {
          // File uploaded but not yet processed, start the timer if not already running
          console.info(`[Resume Listener] PDF ${updatedCvData.resumeId} (storage: ${updatedCvData.storagePath}) awaiting parsing. Starting timer.`);
          startProcessingTimer();
          processedResumeIdRef.current = null; // Reset toast shown flag for new processing cycle
        } else if (!updatedCvData.storagePath && wasProcessingPdf) {
            // No storage path but was processing (e.g., upload failed), stop timer
            console.info(`[Resume Listener] No storage path for ${updatedCvData.resumeId} but was processing. Stopping timer.`);
            stopProcessingTimer(false);
        }

      } else {
        // Document doesn't exist (e.g., deleted or invalid ID)
        console.warn(`[Resume Listener] Resume document ${currentResumeId} does not exist for user ${currentUser.uid}. Resetting resume ID.`);
        setCurrentResumeId(null); // Reset the ID to trigger reload/creation logic
        setIsLoadingCv(false); // Stop loading
        stopProcessingTimer(false); // Stop any processing timer
      }
    }, (error) => {
      // Handle listener errors
      console.error(`[Resume Listener] Firestore listener error for users/${currentUser.uid}/resumes/${currentResumeId}:`, error);
      setIsLoadingCv(false);
      stopProcessingTimer(false);
      toast({ title: 'خطأ في المزامنة', description: 'حدث خطأ أثناء تحديث السيرة الذاتية.', variant: 'destructive' });
    });

    // Cleanup function
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
   // This effect depends ONLY on the user and the specific resume ID
   }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, currentRawResumeData]);


  // Watch form data for preview updates and print readiness
  const currentFormData = form.watch();

  useEffect(() => {
      const hasPersonalInfo = Object.values(currentFormData.personalInfo ?? {}).some(v => !!v);
      const hasSummary = !!currentFormData.summary;
      const hasExperience = currentFormData.experience && currentFormData.experience.length > 0 && currentFormData.experience.some(e => Object.values(e).some(v => !!v));
      const hasEducation = currentFormData.education && currentFormData.education.length > 0 && currentFormData.education.some(e => Object.values(e).some(v => !!v));
      const hasSkills = currentFormData.skills && currentFormData.skills.length > 0 && currentFormData.skills.some(s => !!s.name);

      setHasPrintableData(hasPersonalInfo || hasSummary || hasExperience || hasEducation || hasSkills);
       console.log("[Printable Check] Has printable data:", hasPersonalInfo || hasSummary || hasExperience || hasEducation || hasSkills);
  }, [currentFormData]);


  // Determine status message and loading state
  let statusMessage = '';
  if (isProcessingPdf) {
    statusMessage = "جاري استخراج البيانات...";
  } else if (isLoadingCv && (!currentRawResumeData || !currentResumeId) && currentUser) {
    statusMessage = "جاري تحميل البيانات...";
  }

  // Show overall loader only during initial load before any data/ID is available
  const showOverallLoader = isLoadingCv && !currentResumeId && !!currentUser;

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
          {(isProcessingPdf || statusMessage) && ( // Show status if processing or loading
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
             {/* Render preview if not initial loading OR if we have some data/form is dirty */}
             {(!isLoadingCv || currentRawResumeData || form.formState.isDirty || hasPrintableData) && <CvPreview data={currentFormData} />}
          </section>

          <section
            className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar print:hidden"
          >
             {/* Wrap CvForm in the FormProvider and use key for remounting */}
             {/* Ensure FormProvider wraps CvForm */}
              <FormProvider {...form}>
                 <CvForm
                     key={currentResumeId || 'new-cv'} // Use resumeId as key to force remount on change
                     isLoadingCv={isLoadingCv && !currentRawResumeData} // Pass loading state based on raw data absence
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
