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
import { Form } from '@/components/ui/form'; // Make sure Form is imported
import { Progress } from '@/components/ui/progress'; // For progress bar


function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); // For initial load or when switching resumes
  const [isProcessingPdf, setIsProcessingPdf] = useState(false); // True when PDF is uploaded and awaiting function processing
  const [processingProgress, setProcessingProgress] = useState(0); // For the visual timer
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth();
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null);
  const [currentRawResumeData, setCurrentRawResumeData] = useState<FirestoreResumeData | null>(null);
  
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const processedResumeIdRef = useRef<string | null>(null); // Tracks the resume ID that has shown a toast (success/error)
  const [hasPrintableData, setHasPrintableData] = React.useState(false);


  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser), // Initialize with default schema values
    mode: 'onChange',
  });

  // Callback to update form with new data
  const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null) => {
    console.info(`[updateFormWithData] Received data. CurrentResumeId: ${currentResumeId}. Has data: ${!!parsedData}`, parsedData ? Object.keys(parsedData) : 'null');
    const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
    console.info("[updateFormWithData] Normalized Data for form reset:", normalizedData);

    try {
      // cvSchema.parse(normalizedData); // Temporarily disable validation during reset for partial data
      form.reset(normalizedData, { keepDefaultValues: false });
      setCurrentRawResumeData(parsedData as FirestoreResumeData | null); 
      console.info("[updateFormWithData] Form reset successful.");
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
    setIsProcessingPdf(true); // Ensure this is set
    setProcessingProgress(0);

    const totalDuration = 30000; // 30 seconds total simulation time
    const intervalTime = 100; // Update every 100ms
    const steps = totalDuration / intervalTime;
    const increment = 100 / steps;

    processingTimerRef.current = setInterval(() => {
      setProcessingProgress((prevProgress) => {
        const newProgress = prevProgress + increment;
        if (newProgress >= 99) { // Stop just before 100 to let Firestore event finalize it
          // Don't clear interval here, let stopProcessingTimer handle it or let it run to 100 if no Firestore confirmation
          return 99;
        }
        return newProgress;
      });
    }, intervalTime);
  }, [processingProgress]); // Added processingProgress

  const stopProcessingTimer = useCallback((isSuccess: boolean = true) => {
    if (processingTimerRef.current) {
      console.info("[ProcessingTimer] Stopping PDF processing timer.");
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    if (isProcessingPdf) { // Only set if it was true
        console.info("[ProcessingTimer] Setting isProcessingPdf to false.");
        setIsProcessingPdf(false);
    }
    setProcessingProgress(isSuccess ? 100 : 0); // Show full or reset based on outcome
     if(isSuccess) {
        setTimeout(()=> setProcessingProgress(0), 2000); // Reset progress bar after a short delay on success
     }
  }, [isProcessingPdf]);


  // Function to load the initial CV or create a new draft
  const loadInitialCv = useCallback(async (userId: string) => {
    console.info(`[loadInitialCv] Attempting for user: ${userId}. CurrentState: currentResumeId=${currentResumeId}, isLoadingCv=${isLoadingCv}`);
    if (!isLoadingCv) setIsLoadingCv(true);
    let loadedCvData: FirestoreResumeData | null = null;

    try {
      const userDocRef = doc(db, 'users', userId);
      const userDocSnap = await getDoc(userDocRef);
      let resumeIdToLoad: string | null = null;

      if (userDocSnap.exists() && userDocSnap.data()?.latestResumeId) {
        resumeIdToLoad = userDocSnap.data()?.latestResumeId;
        console.info(`[loadInitialCv] User has latestResumeId: ${resumeIdToLoad}`);
      } else {
        console.info("[loadInitialCv] No latestResumeId. Querying for most recent resume.");
        const resumesRef = collection(db, 'users', userId, 'resumes');
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          resumeIdToLoad = querySnapshot.docs[0].id;
          console.info(`[loadInitialCv] Found most recent resume by query: ${resumeIdToLoad}`);
        }
      }

      if (resumeIdToLoad) {
        console.info(`[loadInitialCv] Attempting to load resume document ID: ${resumeIdToLoad}`);
        const cvDocRef = doc(db, 'users', userId, 'resumes', resumeIdToLoad);
        const cvDocSnap = await getDoc(cvDocRef);
        if (cvDocSnap.exists()) {
          loadedCvData = { resumeId: cvDocSnap.id, ...cvDocSnap.data() } as FirestoreResumeData;
          console.info("[loadInitialCv] Successfully loaded initial CV data:", loadedCvData);
          setCurrentResumeId(loadedCvData.resumeId); // Set currentResumeId BEFORE updating form
          updateFormWithData(loadedCvData);
          // setIsLoadingCv(false); // Listener will handle this
          return; // Exit after successful load
        } else {
           console.warn(`[loadInitialCv] latestResumeId ${resumeIdToLoad} points to non-existent doc. Will create new draft.`);
           resumeIdToLoad = null; // Reset to create new
        }
      }
      
      console.info("[loadInitialCv] No existing valid CV found or forced new, creating new draft.");
      const newResumeRef = doc(collection(db, 'users', userId, 'resumes'));
      const newResumeId = newResumeRef.id;
      const defaultDraftData: FirestoreResumeData = {
        resumeId: newResumeId,
        userId: userId,
        title: 'مسودة السيرة الذاتية',
        personalInfo: { fullName: currentUser?.displayName || '', email: currentUser?.email || '', jobTitle: '', phone: '', address: '' },
        summary: '', education: [], experience: [], skills: [], languages: [], hobbies: [], customSections: [],
        parsingDone: true, // New manual draft is "parsed"
        parsingError: null, 
        storagePath: null, originalFileName: null,
        createdAt: firestoreServerTimestamp() as any,
        updatedAt: firestoreServerTimestamp() as any,
      };
      await setDoc(newResumeRef, defaultDraftData);
      console.info(`[loadInitialCv] New draft resume created with ID: ${newResumeId}`);
      
      // Update latestResumeId on user document
      await updateDoc(doc(db, "users", userId), { latestResumeId: newResumeId, updatedAt: firestoreServerTimestamp() });
      console.info(`[loadInitialCv] Updated latestResumeId for user ${userId} to ${newResumeId}`);
      
      setCurrentResumeId(newResumeId); // Set currentResumeId for the new draft
      updateFormWithData(defaultDraftData);
      // setIsLoadingCv(false); // Listener will handle this
    } catch (error) {
      console.error('[loadInitialCv] Error loading/creating initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل أو إنشاء بيانات السيرة الذاتية.', variant: 'destructive' });
      updateFormWithData(null); // Reset form on error
      setIsLoadingCv(false); // Critical: ensure loading stops on error
    }
  }, [currentUser, toast, updateFormWithData, isLoadingCv, currentResumeId]); // Added currentResumeId


  // Effect to load user's CV or create one if none exists
  useEffect(() => {
    console.info(`[User/Mount Effect] currentUser?.uid: ${currentUser?.uid}. App's currentResumeId: ${currentResumeId}. isLoadingCv: ${isLoadingCv}. isProcessingPdf: ${isProcessingPdf}`);
    if (currentUser?.uid && !currentResumeId && isLoadingCv && !isProcessingPdf) { 
      // Only load if user exists, no resumeId yet, we are in loading state, and not currently processing a PDF
      console.info("[User/Mount Effect] User available, no currentResumeId, initial load. Calling loadInitialCv.");
      loadInitialCv(currentUser.uid);
    } else if (!currentUser?.uid) {
      console.info("[User/Mount Effect] No user. Resetting states.");
      setCurrentResumeId(null);
      setCurrentRawResumeData(null); 
      updateFormWithData(null); 
      setIsLoadingCv(false); // No user, so not loading CV data.
      stopProcessingTimer(false);
      processedResumeIdRef.current = null;
      form.reset(normalizeResumeData(null, null)); 
    }
  }, [currentUser?.uid, loadInitialCv, updateFormWithData, stopProcessingTimer, form, currentResumeId, isLoadingCv, isProcessingPdf]);


  // Firestore listener for the current resume
  useEffect(() => {
    if (!currentUser?.uid || !currentResumeId) {
      console.info(`[Resume Listener] Skipping setup: User UID: ${currentUser?.uid}, Resume ID: ${currentResumeId}`);
       if (!isProcessingPdf && isLoadingCv && !currentUser?.uid) setIsLoadingCv(false);
      return;
    }

    console.info(`[Resume Listener] Setting up for: users/${currentUser.uid}/resumes/${currentResumeId}. isProcessingPdf: ${isProcessingPdf}, isLoadingCv: ${isLoadingCv}`);
    
    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap) => {
      console.info(`[Resume Listener] Snapshot received for resume: ${currentResumeId}. Exists: ${docSnap.exists()}`);
      if (docSnap.exists()) {
        const updatedCvData = { resumeId: docSnap.id, ...docSnap.data() } as FirestoreResumeData;
        console.info("[Resume Listener] Raw data from Firestore:", JSON.stringify(updatedCvData).substring(0, 300) + "..."); // Log snippet
        
        // Only update form if data is substantially different or if it's the first load for this resume
        const isDataDifferent = JSON.stringify(updatedCvData) !== JSON.stringify(currentRawResumeData);

        if (isDataDifferent || !currentRawResumeData || currentRawResumeData.resumeId !== updatedCvData.resumeId) { 
            console.info("[Resume Listener] Data is different or initial load for this resume. Calling updateFormWithData.");
            updateFormWithData(updatedCvData); 
        } else {
            console.info("[Resume Listener] Data is same as currentRawResumeData, no form update needed from listener. Checking processing status.");
        }
        
        setIsLoadingCv(false); // Data loaded (or confirmed not found), stop initial loading state

        // Handle PDF processing status
        if (updatedCvData.parsingDone || updatedCvData.parsingError) {
          const alreadyProcessedThisToast = processedResumeIdRef.current === updatedCvData.resumeId;
          
          if (isProcessingPdf || !alreadyProcessedThisToast) { // If we were processing OR haven't toasted for this one yet
            console.info(`[Resume Listener] Parsing status for ${updatedCvData.resumeId}: done=${updatedCvData.parsingDone}, error=${updatedCvData.parsingError}. Stopping timer.`);
            stopProcessingTimer(!updatedCvData.parsingError); // Stop timer, indicate success based on error presence
            
            if (!alreadyProcessedThisToast) { // Show toast only once per resume ID completion/error
              if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
                toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
              } else if (updatedCvData.parsingError) {
                toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 10000 });
              }
              processedResumeIdRef.current = updatedCvData.resumeId; // Mark this resume ID as toasted
            }
          }
        } else if (updatedCvData.storagePath && !isProcessingPdf && !processingTimerRef.current) { 
          // File exists in storage, but parsing isn't done/errored, and we are not already processing. Start the timer.
          console.info(`[Resume Listener] PDF ${updatedCvData.resumeId} exists, awaiting parsing. Starting timer.`);
          startProcessingTimer(); 
          // Clear the processed ref if we re-upload the same file or start processing again
           if (processedResumeIdRef.current === updatedCvData.resumeId) {
             processedResumeIdRef.current = null;
          }
        } else if (!updatedCvData.storagePath && isProcessingPdf) {
            // No storage path, but we thought we were processing? Stop the timer.
            console.info(`[Resume Listener] No storage path for ${updatedCvData.resumeId} but was processing. Stopping timer.`);
            stopProcessingTimer(false);
        }

      } else {
        console.warn(`[Resume Listener] Resume document ${currentResumeId} does not exist. User: ${currentUser.uid}.`);
        setIsLoadingCv(false); // Stop loading if doc doesn't exist
        stopProcessingTimer(false); // Stop any processing timer
        // Optionally: Trigger reload or creation if the expected doc vanished
         // loadInitialCv(currentUser.uid); // Be careful not to cause infinite loops
      }
    }, (error) => {
      console.error(`[Resume Listener] Firestore listener error for ${currentResumeId}:`, error);
      setIsLoadingCv(false); // Stop loading on error
      stopProcessingTimer(false);
      toast({ title: 'خطأ في المزامنة', description: 'حدث خطأ أثناء تحديث السيرة الذاتية.', variant: 'destructive' });
    });

    return () => {
      console.info(`[Resume Listener] Unsubscribing from resume: ${currentResumeId}`);
      unsubscribeResume();
      // Clear timer when unsubscribing or changing resume
      if (processingTimerRef.current) {
        clearInterval(processingTimerRef.current);
        processingTimerRef.current = null;
      }
    };
  }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, currentRawResumeData, isLoadingCv]); // Re-added dependencies carefully


  const currentFormData = form.watch();

  // Determine if there's enough data to warrant showing the download button
  useEffect(() => {
      const hasPersonalInfo = Object.values(currentFormData.personalInfo ?? {}).some(v => v);
      const hasSummary = !!currentFormData.summary;
      const hasExperience = currentFormData.experience && currentFormData.experience.length > 0 && currentFormData.experience.some(e => Object.values(e).some(v => v));
      const hasEducation = currentFormData.education && currentFormData.education.length > 0 && currentFormData.education.some(e => Object.values(e).some(v => v));
      const hasSkills = currentFormData.skills && currentFormData.skills.length > 0 && currentFormData.skills.some(s => s.name);
      
      setHasPrintableData(hasPersonalInfo || hasSummary || hasExperience || hasEducation || hasSkills);
  }, [currentFormData]);


  // Status message logic
  let statusMessage = '';
  if (isProcessingPdf) {
    statusMessage = "جاري استخراج البيانات...";
  } else if (isLoadingCv && !currentRawResumeData && currentUser) {
    statusMessage = "جاري تحميل البيانات...";
  }
  
  // Determine when to show the main page loader
  const showOverallLoader = isLoadingCv && !currentResumeId && !!currentUser; // Show loader ONLY during the absolute initial load before any resume ID is set


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
          {(isProcessingPdf || (isLoadingCv && statusMessage)) && ( // Show status if processing OR initial loading with message
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
             {isProcessingPdf && ( // Also show progress here if relevant during initial load overlap
                <div className="w-48 ml-4">
                  <Progress value={processingProgress} className="h-3" />
                </div>
              )}
         </div>
      ) : (
        <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden print:p-0 print:overflow-visible print:block">
          {/* Preview Pane (Left in LTR, Right in RTL but forced LTR inside) */}
          <section
            id="cv-preview-section"
            className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar print:shadow-none print:rounded-none print:border-none"
            dir="ltr" // Force LTR for the preview content itself
          >
            {/* Only render preview if form has data or is not in initial loading */}
             {(!isLoadingCv || currentRawResumeData) && <CvPreview data={currentFormData} />}
          </section>
          
          {/* Form Pane (Right in LTR, Left in RTL) */}
          <section
            className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar print:hidden"
          >
             {/* Wrap CvForm in the FormProvider */}
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


    