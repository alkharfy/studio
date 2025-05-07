// src/components/pdf-uploader.tsx
'use client';

import * as React from 'react';
import { useState } from 'react';
import { ref, uploadBytesResumable, getDownloadURL, type StorageError } from 'firebase/storage';
import { useAuth } from '@/context/AuthContext';
import { storage } from '@/lib/firebase/config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Upload, FileText, Check, X } from 'lucide-react';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { Label } from "@/components/ui/label";

// Define the expected structure of parsed data (adjust based on actual AI output)
// This should match the structure written by the Cloud Function
// Note: Timestamps are handled by the function/Firestore itself.
type ParsedResumeData = Omit<FirestoreResumeData, 'createdAt' | 'updatedAt' | 'parsingDone' | 'originalFileName' | 'storagePath'> & {
    parsingDone?: boolean;
    originalFileName?: string;
    storagePath?: string;
    resumeId?: string;
    userId?: string;
    title?: string;
    personalInfo?: FirestoreResumeData['personalInfo'];
    summary?: FirestoreResumeData['summary'];
    education?: FirestoreResumeData['education'];
    experience?: FirestoreResumeData['experience'];
    skills?: FirestoreResumeData['skills'];
    languages?: FirestoreResumeData['languages'];
    hobbies?: FirestoreResumeData['hobbies'];
    customSections?: FirestoreResumeData['customSections'];
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

  const useMock = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get("mock") === "1" : false;

  if (useMock && typeof window !== 'undefined') {
    console.warn("[PdfUploader] Running in MOCK mode because '?mock=1' is present in the URL.");
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = event.target.files?.[0];
    if (file) {
      if (file.type !== 'application/pdf') {
        setError('الرجاء اختيار ملف PDF فقط.');
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError(`حجم الملف يتجاوز الحد الأقصى (${MAX_FILE_SIZE_MB} ميجابايت).`);
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      setSelectedFile(file);
      console.info("[PdfUploader] File selected:", file.name, "Size:", file.size);
    } else {
      setSelectedFile(null);
      console.info("[PdfUploader] No file selected or selection cleared.");
    }
  };

  const handleUpload = async () => {
    console.info("[PdfUploader] handleUpload triggered.");
    if (!selectedFile) {
      setError('الرجاء اختيار ملف أولاً.');
      console.error("[PdfUploader] Upload attempt without a selected file.");
      return;
    }
    if (!currentUser) {
      setError('يجب تسجيل الدخول أولاً للرفع.');
      console.error("[PdfUploader] Upload attempt without a current user (currentUser is null).");
      toast({ title: "غير مصرح به", description: "الرجاء تسجيل الدخول للمتابعة.", variant: "destructive"});
      return;
    }

    console.info("[PdfUploader] Starting upload for file:", selectedFile.name, "by user:", currentUser.uid);
    setIsUploading(true);
    setError(null);
    setUploadProgress(0);

    // Extend retry timeouts
    storage.maxUploadRetryTime = 10 * 60 * 1000;   // 10 minutes
    storage.maxOperationRetryTime = 10 * 60 * 1000; // 10 minutes

    if (useMock) {
      console.info("[PdfUploader] --- MOCK UPLOAD & PARSE ---");
      // ... (mock logic remains the same)
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
                      languages: [{ name: "لغة تجريبية", level: "مستوى تجريبي" }],
                      hobbies: ["هواية تجريبية 1", "هواية تجريبية 2"],
                      customSections: [{ title: "قسم تجريبي", content: "محتوى تجريبي" }],
                        parsingDone: true,
                        originalFileName: selectedFile.name,
                        storagePath: `mock_uploads/${currentUser.uid}/${selectedFile.name}`,
                    };
                    console.info("[PdfUploader] --- MOCK PARSE COMPLETE ---", mockParsedData);
                    toast({
                        title: '✅ محاكاة الاستخراج تمت',
                        description: 'تم ملء النموذج ببيانات تجريبية.',
                        variant: 'default',
                    });
                    setSelectedFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                    setTimeout(() => setUploadProgress(0), 1000);
              }, 3000);
          }
      }, 200);
      return;
    }

    const prefixedName = `${Date.now()}_${selectedFile.name}`; // Prefix with timestamp
    const storagePath = `resumes_uploads/${currentUser.uid}/${prefixedName}`; // Use prefixed name
    console.info(`[PdfUploader] Storage path: ${storagePath}`);
    const storageRef = ref(storage, storagePath);

    console.info("[PdfUploader] Calling uploadBytesResumable...");
    const uploadTask = uploadBytesResumable(storageRef, selectedFile, {
       // No custom metadata needed here, but include the retry options
        maxUploadRetryTime: 600_000, // 10 minutes
        maxOperationRetryTime: 600_000, // 10 minutes
    });

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        setUploadProgress(Number(progress.toFixed(2)));
        console.debug(`[PdfUploader] Upload progress: ${progress.toFixed(2)}%`);
      },
      (uploadError: StorageError) => {
        console.error('[PdfUploader] Upload Error:', uploadError.code, uploadError.message, uploadError.serverResponse);
        let message = 'حدث خطأ أثناء رفع الملف.';
        if (uploadError.code === 'storage/unauthorized') {
          message = 'ليس لديك إذن لرفع الملفات. تحقق من قواعد الأمان في Firebase Storage.';
        } else if (uploadError.code === 'storage/canceled') {
          message = 'تم إلغاء عملية الرفع.';
        } else if (uploadError.code === 'storage/object-not-found' && process.env.NEXT_PUBLIC_USE_EMULATOR === 'true') {
            message = 'فشل الرفع (Object Not Found). تأكد أن محاكي Storage يعمل وأن مسار الرفع صحيح.';
        } else if (uploadError.code === 'storage/retry-limit-exceeded') {
            message = ' تجاوز الحد الأقصى لمحاولات تحميل الملف. يرجى التحقق من اتصالك بالإنترنت والمحاولة مرة أخرى.';
        }
        setError(message);
        toast({
          title: 'خطأ في الرفع',
          description: message,
          variant: 'destructive',
        });
        setIsUploading(false);
        setUploadProgress(0);
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      },
      async () => {
        console.info("[PdfUploader] Upload completed successfully.");
        setIsUploading(false);
        setUploadProgress(100);
        toast({
          title: 'اكتمل الرفع بنجاح',
          description: 'بدأت معالجة ملف السيرة الذاتية في الخلفية. سيتم تحديث النموذج عند الانتهاء.',
          variant: 'default',
          duration: 7000,
        });

        try {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          console.info('[PdfUploader] File available at (for debug):', downloadURL);
          console.info(`[PdfUploader] Cloud Function 'parseResumePdf' should trigger for path: ${storagePath}`);
          // The onSnapshot listener in page.tsx will handle UI updates when parsing is done.
        } catch (processError: any) {
          console.error('[PdfUploader] Error after upload (e.g., getting download URL):', processError);
          setError('حدث خطأ بعد اكتمال الرفع.');
          toast({
            title: 'خطأ بعد الرفع',
            description: 'حدث خطأ غير متوقع بعد اكتمال رفع الملف.',
            variant: 'destructive',
          });
        } finally {
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = '';
          // Delay hiding progress bar for better UX
          setTimeout(() => setUploadProgress(0), 2000);
        }
      }
    );
  };

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
            {isUploading ? 'جاري الرفع...' : 'رفع واستخراج'}
          </Button>
        </div>

        {selectedFile && !isUploading && uploadProgress === 0 && ( // Show selected file info only if not actively uploading
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <FileText className="h-4 w-4" />
            <span>الملف المختار: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)</span>
          </div>
        )}

        {uploadProgress > 0 && ( // Show progress bar and percentage only when progress is > 0
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <Label className="text-sm">{isUploading ? "تقدم الرفع:" : "اكتمل الرفع!"}</Label>
              {uploadProgress === 100 && !isUploading && <Check className="h-5 w-5 text-green-600" />}
            </div>
            <Progress value={uploadProgress} className="w-full h-2" /> {/* Made progress bar thinner */}
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
