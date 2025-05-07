'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form'; 
import { zodResolver } from '@hookform/resolvers/zod';
import type { z as Zod } from 'zod'; // aliased z to Zod to avoid conflict if z is used as a variable
import { Button } from '@/components/ui/button';
import { Loader2, LogOut } from 'lucide-react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/AuthContext';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, where, orderBy, limit, onSnapshot, type DocumentData, doc, type QuerySnapshot } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form';
import { CvPreview } from '@/components/cv-preview';
import { useToast } from '@/hooks/use-toast';
import { Form } from '@/components/ui/form'; 
import { Progress } from '@/components/ui/progress'; 


// Main page component managing layout and data fetching
function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); 
  const [isProcessingPdf, setIsProcessingPdf] = useState(false); 
  const [processingProgress, setProcessingProgress] = useState(0); 
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth();
  const processedResumeIdRef = useRef<string | null>(null); 
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null); 
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
            
            cvSchema.parse(normalizedData);
            form.reset(normalizedData, { keepDefaultValues: false }); 
            console.info("[updateFormWithData] Form reset successful.");
        } catch (error: any) { // Explicitly type error
            console.error("[updateFormWithData] Error resetting form:", error);
            
             if (error.name === 'ZodError') { 
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
                     console.info("[loadInitialCv] Initial CV might still be processing, listener will confirm or start timer.");
                     
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
        if (!currentUser?.uid) {
            console.info("[User Listener] No user, skipping listener setup.");
            setCurrentResumeId(null); 
            return () => { /* No-op cleanup */ };
        }

        console.info(`[User Listener] Setting up Firestore listener for user document: users/${currentUser.uid}`);
        const userDocRef = doc(db, "users", currentUser.uid);

       const unsubscribe = onSnapshot(userDocRef, (docSnap: DocumentData) => {
            const latestId = docSnap.data()?.latestResumeId || null;
            console.info("[User Listener] latestResumeId updated to:", latestId);
            setCurrentResumeId(latestId); 
        });
        return unsubscribe; 
    }, [currentUser?.uid]); 

   useEffect(() => {
        if (currentUser?.uid && currentResumeId === null) { 
            
        } else if (!currentUser?.uid) {
             
             console.info("[Effect] User logged out or not present, resetting form and stopping timers.");
             updateFormWithData(null); 
             setIsLoadingCv(false); 
             stopProcessingTimer(); 
             processedResumeIdRef.current = null; 
        } else if (currentUser?.uid && currentResumeId) {
            // If there's a user and a specific resume ID to load (either from latestResumeId or direct navigation)
            // This will be handled by the main listener effect below.
            // We no longer call loadInitialCv directly from here, to avoid race conditions with the listener.
        }
    }, [currentUser?.uid, currentResumeId, updateFormWithData, stopProcessingTimer]);

    
    useEffect(() => {
       
        if (!currentUser?.uid || !currentResumeId) {
           console.info("[Listener Effect] No user or currentResumeId, skipping listener setup.");
             return () => { /* No-op cleanup */ };
        }

        
        const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);

        console.info(`[Listener Effect] Setting up Firestore listener for document: users/${currentUser.uid}/resumes/${currentResumeId}`);

        const unsubscribe = onSnapshot(resumeDocRef, (docSnap: DocumentData) => { 
            const currentResumeIdInForm = form.getValues('resumeId');

            if (docSnap.exists()) { 
                const cvDoc = docSnap; 
                const updatedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;

                 console.info("[Listener Effect] Received update for ID:", updatedCvData.resumeId, " | Current form ID:", currentResumeIdInForm);
                 console.info("[Listener Effect] Update data:", updatedCvData); 
                
                const shouldUpdateForm = updatedCvData.resumeId === currentResumeIdInForm || !currentResumeIdInForm || updatedCvData.resumeId === currentResumeId;

                if (shouldUpdateForm) {
                    updateFormWithData(updatedCvData);
                }

                 
                 const isNewlyProcessedOrErrored = processedResumeIdRef.current !== updatedCvData.resumeId;

                 if (updatedCvData.parsingDone && !updatedCvData.parsingError && isNewlyProcessedOrErrored) {
                    console.info("[Listener Effect] Detected completed parsing for new/updated resume ID:", updatedCvData.resumeId);
                    stopProcessingTimer(); 
                     toast({
                         title: "✅ تم استخراج البيانات",
                         description: "تم تحديث النموذج بالبيانات المستخرجة من ملف PDF. يمكنك الآن المراجعة والتعديل.",
                         variant: "default", 
                         duration: 7000,
                     });
                    processedResumeIdRef.current = updatedCvData.resumeId; 
                 }
                  else if (updatedCvData.parsingError && isNewlyProcessedOrErrored) {
                     console.info("[Listener Effect] Detected parsing error for new/updated resume ID:", updatedCvData.resumeId);
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
                         if (isNewlyProcessedOrErrored) { 
                             processedResumeIdRef.current = null;
                         }
                     }
                 }
                 
                 else if (shouldUpdateForm && isProcessingPdf && (updatedCvData.parsingDone || updatedCvData.parsingError)) {
                     
                     
                     console.info("[Listener Effect] Processing finished for resume ID:", updatedCvData.resumeId);
                     stopProcessingTimer();
                 } else if (shouldUpdateForm && !isProcessingPdf) {
                      
                      console.info("[Listener Effect] Regular update or already processed state for resume ID:", updatedCvData.resumeId);
                      stopProcessingTimer(); 
                 }


            } else {
                
                console.info(`[Listener Effect] Document users/${currentUser.uid}/resumes/${currentResumeId} does not exist.`);
                
                if (currentResumeId === currentResumeIdInForm || !currentResumeIdInForm) {
                    updateFormWithData(null);
                }
                 stopProcessingTimer();
                 processedResumeIdRef.current = null;
            }
        }, (error) => { 
           console.error(`[Listener Effect] Firestore listener error for ${currentResumeId}:`, error);
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
   }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, form, isLoadingCv]);


   
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
