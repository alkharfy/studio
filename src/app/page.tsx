// src/app/page.tsx
'use client';

import * as React from 'react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form'; // RHF import
import { zodResolver } from '@hookform/resolvers/zod';
// import type { z as Zod } from 'zod'; // aliased z to Zod to avoid conflict if z is used as a variable
import { Button } from '@/components/ui/button';
import { Loader2, LogOut, Download } from 'lucide-react'; // Added Download icon
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/AuthContext';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, where, orderBy, limit, onSnapshot, type DocumentData, doc, type QuerySnapshot, setDoc, updateDoc, serverTimestamp as firestoreServerTimestamp } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form';
import { CvPreview } from '@/components/cv-preview';
import { useToast } from '@/hooks/use-toast';
import { Form } from '@/components/ui/form'; // Import the Form component from ShadCN
import { Progress } from '@/components/ui/progress'; // Import Progress component


// Main page component managing layout and data fetching
function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); // For initial load or when switching resumes
  const [isProcessingPdf, setIsProcessingPdf] = useState(false); // True when PDF is uploaded and backend is processing
  const [processingProgress, setProcessingProgress] = useState(0); // Progress for the UI timer
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth();
  const processedResumeIdRef = useRef<string | null>(null); // Tracks the ID of the resume that has been processed by AI
  const [currentResumeId, setCurrentResumeId] = useState<string | null>(null); // The ID of the resume being actively listened to
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null); // Ref for the processing timer interval

  // Initialize React Hook Form
  const form = useForm<CvFormData>({ // Pass the Zod schema for validation
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser), // Initialize with default or user-specific values
    mode: 'onChange', // Validate on change for better UX
  });

    // Callback to update the form with new data (from Firestore or initial load)
    const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null) => {
        console.info(`[updateFormWithData] Data Received:`, parsedData); // Log incoming data
        const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);
        console.info("[updateFormWithData] Normalized Data:", normalizedData);

        try {
            // Validate normalized data against schema before resetting form
            // This helps catch issues if Firestore data doesn't match form expectations
            cvSchema.parse(normalizedData);
            form.reset(normalizedData, { keepDefaultValues: false }); // Update the entire form state
            console.info("[updateFormWithData] Form reset successful.");
        } catch (error: any) { // Explicitly type error
            console.error("[updateFormWithData] Error resetting form:", error);
            // If Zod validation fails, log the specific errors
             if (error.name === 'ZodError') { // Check if it's a ZodError
               console.warn("[updateFormWithData] Zod validation failed on normalized data:", error.errors);
               // Optionally, show a less technical toast to the user if this happens often
               // toast({ title: "خطأ في البيانات", description: "تعذر تحديث النموذج ببيانات غير متوافقة.", variant: "destructive" });
             } else {
                toast({
                    title: "خطأ في تحديث النموذج",
                    description: `حدث خطأ أثناء تحديث بيانات النموذج.`,
                    variant: "destructive",
                });
             }
            // If form update fails, ensure any processing state is cleared
            setIsProcessingPdf(false);
            if (processingTimerRef.current) clearInterval(processingTimerRef.current);
             setProcessingProgress(0);
        }
    }, [form, currentUser, toast]);

    // Function to start a simulated progress timer for PDF processing
    const startProcessingTimer = useCallback(() => {
        setIsProcessingPdf(true);
        setProcessingProgress(0);

        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current); // Clear any existing timer
        }

        const totalDuration = 30000; // 30 seconds for simulation
        const intervalTime = 100; // Update every 100ms
        const steps = totalDuration / intervalTime;
        const increment = 100 / steps; // Progress increment per step

        processingTimerRef.current = setInterval(() => {
            setProcessingProgress((prevProgress) => {
                const newProgress = prevProgress + increment;
                if (newProgress >= 100) {
                    if (processingTimerRef.current) clearInterval(processingTimerRef.current);
                    processingTimerRef.current = null; // Clear ref after finishing
                    return 100;
                }
                return newProgress;
            });
        }, intervalTime);
    }, []);

    // Function to stop the progress timer and reset processing state
    const stopProcessingTimer = useCallback(() => {
        if (processingTimerRef.current) {
            clearInterval(processingTimerRef.current);
            processingTimerRef.current = null; // Clear ref
        }
        setIsProcessingPdf(false);
        setProcessingProgress(0); // Reset progress
    }, []);


    // Effect to load the initial CV data when the component mounts or user changes
    // This now primarily sets up the listener for `latestResumeId` on the user document.
    const loadInitialCv = useCallback(async (userId: string) => {
        console.info("[loadInitialCv] Loading initial CV for user:", userId);
        setIsLoadingCv(true);
        stopProcessingTimer(); // Ensure no old timers are running
        processedResumeIdRef.current = null; // Reset processed ID tracker
        let loadedCvData: FirestoreResumeData | null = null;
        try {
            // Fetch the most recently updated resume as a fallback or initial state
            const resumesRef = collection(db, 'users', userId, 'resumes');
            const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                loadedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                 console.info("[loadInitialCv] Loaded initial CV data:", loadedCvData);
                 updateFormWithData(loadedCvData); // Populate form with this data
                 
                 // Set currentResumeId from the loaded data if not already set by userDoc listener
                 if (!currentResumeId) {
                    setCurrentResumeId(loadedCvData.resumeId);
                 }
                 
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
                console.info("[loadInitialCv] No existing CV found, creating a new draft.");
                // Create a new empty resume document for the user
                const newResumeRef = doc(collection(db, 'users', userId, 'resumes'));
                const newResumeId = newResumeRef.id;
                const defaultDraftData: FirestoreResumeData = {
                    resumeId: newResumeId,
                    userId: userId,
                    title: 'مسودة السيرة الذاتية',
                    personalInfo: {
                        fullName: currentUser?.displayName || '',
                        email: currentUser?.email || '',
                        jobTitle: '',
                        phone: '',
                        address: '',
                    },
                    summary: '',
                    education: [],
                    experience: [],
                    skills: [],
                    languages: [],
                    hobbies: [],
                    customSections: [],
                    parsingDone: true, // It's a manual draft, so parsing is "done"
                    parsingError: null,
                    storagePath: null,
                    originalFileName: null,
                    createdAt: firestoreServerTimestamp(),
                    updatedAt: firestoreServerTimestamp(),
                };
                await setDoc(newResumeRef, defaultDraftData);
                // Update user document with this new latestResumeId
                await updateDoc(doc(db, 'users', userId), { latestResumeId: newResumeId, updatedAt: firestoreServerTimestamp() });
                
                updateFormWithData(defaultDraftData);
                setCurrentResumeId(newResumeId); // Set this as the current resume
                processedResumeIdRef.current = newResumeId; // It's "processed" as it's a new draft
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
    }, [updateFormWithData, toast, stopProcessingTimer, currentUser, currentResumeId]);


    // Effect to listen for changes to `latestResumeId` on the user's document
    useEffect(() => {
        if (!currentUser?.uid) {
            console.info("[User Listener] No user, skipping listener setup.");
            setCurrentResumeId(null); 
            return () => {};
        }

        console.info(`[User Listener] Setting up Firestore listener for user document: users/${currentUser.uid}`);
        const userDocRef = doc(db, "users", currentUser.uid);

       const unsubscribe = onSnapshot(userDocRef, (docSnap: DocumentData) => {
            const latestId = docSnap.data()?.latestResumeId || null;
            console.info("[User Listener] latestResumeId updated to:", latestId);
             if (latestId && latestId !== currentResumeId) { // Only update if different
                setCurrentResumeId(latestId);
             } else if (!latestId && !currentResumeId) {
                // If no latestId on user doc and no currentResumeId already set by other means,
                // trigger loadInitialCv to fetch/create one.
                loadInitialCv(currentUser.uid);
             }
        }, (error) => {
             console.error("[User Listener] Error:", error);
             toast({ title: "خطأ في مزامنة المستخدم", description: "تعذر تحديث بيانات المستخدم.", variant: "destructive"});
        });
        return unsubscribe; 
    }, [currentUser?.uid, loadInitialCv, currentResumeId, toast]); // Added currentResumeId and toast to dependencies

   // Effect to handle initial load or when user logs out
   useEffect(() => {
        if (currentUser?.uid && !currentResumeId) { 
            loadInitialCv(currentUser.uid);
        } else if (!currentUser?.uid) {
             console.info("[Effect] User logged out or not present, resetting form and stopping timers.");
             updateFormWithData(null); 
             setIsLoadingCv(false); 
             stopProcessingTimer(); 
             processedResumeIdRef.current = null; 
             setCurrentResumeId(null); // Clear current resume ID on logout
        }
    }, [currentUser?.uid, currentResumeId, updateFormWithData, loadInitialCv, stopProcessingTimer]);

    // Main effect to listen to the specific resume document (`currentResumeId`)
    useEffect(() => {
        if (!currentUser?.uid || !currentResumeId) {
           console.info("[Listener Effect] No user or currentResumeId, skipping listener setup.", { userId: currentUser?.uid, currentResumeId });
            if (!isLoadingCv && !currentResumeId && currentUser?.uid) {
                // This means user is loaded, not loading CV, but no resume ID is set.
                // Potentially call loadInitialCv here if it's confirmed no resume is being targeted.
                console.info("[Listener Effect] Triggering loadInitialCv due to missing currentResumeId while user is present.");
                // loadInitialCv(currentUser.uid); // Be cautious with this to avoid loops
            }
           return () => { };
        }

        const resumeDocRef = doc(db, 'users', currentUser.uid, 'resumes', currentResumeId);
        console.info(`[Listener Effect] Setting up Firestore listener for document: users/${currentUser.uid}/resumes/${currentResumeId}`);

        setIsLoadingCv(true); // Set loading true when listener starts for a new resumeId

        const unsubscribe = onSnapshot(resumeDocRef, (docSnap: DocumentData) => { 
            setIsLoadingCv(false); // Set loading false once data (or lack thereof) is received
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
                 else if (shouldUpdateForm && !isLoadingCv && !updatedCvData.parsingDone && !updatedCvData.parsingError && updatedCvData.storagePath) {
                    console.info("[Listener Effect] Inferring PDF processing state for resume ID:", updatedCvData.resumeId);
                     if (!isProcessingPdf) { 
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
                   // If the non-existent doc was the one in form, try to load initial/default
                   // This could happen if the resume was deleted elsewhere.
                   loadInitialCv(currentUser.uid);
                }
                 stopProcessingTimer();
                 processedResumeIdRef.current = null;
            }
        }, (error) => { 
           console.error(`[Listener Effect] Firestore listener error for ${currentResumeId}:`, error);
           setIsLoadingCv(false); // Ensure loading is false on error
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
   }, [currentUser?.uid, currentResumeId, toast, updateFormWithData, startProcessingTimer, stopProcessingTimer, isProcessingPdf, form, isLoadingCv, loadInitialCv]);


   const currentFormData = form.watch(); 

    let statusMessage = '';
    if (isLoadingCv) {
        statusMessage = "جاري تحميل البيانات...";
    } else if (isProcessingPdf) {
        statusMessage = "جاري استخراج البيانات...";
    }

    const handleDownloadCv = () => {
      // This will open the browser's print dialog, allowing the user to save as PDF.
      // Ensure print styles in globals.css are adequate for a good PDF output.
      window.print();
    };


  return (
    <div className="flex flex-col h-screen bg-muted/40 print:bg-white">
        {/* Header Section - hidden on print */}
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

        {/* Main content area: Two-column layout for CV Preview and Form */}
         <main className="flex-1 flex flex-col lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden print:p-0 print:overflow-visible print:block"> {/* Added overflow-hidden */}

            {/* Left Section (CV Preview) - Takes up more space on lg screens */}
            <section
                id="cv-preview-section" // Added ID for potential print styling
                className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar print:shadow-none print:rounded-none print:border-none" 
                dir="ltr" 
            >
                <CvPreview data={currentFormData} />
            </section>

            {/* Right Section (CV Form) - Fixed width on lg screens, hidden on print */}
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

// Exported Home component that wraps CvBuilderPageContent with ProtectedRoute
export default function Home() {
  return (
    <ProtectedRoute>
      <CvBuilderPageContent />
    </ProtectedRoute>
  );
}
