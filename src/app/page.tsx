
'use client';

import * as React from 'react';
import { useState, useCallback, useEffect } from 'react'; // Added useEffect
import { useForm, FormProvider } from 'react-hook-form'; // Import FormProvider
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Loader2, LogOut } from 'lucide-react'; // Added LogOut
import { ProtectedRoute } from '@/components/ProtectedRoute'; // Import ProtectedRoute
import { useAuth } from '@/context/AuthContext'; // Import useAuth
import { db } from '@/lib/firebase/config'; // Import db
import { collection, getDocs, query, where, orderBy, limit, onSnapshot, QuerySnapshot, DocumentData } from 'firebase/firestore'; // Firestore functions, added onSnapshot
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes'; // Use Firestore specific type alias
import { CvForm, normalizeResumeData, cvSchema, type CvFormData } from '@/components/cv-form'; // Import CvForm and related items
import { CvPreview } from '@/components/cv-preview'; // Import CvPreview
import { useToast } from '@/hooks/use-toast'; // Import useToast
import { Form } from '@/components/ui/form'; // Import the Form component

// Main page component managing layout and data fetching
function CvBuilderPageContent() {
  const [isLoadingCv, setIsLoadingCv] = useState(true); // State for loading initial CV
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth(); // Get signOut and currentUser

  // Initialize the form using react-hook-form
  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: normalizeResumeData(null, currentUser), // Start with empty/default normalized data
    mode: 'onChange', // Validate on change for live preview updates
  });

    // Function to handle data population from PDF Uploader (or Firestore listener)
    // Renamed from handlePdfParsingComplete for clarity
    const updateFormWithData = useCallback((parsedData: Partial<FirestoreResumeData> | null, source: 'pdf' | 'firestore') => {
        console.log(`Received data from ${source}:`, parsedData);
        // Pass parsedData (which can be null) to normalizeResumeData
        const normalizedData = normalizeResumeData(parsedData as FirestoreResumeData | null, currentUser);

        // Preserve the current resumeId if the incoming data doesn't have one
        // (e.g., initial load vs. update from PDF parse)
        const currentResumeId = form.getValues('resumeId');
        if (currentResumeId && !normalizedData.resumeId) {
            normalizedData.resumeId = currentResumeId;
            console.log("Preserved existing resumeId:", currentResumeId);
        }
        // Ensure the incoming resumeId (if exists) is used
        // FIX: Check if parsedData is not null before accessing its properties
        else if (parsedData && parsedData.resumeId) {
             normalizedData.resumeId = parsedData.resumeId;
        }


        try {
            // Validate the normalized data before resetting the form
            cvSchema.parse(normalizedData);
            form.reset(normalizedData, { keepDefaultValues: false }); // Update the entire form state
            console.log("Form reset with normalized data:", normalizedData);

             if (source === 'pdf') {
                toast({
                    title: "تم ملء النموذج",
                    description: "تم تحديث النموذج بالبيانات المستخرجة. الرجاء المراجعة والحفظ.",
                });
            } else if (source === 'firestore' && parsedData && parsedData.parsingDone) {
                 // Optional: Toast when data loads from Firestore *after* parsing
                 // Avoid toasting on initial load unless specifically desired
                 // toast({
                 //     title: 'تم تحميل بيانات السيرة الذاتية',
                 //     description: 'تم تحديث النموذج بأحدث البيانات المحفوظة.',
                 // });
            }

        } catch (error) {
            console.error("Error validating normalized data:", error);
            toast({
                title: "خطأ في البيانات",
                description: `حدث خطأ أثناء التحقق من البيانات المستخرجة. ${error instanceof z.ZodError ? error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') : 'قد تحتاج إلى إدخالها يدويًا.'}`,
                variant: "destructive",
            });
        }
    }, [form, currentUser, toast]); // Dependencies for the callback

    // Function to load the most recent CV once
    const loadInitialCv = useCallback(async (userId: string) => {
        setIsLoadingCv(true);
        let loadedCvData: FirestoreResumeData | null = null;
        try {
            const resumesRef = collection(db, 'users', userId, 'resumes');
            const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                loadedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                 console.log("Loaded initial CV data:", loadedCvData);
                 toast({
                     title: 'تم تحميل السيرة الذاتية',
                     description: `تم تحميل "${loadedCvData.title || 'السيرة الذاتية المحفوظة'}".`,
                 });
                 updateFormWithData(loadedCvData, 'firestore'); // Update form with initial data
            } else {
                console.log("No existing CV found, using defaults.");
                // Reset form with defaults if no CV exists
                updateFormWithData(null, 'firestore');
                toast({
                    title: 'سيرة ذاتية جديدة',
                    description: 'ابدأ بملء النموذج أو قم برفع ملف PDF.',
                });
            }
        } catch (error) {
            console.error('Error loading initial CV:', error);
            toast({
                title: 'خطأ',
                description: 'لم نتمكن من تحميل بيانات السيرة الذاتية الأولية.',
                variant: 'destructive',
            });
             updateFormWithData(null, 'firestore'); // Reset form on error
        } finally {
            setIsLoadingCv(false);
        }
    }, [updateFormWithData, toast]); // Dependencies for initial load


   // Effect to load initial CV data only once when currentUser is available
   useEffect(() => {
        if (currentUser?.uid && form.getValues('resumeId') === undefined) { // Load only if no resumeId is set yet
            loadInitialCv(currentUser.uid);
        } else if (!currentUser?.uid) {
            // If user logs out, reset the form to defaults
            updateFormWithData(null, 'firestore');
             setIsLoadingCv(false); // Stop loading if no user
        }
       // We only want this effect to run when the user ID becomes available *initially*
       // or when the user logs out. updateFormWithData is stable.
       // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.uid, loadInitialCv]);


    // Effect to listen for real-time updates (including PDF parsing completion)
    useEffect(() => {
        if (!currentUser?.uid) return; // No user, no listener

        const resumesRef = collection(db, 'users', currentUser.uid, 'resumes');
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));

        // Set up the listener
        const unsubscribe = onSnapshot(q, (querySnapshot: QuerySnapshot<DocumentData>) => {
            console.log("Firestore listener triggered.");
             setIsLoadingCv(true); // Indicate loading during update processing
            if (!querySnapshot.empty) {
                const cvDoc = querySnapshot.docs[0];
                const updatedCvData = { resumeId: cvDoc.id, ...cvDoc.data() } as FirestoreResumeData;
                 console.log("Firestore listener received update:", updatedCvData);

                // Only update the form if the received data is different from the current form state's source ID
                // This prevents unnecessary resets if the update was triggered by the form saving itself
                 const currentFormResumeId = form.getValues('resumeId');
                 if (updatedCvData.resumeId !== currentFormResumeId || updatedCvData.parsingDone) {
                     console.log("Applying update from Firestore listener to form.");
                     updateFormWithData(updatedCvData, 'firestore');

                     // Specific toast for PDF parsing completion
                     // Check parsingDone exists and is true
                     if (updatedCvData.parsingDone === true) {
                         toast({
                             title: "✅ تم استخراج البيانات",
                             description: "تم تحديث النموذج بالبيانات المستخرجة من ملف PDF. يمكنك الآن المراجعة والتعديل.",
                             variant: "default",
                             duration: 5000, // Show longer
                         });
                     }
                 } else {
                    console.log("Firestore update is the same as current form, skipping reset.");
                 }

            } else {
                // Handle case where the last resume might have been deleted
                console.log("Firestore listener: No resumes found.");
                updateFormWithData(null, 'firestore');
            }
             setIsLoadingCv(false);
        }, (error) => {
            console.error("Firestore listener error:", error);
            toast({
                title: 'خطأ في المزامنة',
                description: 'حدث خطأ أثناء الاستماع لتحديثات السيرة الذاتية.',
                variant: 'destructive',
            });
             setIsLoadingCv(false);
        });

        // Cleanup function to unsubscribe the listener when the component unmounts or user changes
        return () => {
            console.log("Unsubscribing Firestore listener.");
            unsubscribe();
        };
        // Rerun listener if user changes or the update function ref changes (should be stable)
    }, [currentUser?.uid, toast, updateFormWithData, form]); // Add form to dependencies


   // Get current form data for the preview component
   const currentFormData = form.watch();

  return (
     // Main container with flex layout
    <div className="flex flex-col h-screen bg-muted/40">
         {/* Header Section */}
        <header className="flex h-[60px] items-center justify-between border-b bg-background px-6 py-2 shrink-0">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold text-primary">صانع السيرة الذاتية العربي</h1>
                {/* You can add a logo here if needed */}
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

        {/* Main Content Area (Flex row with RTL reverse on lg+, column-reverse on smaller) */}
        <main className="flex-1 flex flex-col-reverse lg:flex-row lg:rtl:flex-row-reverse gap-4 p-4 overflow-hidden">

            {/* Left Pane (Preview) - Takes remaining space */}
            {/* Force LTR direction for the preview content itself */}
            <section
                className="flex-1 bg-white rounded-lg shadow-md overflow-auto hide-scrollbar"
                dir="ltr"
            >
                {/* Pass form data to the preview component */}
                <CvPreview data={currentFormData} />
            </section>

            {/* Right Pane (Form) - Fixed width on lg+, full width on smaller */}
            <section
                className="w-full min-w-0 lg:w-[35%] lg:min-w-[340px] bg-white rounded-lg shadow-md overflow-y-auto hide-scrollbar"
                // No specific padding here, handled by CvForm's internal padding
            >
                 {/* Wrap CvForm in the FormProvider */}
                 <Form {...form}>
                     <CvForm
                         isLoadingCv={isLoadingCv}
                         // Pass the unified update function, PDF uploader calls it with source 'pdf'
                         handlePdfParsingComplete={(data) => updateFormWithData(data, 'pdf')}
                      />
                 </Form>
            </section>
        </main>
    </div>
  );
}

// Wrap the main content with ProtectedRoute
export default function Home() {
  return (
    <ProtectedRoute>
      <CvBuilderPageContent />
    </ProtectedRoute>
  );
}

