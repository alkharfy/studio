
'use client';

import * as React from 'react';
import { useState } from 'react';
import { ref, uploadBytesResumable, getDownloadURL, type StorageError } from 'firebase/storage';
// Removed Firestore imports (setDoc, serverTimestamp) as the client no longer simulates writing
// import { doc, setDoc, serverTimestamp, collection, Timestamp } from 'firebase/firestore';
import { useAuth } from '@/context/AuthContext';
import { storage, db } from '@/lib/firebase/config'; // Keep db import for potential future listener implementation
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Upload, FileText, Check, X } from 'lucide-react';
import type { Resume } from '@/lib/dbTypes'; // Import Resume type
import { Label } from "@/components/ui/label"; // Import Label component

// Define the expected structure of parsed data (adjust based on actual AI output)
// This should match the structure written by the Cloud Function
// Note: Timestamps are handled by the function/Firestore itself.
type ParsedResumeData = Omit<Resume, 'createdAt' | 'updatedAt' | 'parsingDone' | 'originalFileName' | 'storagePath'> & {
    // These optional fields might be added by the function/parsing process
    parsingDone?: boolean;
    originalFileName?: string;
    storagePath?: string;
     // We still expect the core fields to be potentially populated
    resumeId?: string;
    userId?: string;
    title?: string;
    personalInfo?: Resume['personalInfo'];
    summary?: Resume['summary']; // Changed from 'objective'
    education?: Resume['education'];
    experience?: Resume['experience'];
    skills?: Resume['skills'];
    languages?: Resume['languages']; // Was array of objects {name, level}? Now string array based on func
    hobbies?: Resume['hobbies']; // Was array of objects {name}? Now string array
    customSections?: Resume['customSections'];
};


interface PdfUploaderProps {
  // Removed onParsingComplete prop
}

const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export function PdfUploader({ /* Removed onParsingComplete prop */ }: PdfUploaderProps) {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

   // Determine mock flag only by URL query ?mock=1
    const useMock = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get("mock") === "1" : false;

   if (useMock && typeof window !== 'undefined') {
        console.warn("PdfUploader is running in MOCK mode because '?mock=1' is present in the URL.");
    }


  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null); // Clear previous errors
    const file = event.target.files?.[0];
    if (file) {
      if (file.type !== 'application/pdf') {
        setError('الرجاء اختيار ملف PDF فقط.');
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = ''; // Reset input
        return;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError(`حجم الملف يتجاوز الحد الأقصى (${MAX_FILE_SIZE_MB} ميجابايت).`);
        setSelectedFile(null);
         if (fileInputRef.current) fileInputRef.current.value = ''; // Reset input
        return;
      }
      setSelectedFile(file);
    } else {
       setSelectedFile(null);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile || !currentUser) {
        setError('الرجاء اختيار ملف أولاً أو تسجيل الدخول.');
        return;
    }

    setIsUploading(true);
    setError(null);
    setUploadProgress(0);

    // --- MOCK UPLOAD & PARSING (for testing without Firebase Function) ---
    if (useMock) {
         console.log("--- MOCK UPLOAD & PARSE ---");
         // Simulate upload progress
         let mockProgress = 0;
         const interval = setInterval(() => {
             mockProgress += 10;
             setUploadProgress(mockProgress);
             if (mockProgress >= 100) {
                 clearInterval(interval);
                 setIsUploading(false);
                 toast({
                     title: 'محاكاة الرفع ناجحة',
                     description: 'محاكاة استخراج البيانات بدأت...',
                     variant: 'default',
                 });
                 // Simulate parsing delay and return mock data
                 setTimeout(() => {
                      const mockParsedData: ParsedResumeData = {
                        resumeId: `mock_${Date.now()}`,
                        userId: currentUser.uid,
                        title: `تجريبي - ${selectedFile.name}`,
                        personalInfo: {
                            fullName: "اسم تجريبي",
                            jobTitle: "وظيفة تجريبية",
                            email: "mock@example.com",
                            phone: "123-456-7890",
                            address: "عنوان تجريبي، مدينة تجريبية",
                        },
                        summary: "ملخص تجريبي: مطور برامج متحمس يتمتع بخبرة في ...",
                        education: [{ degree: "بكالوريوس علوم الحاسب (تجريبي)", institution: "جامعة تجريبية", graduationYear: "2023", details: "مشروع تخرج عن..." }],
                        experience: [{ jobTitle: "مطور مبتدئ (تجريبي)", company: "شركة تجريبية", startDate: "يناير 2024", endDate: "الحاضر", description: "وصف تجريبي للمهام والمسؤوليات." }],
                        skills: [{ name: "مهارة تجريبية 1" }, { name: "مهارة تجريبية 2" }],
                        languages: [{ name: "لغة تجريبية", level: "مستوى تجريبي" }], // Example languages
                        hobbies: ["هواية تجريبية 1", "هواية تجريبية 2"], // Example hobbies
                        customSections: [{ title: "قسم تجريبي", content: "محتوى تجريبي" }], // Example custom section
                        // Metadata fields that would be set by the real function:
                         parsingDone: true,
                         originalFileName: selectedFile.name,
                         storagePath: `mock_uploads/${currentUser.uid}/${selectedFile.name}`,
                     };
                     console.log("--- MOCK PARSE COMPLETE ---", mockParsedData);
                     // Call the handler (which is now removed from props, so this won't do anything)
                     // onParsingComplete(mockParsedData);
                     // Instead, we might need a different way to signal mock completion if the UI needs it directly
                      toast({
                         title: '✅ محاكاة الاستخراج تمت',
                         description: 'تم ملء النموذج ببيانات تجريبية.',
                         variant: 'default',
                     });
                      // Reset state after mock
                      setSelectedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                      setTimeout(() => setUploadProgress(0), 1000);
                 }, 3000); // Simulate 3 seconds parsing time
             }
         }, 200); // Simulate progress update every 200ms
         return; // Exit early for mock flow
     }
    // --- END MOCK UPLOAD ---


    // --- REAL UPLOAD FLOW ---
    const fileName = `${Date.now()}_${selectedFile.name}`;
    // Ensure metadata includes the UID for the Cloud Function
    const metadata = {
      customMetadata: {
        'uid': currentUser.uid // Set the UID in metadata
      }
    };
    const storagePath = `resumes_uploads/${currentUser.uid}/${fileName}`;
    const storageRef = ref(storage, storagePath);

    // Pass metadata during upload
    const uploadTask = uploadBytesResumable(storageRef, selectedFile, metadata);

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        setUploadProgress(progress);
      },
      (uploadError: StorageError) => {
        console.error('Upload Error:', uploadError);
        // Handle specific errors if needed (e.g., permissions)
         let message = 'حدث خطأ أثناء رفع الملف.';
         if (uploadError.code === 'storage/unauthorized') {
            message = 'ليس لديك إذن لرفع الملفات.';
         } else if (uploadError.code === 'storage/canceled') {
            message = 'تم إلغاء عملية الرفع.';
         }
        setError(message);
         toast({
          title: 'خطأ في الرفع',
          description: message,
          variant: 'destructive',
        });
        setIsUploading(false);
        setUploadProgress(0);
        setSelectedFile(null); // Clear selection on error
        if (fileInputRef.current) fileInputRef.current.value = '';
      },
      async () => {
        // Upload completed successfully
        setIsUploading(false);
        setUploadProgress(100);
        toast({
          title: 'اكتمل الرفع بنجاح',
          description: 'بدأت معالجة ملف السيرة الذاتية في الخلفية. سيتم تحديث النموذج عند الانتهاء.',
           variant: 'default', // Use default variant for success info
        });

        try {
          // **REAL FLOW:** The Cloud Function `parseResumePdf` is now responsible
          // for processing the uploaded file via Document AI/Vertex AI and writing
          // the result to Firestore: `users/{uid}/resumes/{newResumeId}`.

          // The parent component (page.tsx) will listen for the new/updated document
          // in Firestore via the onSnapshot listener and update the form.

          // Optional: Get download URL for debugging, but not essential for the flow
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          console.log('File uploaded successfully. Available at (for debug):', downloadURL);
          console.log(`Cloud Function 'parseResumePdf' should trigger for path: ${storagePath}`);


        } catch (processError: any) {
           // This catch block might now catch errors from getDownloadURL if that fails
           console.error('Error after upload (e.g., getting download URL):', processError);
           setError('حدث خطأ بعد اكتمال الرفع.');
           toast({
             title: 'خطأ بعد الرفع',
             description: 'حدث خطأ غير متوقع بعد اكتمال رفع الملف.',
             variant: 'destructive',
           });
        } finally {
            // Clear the selected file immediately after the success toast.
             setSelectedFile(null);
             if (fileInputRef.current) fileInputRef.current.value = '';
             // Reset progress after a short delay to show 100% briefly
             setTimeout(() => setUploadProgress(0), 1000);
        }
      }
    );
  };

  const handleCancelUpload = () => {
    // TODO: Implement cancellation logic if needed (using uploadTask.cancel())
    console.log("Cancellation not implemented yet.");
  };

  //isLoading only depends on upload state now
  const isLoading = isUploading;

  return (
    <Card>
      <CardHeader>
        <CardTitle>رفع واستخراج سيرة ذاتية (PDF)</CardTitle>
        <CardDescription>
            قم برفع ملف سيرتك الذاتية بصيغة PDF (بحد أقصى {MAX_FILE_SIZE_MB} ميجابايت)، وسيقوم النظام بمحاولة استخراج البيانات تلقائيًا لملء النموذج في الخلفية.
            {useMock && <span className="text-destructive font-bold block"> (وضع المحاكاة مفعل: ?mock=1)</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col sm:flex-row items-center gap-4">
           <div className="flex-grow w-full">
             <Label htmlFor="pdf-upload" className="sr-only">اختيار ملف PDF</Label>
             <Input
                id="pdf-upload"
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                onChange={handleFileChange}
                disabled={isLoading}
                className="file:ml-4 file:bg-primary file:text-primary-foreground file:hover:bg-primary/90 file:rounded file:p-2 file:border-0 file:cursor-pointer cursor-pointer"
             />
           </div>

           <Button
              onClick={handleUpload}
              disabled={!selectedFile || isLoading}
              className="w-full sm:w-auto bg-accent hover:bg-accent/90 text-accent-foreground"
            >
              {isUploading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Upload className="ml-2 h-4 w-4" />}
              {isUploading ? 'جاري الرفع...' : 'رفع الملف'}
            </Button>
            {/* Optional: Add cancel button
             {isUploading && (
                <Button variant="outline" size="icon" onClick={handleCancelUpload}>
                    <X className="h-4 w-4" />
                </Button>
             )}
            */}
        </div>

        {/* Show selected file info */}
        {selectedFile && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                <span>الملف المختار: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)</span>
                {/* Show check only when upload hits 100% */}
                {uploadProgress === 100 && <Check className="h-4 w-4 text-green-600" />}
            </div>
        )}


        {isUploading && (
          <div className="space-y-2">
            <Label>تقدم الرفع:</Label>
            <Progress value={uploadProgress} className="w-full" />
            <p className="text-sm text-muted-foreground text-center">{Math.round(uploadProgress)}%</p>
          </div>
        )}


        {error && (
          <div className="text-destructive text-sm flex items-center gap-2 pt-2">
            <X className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}

      </CardContent>
    </Card>
  );
}
