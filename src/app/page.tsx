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
  const processedResumeIdRef = useRef<string | null>(null);
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
      // cvSchema.parse(normalizedData); // Temporarily disable for debugging Zod issues with defaults
      form.reset(normalizedData, { keepDefaultValues: false });
      setCurrentRawResumeData(parsedData); 
      if(parsedData?.resumeId && currentResumeId !== parsedData.resumeId) {
          console.log(`[updateFormWithData] Updating currentResumeId from ${currentResumeId} to ${parsedData.resumeId}`);
          setCurrentResumeId(parsedData.resumeId); 
      }
      console.info("[updateFormWithData] Form reset successful.");
    } catch (error: any) {
      console.error("[updateFormWithData] Zod validation failed on normalized data for form reset:", error.errors);
      toast({ title: 'خطأ في تحديث النموذج', description: 'البيانات المستلمة غير متوافقة مع النموذج.', variant: 'destructive' });
    }
  }, [form, currentUser, toast, currentResumeId]); // currentResumeId needed here for logging and comparison

  const startProcessingTimer = useCallback(() => {
    if (processingTimerRef.current) {
        console.info("[ProcessingTimer] Timer already running.");
        return;
    }
    console.info("[ProcessingTimer] Starting PDF processing timer.");
    setIsProcessingPdf(true);
    setProcessingProgress(0);

    const totalDuration = 30000; 
    const intervalTime = 100; 
    const steps = totalDuration / intervalTime;
    const increment = 100 / steps;

    processingTimerRef.current = setInterval(() => {
      setProcessingProgress((prevProgress) => {
        const newProgress = prevProgress + increment;
        if (newProgress >= 99) { 
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
    setIsProcessingPdf(false); 
    setProcessingProgress(isSuccess ? 100 : 0); 
     if(isSuccess) {
        setTimeout(()=> setProcessingProgress(0), 2000);
     }
  }, [setIsProcessingPdf, setProcessingProgress]);


  const loadInitialCv = useCallback(async (userId: string) => {
    console.info(`[loadInitialCv] Attempting for user: ${userId}.`);
    let resumeIdToLoad: string | null = null;
    let loadedData: FirestoreResumeData | null = null;

    try {
      const userDocRef = doc(db, 'users', userId);
      const userDocSnap = await getDoc(userDocRef);

      if (userDocSnap.exists() && userDocSnap.data()?.latestResumeId) {
        resumeIdToLoad = userDocSnap.data()?.latestResumeId;
        console.info(`[loadInitialCv] User has latestResumeId: ${resumeIdToLoad}. Verifying document...`);
        const cvDocRef = doc(db, 'users', userId, 'resumes', resumeIdToLoad);
        const cvDocSnap = await getDoc(cvDocRef);
        if (!cvDocSnap.exists()) {
            console.warn(`[loadInitialCv] latestResumeId ${resumeIdToLoad} points to non-existent doc. Will query for most recent or create new.`);
            resumeIdToLoad = null; 
        } else {
            loadedData = cvDocSnap.data() as FirestoreResumeData;
            if(loadedData?.resumeId){
                 console.info(`[loadInitialCv] Found latestResumeId: ${loadedData.resumeId} and document exists.`);
                 setCurrentResumeId(loadedData.resumeId); 
            } else {
                 console.warn(`[loadInitialCv] Document ${resumeIdToLoad} exists but missing resumeId field.`);
                 resumeIdToLoad = null; 
            }
        }
      }
      
      if (!resumeIdToLoad && !currentResumeId) { 
        console.info("[loadInitialCv] No valid latestResumeId or currentResumeId. Querying for most recent resume.");
        const resumesRef = collection(db, 'users', userId, 'resumes');
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
          resumeIdToLoad = querySnapshot.docs[0].id;
          loadedData = querySnapshot.docs[0].data() as FirestoreResumeData;
          if(loadedData?.resumeId){
            console.info(`[loadInitialCv] Found most recent resume by query: ${loadedData.resumeId}`);
            setCurrentResumeId(loadedData.resumeId); 
          } else {
            console.warn(`[loadInitialCv] Most recent resume by query exists but missing resumeId field. Using doc ID: ${resumeIdToLoad}`);
            setCurrentResumeId(resumeIdToLoad); 
          }
        }
      }

      if (!currentResumeId && !resumeIdToLoad) { 
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
        setCurrentResumeId(newResumeId); 
        updateFormWithData(defaultDraftData); 
      } else if ((currentResumeId || resumeIdToLoad) && loadedData) {
         console.info(`[loadInitialCv] A resumeId is available. Loaded data will be used by onSnapshot listener or here if direct load.`);
         updateFormWithData(loadedData); 
      }
    } catch (error) {
      console.error('[loadInitialCv] Error loading/creating initial CV:', error);
      toast({ title: 'خطأ', description: 'لم نتمكن من تحميل أو إنشاء بيانات السيرة الذاتية.', variant: 'destructive' });
    } finally {
        setIsLoadingCv(false); // Ensure loading is false after initial load attempt
    }
  }, [currentUser, toast, updateFormWithData, currentResumeId]); 


  // Effect to load the initial CV or create a new one if none exists
  useEffect(() => {
    if (currentUser?.uid && !currentResumeId && !isProcessingPdf && isLoadingCv) {
        console.info("[Mount/User Effect] User available, no currentResumeId yet, initial load. Calling loadInitialCv.");
        loadInitialCv(currentUser.uid);
    } else if (!currentUser?.uid) {
        console.info("[Mount/User Effect] No user. Resetting states.");
        setCurrentResumeId(null);
        setCurrentRawResumeData(null);
        form.reset(normalizeResumeData(null, null));
        setIsLoadingCv(false);
        stopProcessingTimer(false);
        processedResumeIdRef.current = null;
    }
  }, [currentUser?.uid, currentResumeId, isProcessingPdf, loadInitialCv, stopProcessingTimer, form, isLoadingCv]);


  // Effect to listen to the current resume document
  useEffect(() => {
    if (!currentUser?.uid || !currentResumeId) {
      console.info(`[Resume Listener] Skipping setup: User UID: ${currentUser?.uid}, Resume ID: ${currentResumeId}`);
      if (!isProcessingPdf && !currentUser?.uid) setIsLoadingCv(false); // Ensure loading is false if no user/resume
      return;
    }

    console.info(`[Resume Listener] Setting up for: users/${currentUser.uid}/resumes/${currentResumeId}.`);
    
    // Set loading true ONLY if we are not already processing a PDF and are about to make a new subscription
    if (!isProcessingPdf) { 
        setIsLoadingCv(true);
    }
    
    const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
    const unsubscribeResume = onSnapshot(resumeDocRef, (docSnap) => {
      console.info(`[Resume Listener] Snapshot received for resume: ${currentResumeId}. Exists: ${docSnap.exists()}`);
      if (docSnap.exists()) {
        const updatedCvData = { resumeId: docSnap.id, ...docSnap.data() } as FirestoreResumeData;
        console.info("[Resume Listener] Raw data from Firestore:", JSON.stringify(updatedCvData).substring(0, 300) + "...");
        
        // Update currentResumeId from the snapshot itself if it's different, ensures consistency
        if (docSnap.id !== currentResumeId) {
            console.warn(`[Resume Listener] Snapshot ID ${docSnap.id} differs from currentResumeId ${currentResumeId}. Updating to snapshot ID.`);
            setCurrentResumeId(docSnap.id); // This could re-trigger this effect, be cautious.
                                          // Better to ensure currentResumeId is stable before this listener runs.
        }
        
        updateFormWithData(updatedCvData); 
        
        if (!isProcessingPdf) { // Only turn off CV loading if not in PDF processing mode
            setIsLoadingCv(false); 
        }

        const currentProcessingStatus = isProcessingPdf;

        if (updatedCvData.parsingDone || updatedCvData.parsingError) {
          const alreadyProcessedThisToast = processedResumeIdRef.current === updatedCvData.resumeId && (updatedCvData.parsingDone || updatedCvData.parsingError);
          
          if (currentProcessingStatus || !alreadyProcessedThisToast) { 
            console.info(`[Resume Listener] Parsing status for ${updatedCvData.resumeId}: done=${updatedCvData.parsingDone}, error=${updatedCvData.parsingError}. Current processing: ${currentProcessingStatus}. Stopping timer.`);
            stopProcessingTimer(!updatedCvData.parsingError); 
            
            if (!alreadyProcessedThisToast) { 
              if (updatedCvData.parsingDone && !updatedCvData.parsingError) {
                toast({ title: "✅ تم استخراج البيانات", description: "تم تحديث النموذج بالبيانات المستخرجة.", variant: "default", duration: 7000 });
              } else if (updatedCvData.parsingError) {
                toast({ title: "❌ تعذّر استخراج البيانات تلقائيًا", description: `(${updatedCvData.parsingError}). الرجاء ملء النموذج يدويًا.`, variant: "destructive", duration: 10000 });
              }
              processedResumeIdRef.current = updatedCvData.resumeId;
            }
          }
        } else if (updatedCvData.storagePath && !updatedCvData.parsingDone && !updatedCvData.parsingError && !currentProcessingStatus && !processingTimerRef.current) { 
          console.info(`[Resume Listener] PDF ${updatedCvData.resumeId} (storage: ${updatedCvData.storagePath}) exists, awaiting parsing. Starting timer.`);
          startProcessingTimer(); 
           if (processedResumeIdRef.current === updatedCvData.resumeId) { 
             processedResumeIdRef.current = null;
          }
        } else if (!updatedCvData.storagePath && currentProcessingStatus) {
            console.info(`[Resume Listener] No storage path for ${updatedCvData.resumeId} but was processing. Stopping timer.`);
            stopProcessingTimer(false);
        }

      } else {
        console.warn(`[Resume Listener] Resume document ${currentResumeId} does not exist for user ${currentUser.uid}. Attempting to load/create initial.`);
        setIsLoadingCv(true); // Set loading as we will attempt to load/create
        stopProcessingTimer(false);
        loadInitialCv(currentUser.uid); // This will attempt to find or create a resume, then the listener will pick it up.
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
      if (processingTimerRef.current) {
        clearInterval(processingTimerRef.current);
        processingTimerRef.current = null;
        console.info("[Resume Listener Cleanup] Cleared processing timer.");
      }
    };
  }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, loadInitialCv]); 

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
          {(isProcessingPdf || (isLoadingCv && statusMessage && !isProcessingPdf && !currentRawResumeData)) && ( 
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
             {(!isLoadingCv || currentRawResumeData || form.formState.isDirty || hasPrintableData) && <CvPreview data={currentFormData} />}
          </section>
          
          <section
            className="w-full lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar print:hidden"
          >
             <FormProvider {...form} key={currentResumeId || 'cv-form-provider'}> 
                 <CvForm
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
