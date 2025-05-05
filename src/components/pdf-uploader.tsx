
'use client';

import * as React from 'react';
import { useState } from 'react';
import { ref, uploadBytesResumable, getDownloadURL, type StorageError } from 'firebase/storage';
import { doc, setDoc, serverTimestamp, collection, Timestamp } from 'firebase/firestore'; // Import Timestamp
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
// This should match the structure written by the Cloud Function
type ParsedResumeData = Omit<Resume, 'createdAt' | 'updatedAt'> & { // Omit Timestamp types for initial data
    parsingDone?: boolean;
    originalFileName?: string;
    storagePath?: string;
};

interface PdfUploaderProps {
  onParsingComplete: (parsedData: ParsedResumeData) => void; // Use the specific type
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
          const resumeId = Date.now().toString(); // Match function's ID generation for simulation consistency
          const firestorePath = `users/${currentUser.uid}/resumes/${resumeId}`;
          const newResumeRef = doc(db, firestorePath);

          // Example Parsed Data (Matching Function Output Structure)
          const simulatedParsedData: ParsedResumeData = {
            resumeId: resumeId,
            userId: currentUser.uid,
            title: `مسودة مستخرجة من ${selectedFile.name}`,
            personalInfo: {
              fullName: 'تجربة الاسم الكامل (محاكاة)',
              jobTitle: 'تجربة المسمى الوظيفي (محاكاة)',
              email: currentUser.email || 'email-sim@example.com',
              phone: '055-SIM-ULATE',
              address: '123 شارع المحاكاة، مدينة البيانات',
            },
            summary: 'هذا ملخص تم استخراجه بواسطة المحاكاة. يجب أن يأتي هذا النص من الذكاء الاصطناعي بعد تحليل السيرة الذاتية الفعلية.',
            experience: [
              { jobTitle: 'مطور محاكاة أول', company: 'شركة البيانات الوهمية', startDate: 'يناير 2023', endDate: 'الحاضر', description: 'وصف محاكاة للخبرة العملية، تطوير وصيانة أنظمة المحاكاة.' },
              { jobTitle: 'مطور محاكاة', company: 'شركة وهمية للبرمجة', startDate: 'يونيو 2021', endDate: 'ديسمبر 2022', description: 'بناء نماذج محاكاة أولية.' },
            ],
            education: [
                { degree: 'بكالوريوس محاكاة الحاسب', institution: 'جامعة البيانات الوهمية', graduationYear: '2021', details: 'مشروع تخرج في تحليل بيانات السيرة الذاتية (محاكاة).' }
            ],
            skills: [ { name: 'تحليل PDF (محاكاة)' }, { name: 'استخراج بيانات JSON (محاكاة)' }, { name: 'محاكاة السحابة' }, { name: 'الذكاء الاصطناعي (وهمي)' } ],
            languages: ['العربية (محاكاة)', 'الإنجليزية (محاكاة)'],
            hobbies: ['قراءة وثائق Firebase (محاكاة)'],
            customSections: [
              { title: 'قسم مخصص (محاكاة)', content: 'محتوى تجريبي لقسم مخصص.' }
            ],
            // Fields added by the function
            parsingDone: true, // Set the flag
            originalFileName: selectedFile.name,
            storagePath: storagePath,
          };

          // Write the simulated data to Firestore, including timestamps
          // Note: In the real scenario, the *function* writes this, not the client.
          // The client *listens* for this document.
          await setDoc(newResumeRef, {
              ...simulatedParsedData,
              createdAt: serverTimestamp(), // Firestore server timestamp
              updatedAt: serverTimestamp(),
          });
          console.log(`Simulated Firestore write to: ${firestorePath}`);


          // **SIMULATION LOGIC END**

          // Notify parent component (this would normally happen via Firestore listener)
          // Pass the data *without* the Timestamp objects, as the form expects plain data initially.
          // The parent component will handle adding timestamps when saving *user edits*.
          onParsingComplete(simulatedParsedData);

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
            <strong className='text-destructive'>ملاحظة:</strong> المعالجة بالذكاء الاصطناعي محاكاة حاليًا. سيتم ملء النموذج ببيانات تجريبية مطابقة لمخرجات الوظيفة السحابية.
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
              {isLoading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Upload className="ml-2 h-4 w-4" />}
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

        {selectedFile && !isLoading && ( // Show selected file even during processing
            <div className="text-sm text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                <span>الملف المختار: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)</span>
                {uploadProgress === 100 && !isProcessing && <Check className="h-4 w-4 text-green-600" />}
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
           <div className="flex items-center justify-center text-muted-foreground space-x-2 space-x-reverse pt-2">
               <Loader2 className="h-5 w-5 animate-spin" />
               <span>جاري معالجة الملف بواسطة الذكاء الاصطناعي (محاكاة)...</span>
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

