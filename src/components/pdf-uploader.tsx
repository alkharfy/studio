
'use client';

import * as React from 'react';
import { useState } from 'react';
import { ref, uploadBytesResumable, getDownloadURL, type StorageError } from 'firebase/storage';
import { doc, setDoc, serverTimestamp, collection } from 'firebase/firestore'; // Firestore imports
import { useAuth } from '@/context/AuthContext';
import { storage, db } from '@/lib/firebase/config'; // Import storage and db
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Upload, FileText, Check, X } from 'lucide-react';
import type { Resume } from '@/lib/dbTypes'; // Import Resume type
import { Label } from "@/components/ui/label"; // Import Label component

// Define the expected structure of parsed data (adjust based on actual AI output)
// This is just an example placeholder
type ParsedResumeData = Partial<Resume>;

interface PdfUploaderProps {
  onParsingComplete: (parsedData: ParsedResumeData) => void;
}

const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export function PdfUploader({ onParsingComplete }: PdfUploaderProps) {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false); // Simulates backend processing
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

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
    setIsProcessing(false); // Reset processing state

    const fileName = `${Date.now()}_${selectedFile.name}`;
    const storagePath = `resumes_uploads/${currentUser.uid}/${fileName}`;
    const storageRef = ref(storage, storagePath);

    const uploadTask = uploadBytesResumable(storageRef, selectedFile);

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
          title: 'اكتمل الرفع',
          description: 'جاري معالجة ملف السيرة الذاتية...',
        });
        setIsProcessing(true); // Start simulating processing

        try {
          // **IMPORTANT SIMULATION:** In a real app, a Cloud Function would trigger on this upload.
          // The function would perform Document AI/Vertex AI processing and write the results
          // to Firestore (e.g., users/{uid}/resumes/{newResumeId}).
          // The frontend would then listen to that Firestore document for the 'parsingDone' flag.

          // **SIMULATION LOGIC START**
          // 1. Get download URL (optional, function usually works directly with storage object)
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          console.log('File available at', downloadURL); // For debugging

          // 2. Simulate AI processing delay
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

          // 3. Simulate creating the Firestore document that the function *would* create
          const resumesCollectionRef = collection(db, 'users', currentUser.uid, 'resumes');
          const newResumeRef = doc(resumesCollectionRef); // Auto-generate ID
          const newResumeId = newResumeRef.id;

          // Example Parsed Data (Replace with actual expected structure from AI)
          const simulatedParsedData: ParsedResumeData = {
            resumeId: newResumeId,
            userId: currentUser.uid,
            title: `مسودة مستخرجة من ${selectedFile.name}`,
            personalInfo: {
              fullName: 'تجربة الاسم الكامل',
              jobTitle: 'تجربة المسمى الوظيفي',
              email: currentUser.email || 'email@example.com',
              phone: '123-456-7890',
              address: 'تجربة العنوان',
            },
            summary: 'هذا ملخص تم استخراجه بواسطة المحاكاة. يجب أن يأتي هذا النص من الذكاء الاصطناعي.',
            experience: [
              { jobTitle: 'مطور محاكاة', company: 'شركة وهمية', startDate: '2022', endDate: 'الحاضر', description: 'وصف محاكاة للخبرة.' }
            ],
            education: [
                { degree: 'شهادة محاكاة', institution: 'جامعة وهمية', graduationYear: '2020', details: 'تفاصيل محاكاة للتعليم.' }
            ],
            skills: [ { name: 'محاكاة' }, { name: 'استخراج بيانات' }, { name: 'ذكاء اصطناعي (وهمي)' } ],
            // languages: ['العربية (محاكاة)'], // Add other fields as needed
            // hobbies: [],
            // customSections: [],
            createdAt: serverTimestamp() as any, // Use serverTimestamp
            updatedAt: serverTimestamp() as any,
            // Add a flag to indicate parsing is done (the listener would look for this)
            parsingDone: true, // Hypothetical flag set by the Cloud Function
            originalFileName: selectedFile.name, // Store original file name
            storagePath: storagePath, // Store the path for reference
          };

          // Write the simulated data to Firestore
          await setDoc(newResumeRef, simulatedParsedData);


          // **SIMULATION LOGIC END**

          // Notify parent component (this would normally happen via Firestore listener)
          onParsingComplete(simulatedParsedData); // Pass the simulated data

          toast({
            title: 'نجاح',
            description: '✅ تم استخراج البيانات، يمكنك المراجعة والتعديل.',
            variant: 'default', // Use default variant for success
          });

        } catch (processError: any) {
           console.error('Simulated Processing Error:', processError);
           setError('❌ تعذّر استخراج البيانات، حاول ملفًا أوضح.');
           toast({
             title: 'خطأ في المعالجة',
             description: '❌ تعذّر استخراج البيانات، حاول ملفًا أوضح.',
             variant: 'destructive',
           });
        } finally {
            setIsProcessing(false);
            setSelectedFile(null); // Clear selection after processing attempt
             if (fileInputRef.current) fileInputRef.current.value = '';
        }
      }
    );
  };

  const handleCancelUpload = () => {
    // TODO: Implement cancellation logic if needed (using uploadTask.cancel())
    console.log("Cancellation not implemented yet.");
  };

  const isLoading = isUploading || isProcessing;

  return (
    <Card>
      <CardHeader>
        <CardTitle>رفع واستخراج سيرة ذاتية (PDF)</CardTitle>
        <CardDescription>
            قم برفع ملف سيرتك الذاتية بصيغة PDF (بحد أقصى {MAX_FILE_SIZE_MB} ميجابايت)، وسنقوم بمحاولة استخراج البيانات تلقائيًا لملء النموذج.
            <br />
            <strong className='text-destructive'>ملاحظة:</strong> المعالجة بالذكاء الاصطناعي محاكاة حاليًا. سيتم ملء النموذج ببيانات تجريبية.
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
              {isUploading ? 'جاري الرفع...' : (isProcessing ? 'جاري المعالجة...' : 'رفع واستخراج')}
            </Button>
            {/* Optional: Add cancel button
             {isUploading && (
                <Button variant="outline" size="icon" onClick={handleCancelUpload}>
                    <X className="h-4 w-4" />
                </Button>
             )}
            */}
        </div>

        {selectedFile && !isUploading && !isProcessing && (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                <span>الملف المختار: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)</span>
            </div>
        )}

        {isUploading && (
          <div className="space-y-2">
            <Label>تقدم الرفع:</Label>
            <Progress value={uploadProgress} className="w-full" />
            <p className="text-sm text-muted-foreground text-center">{Math.round(uploadProgress)}%</p>
          </div>
        )}

         {isProcessing && (
           <div className="flex items-center justify-center text-muted-foreground space-x-2 space-x-reverse">
               <Loader2 className="h-5 w-5 animate-spin" />
               <span>جاري معالجة الملف بواسطة الذكاء الاصطناعي (محاكاة)...</span>
           </div>
         )}

        {error && (
          <div className="text-destructive text-sm flex items-center gap-2">
            <X className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}

      </CardContent>
    </Card>
  );
}


    