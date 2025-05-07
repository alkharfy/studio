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
  const [currentRawResumeData, setCurrentRawResumeData] = useState<FirestoreResumeData | null>(null); // Holds raw data of current resume
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser),
    mode: 'onChange',
  });

  const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null) => {
    console.info(`[updateFormWithData] Data Received:`, parsedData);
    const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
    console.info("[updateFormWithData] Normalized Data:", normalizedData);

    try {
      cvSchema.parse(normalizedData); // Validate before resetting
      form.reset(normalizedData, { keepDefaultValues: false });
      console.info("[updateFormWithData] Form reset successful.");
    } catch (error: any) {
      console.error("[updateFormWithData] Error resetting form:", error);
      if (error.name === 'ZodError') {
        console.warn("[updateFormWithData] Zod validation failed on normalized data:", error.errors);
         // If validation fails, it means the incoming data (even after normalization) is not fitting the schema.
         // This might be okay if it's an intermediate state (e.g., parsing error), but for form reset, it must be valid.
         // Consider if form should be reset to a "clean" default state if `parsedData` is invalid.
         // For now, we log the Zod error. If the data is from Firestore, the schema there should match the form's expected schema.
      }
      // Do not toast generic error here, specific errors (like parsingError) are handled by listeners
    }
  }, [form, currentUser]); // Removed toast from deps as it's stable

  const startProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
        console.info("[startProcessingTimer] Timer already running.");
        return;
    }
    console.info("[startProcessingTimer] Starting processing timer.");
    setIsProcessingPdf(true);
    setProcessingProgress(0);

    const totalDuration = 30000; // 30 seconds
    const intervalTime = 100; // update every 100ms
    const steps = totalDuration / intervalTime;
    const increment = 100 / steps;

    processingTimerRef.current = setInterval(() => {
      setProcessingProgress((prevProgress) => {
        const newProgress = prevProgress + increment;
        if (newProgress >= 100) {
          if (processingTimerRef.current) clearInterval(processingTimerRef.current);
          processingTimerRef.current = null;
          // Don't set isProcessingPdf to false here, let the document state listener do it
          return 100;
        }
        return newProgress;
      });
    }, intervalTime);
  }, [setIsProcessingPdf, setProcessingProgress]); // Dependencies are stable state setters

  const stopProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
      console.info("[stopProcessingTimer] Stopping processing timer.");
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    setIsProcessingPdf(false);
    setProcessingProgress(0);
  }, [setIsProcessingPdf, setProcessingProgress]); // Dependencies are stable state setters


  const loadInitialCv = useCallback(async (userId: string) => {
    console.info("[loadInitialCv] Loading initial CV for user:", userId);
    setIsLoadingCv(true);
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
        console.info("[loadInitialCv] No latestResumeId on user doc, or user doc doesn't exist. Querying for most recent resume.");
        const resumesRef = collection(db, 'users', userId, 'resumes');
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          initialResumeIdToLoad = querySnapshot.docs[0].id;
        }
      }

      if (initialResumeIdToLoad) {
        console.info(`[loadInitialCv] Attempting to load resume ID: ${initialResumeIdToLoad}`);
        const cvDocRef = doc(db, 'users', userId, 'resumes', initialResumeIdToLoad);
        const cvDocSnap = await getDoc(cvDocRef);
        if (cvDocSnap.exists()) {
          loadedCvData = { resumeId: cvDocSnap.id, ...cvDocSnap.data() } as FirestoreResumeData;
          console.info("[loadInitialCv] Loaded initial CV data:", loadedCvData);
          setCurrentRawResumeData(loadedCvData);
          updateFormWithData(loadedCvData);
          setCurrentResumeId(loadedCvData.resumeId);
        } else {
           console.warn(`[loadInitialCv] latestResumeId ${initialResumeIdToLoad} points to a non-existent document.`);
           initialResumeIdToLoad = null;
        }
      }
      
      if (!initialResumeIdToLoad) {
        console.info("[loadInitialCv] No existing CV found or latest was invalid, creating a new draft.");
        const newResumeRef = doc(collection(db, 'users', userId, 'resumes'));
        const newResumeId = newResumeRef.id;
        const defaultDraftData: FirestoreResumeData = {
          resumeId: newResumeId,
          userId: userId,
          title: 'مسودة السيرة الذاتية',
          personalInfo: { fullName: currentUser?.displayName || '', email: currentUser?.email || '', jobTitle: '', phone: '', address: '' },
          summary: '', education: [], experience: [], skills: [], languages: [], hobbies: [], customSections: [],
          parsingDone: true, parsingError: null, storagePath: null, originalFileName: null,
          createdAt: firestoreServerTimestamp() as any, // Cast for SDKv9 compat if needed
          updatedAt: firestoreServerTimestamp() as any,
        };
        await setDoc(newResumeRef, defaultDraftData);
        
        // Update user's latestResumeId
        const userRef = doc(db, "users", userId);
        try {
            await updateDoc(userRef, { latestResumeId: newResumeId, updatedAt: firestoreServerTimestamp() });
            console.info(`[loadInitialCv] Updated latestResumeId for user ${userId} to ${newResumeId}`);
        } catch (userUpdateError) {
            console.error(`[loadInitialCv] Failed to update latestResumeId for user ${userId}:`, userUpdateError);
            // Decide if this error is critical or if app can proceed.
        }
        
        setCurrentRawResumeData(defaultDraftData);
        updateFormWithData(defaultDraftData);
        setCurrentResumeId(newResumeId);
      }
    } catch (error) {
      console.error('[loadInitialCv] Error loading initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل بيانات السيرة الذاتية الأولية.', variant: 'destructive' });
      updateFormWithData(null); // Reset form to default empty state
    } finally {
      setIsLoadingCv(false);
      console.info("[loadInitialCv] Finished loading initial CV.");
    }
  }, [updateFormWithData, toast, currentUser]);


  useEffect(() => {
    if (!currentUser?.uid) {
      console.info("[User Listener] No user, resetting states.");
      setCurrentResumeId(null);
      setCurrentRawResumeData(null);
      updateFormWithData(null);
      setIsLoadingCv(false); 
      stopProcessingTimer();
      processedResumeIdRef.current = null;
      return;
    }

    console.info(`[User Listener] Setting up Firestore listener for user document: users/${currentUser.uid}`);
    const userDocRef = doc(db, "users", currentUser.uid);

    const unsubscribeUser = onSnapshot(userDocRef, (docSnap: DocumentData) => {
      const latestId = docSnap.data()?.latestResumeId || null;
      console.info("[User Listener] User doc snapshot. latestResumeId:", latestId, "| currentResumeId was:", currentResumeId);
      if (latestId && latestId !== currentResumeId) {
        console.info(`[User Listener] latestResumeId changed from ${currentResumeId} to ${latestId}. Updating currentResumeId.`);
        setCurrentResumeId(latestId);
      } else if (!latestId && !currentResumeId && !isLoadingCv) { // Ensure not already loading
        console.info("[User Listener] No latestId on user doc and no currentResumeId. Triggering loadInitialCv.");
        loadInitialCv(currentUser.uid);
      } else if (latestId && latestId === currentResumeId && !currentRawResumeData && !isLoadingCv) {
        console.info(`[User Listener] latestResumeId (${latestId}) matches, but no raw data & not loading. Resume listener should handle or re-load if stuck.`);
        // Potentially, if resume listener fails or doesn't pick up, this could be a place to retry loadInitialCv
        // For now, assume resume listener will fetch.
      }
    }, (error) => {
      console.error("[User Listener] Error:", error);
      toast({ title: "خطأ في مزامنة المستخدم", description: "تعذر تحديث بيانات المستخدم.", variant: "destructive" });
    });

    return () => {
        console.info("[User Listener] Unsubscribing from user document listener.");
        unsubscribeUser();
    };
  }, [currentUser?.uid, loadInitialCv, currentResumeId, toast, updateFormWithData, stopProcessingTimer, currentRawResumeData, isLoadingCv]);

  useEffect(() => {
    if (currentUser?.uid && !currentResumeId && !isLoadingCv) {
        console.info("[Initial Load Trigger] User loaded, no currentResumeId, not loading. Triggering loadInitialCv.");
        loadInitialCv(currentUser.uid);
    }
  }, [currentUser?.uid, currentResumeId, isLoadingCv, loadInitialCv]);


  useEffect(() => {
    if (!currentUser?.uid || !currentResumeId) {
      console.info("[Resume Listener] No user or currentResumeId, skipping listener setup.", { userId: currentUser?.uid, currentResumeId });
      return () => {};
    }

    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    console.info(`[Resume Listener] Setting up listener for: users/${currentUser.uid}/resumes/${currentResumeId}`);
    setIsLoadingCv(true); 

    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap: DocumentData) => {
      setIsLoadingCv(false); 
      if (docSnap.exists()) {
        const updatedCvData = { resumeId: docSnap.id, ...docSnap.data() } as FirestoreResumeData;
        console.info("[Resume Listener] Received update for resume:", updatedCvData.resumeId, "Raw data:", updatedCvData);
        
        const hasRelevantChange = JSON.stringify(updatedCvData) !== JSON.stringify(currentRawResumeData);
        setCurrentRawResumeData(updatedCvData);
        if (hasRelevantChange) {
            updateFormWithData(updatedCvData);
        }


        const isNewlyProcessedOrErrored = processedResumeIdRef.current !== updatedCvData.resumeId && (updatedCvData.parsingDone || updatedCvData.parsingError);

        if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
          console.info(`[Resume Listener] Parsing completed for resume ID: ${updatedCvData.resumeId}. Stopping timer.`);
          stopProcessingTimer();
          if (isNewlyProcessedOrErrored) {
            toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
            processedResumeIdRef.current = updatedCvData.resumeId;
          }
        } else if (updatedCvData.parsingError) {
          console.info(`[Resume Listener] Parsing error for resume ID: ${updatedCvData.resumeId}. Error: ${updatedCvData.parsingError}. Stopping timer.`);
          stopProcessingTimer();
          if (isNewlyProcessedOrErrored) {
            toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 7000 });
            processedResumeIdRef.current = updatedCvData.resumeId;
          }
        } else if (updatedCvData.storagePath && !updatedCvData.parsingDone && !updatedCvData.parsingError) {
          console.info(`[Resume Listener] Resume ID: ${updatedCvData.resumeId} has storagePath, not parsed, no error. Starting/Ensuring timer.`);
          startProcessingTimer(); 
          if (processedResumeIdRef.current === updatedCvData.resumeId) { 
            processedResumeIdRef.current = null;
          }
        } else {
           console.info(`[Resume Listener] Resume ID: ${updatedCvData.resumeId}. No immediate parsing action. Ensuring timer is stopped if not applicable.`);
           if (!updatedCvData.storagePath || updatedCvData.parsingDone || updatedCvData.parsingError) {
               stopProcessingTimer();
           }
        }
      } else {
        console.warn(`[Resume Listener] Document users/${currentUser.uid}/resumes/${currentResumeId} does not exist.`);
        setCurrentRawResumeData(null); 
        if(!isLoadingCv && currentUser?.uid) { // Avoid calling if already loading or no user
             loadInitialCv(currentUser.uid);
        }
        stopProcessingTimer();
      }
    }, (error) => {
      console.error(`[Resume Listener] Firestore listener error for ${currentResumeId}:`, error);
      setIsLoadingCv(false);
      setCurrentRawResumeData(null);
      toast({ title: 'خطأ في المزامنة', description: 'حدث خطأ أثناء الاستماع لتحديثات السيرة الذاتية.', variant: 'destructive' });
      stopProcessingTimer();
    });

    return () => {
      console.info(`[Resume Listener] Unsubscribing from resume document listener: ${currentResumeId}`);
      unsubscribeResume();
    };
  }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, loadInitialCv, isLoadingCv, currentRawResumeData]);


  const currentFormData = form.watch();

  let statusMessage = '';
  if (isLoadingCv && !isProcessingPdf) { 
    statusMessage = "جاري تحميل البيانات...";
  } else if (isProcessingPdf) {
    statusMessage = "جاري استخراج البيانات...";
  }


  const handleDownloadCv = () => {
    window.print();
  };

  return (
    <div className="flex flex-col h-screen bg-muted/40 print:bg-white">
      <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0 print:hidden">
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
            <Button variant="outline" onClick={handleDownloadCv} size="sm">
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
