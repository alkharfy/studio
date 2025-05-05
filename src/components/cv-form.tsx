
'use client';

import * as React from 'react';
import { useState, useCallback, useMemo } from 'react'; // Added useMemo
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useFieldArray, type UseFormReturn, useFormContext } from 'react-hook-form';
import { z } from 'zod';
import { Disclosure } from '@headlessui/react'; // Import Disclosure
import clsx from 'clsx'; // For conditional classes
import { Button } from '@/components/ui/button';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { enhanceCvContent, type EnhanceCvContentInput } from '@/ai/flows/cv-content-enhancement';
import { useToast } from '@/hooks/use-toast';
import { Loader2, PlusCircle, Trash2, Wand2, Save, ChevronDown } from 'lucide-react'; // Added ChevronDown
import { useAuth } from '@/context/AuthContext';
import { db, auth } from '@/lib/firebase/config'; // Import auth for functions
import { doc, setDoc, collection, serverTimestamp, updateDoc } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { PdfUploader } from '@/components/pdf-uploader';
import type { User } from 'firebase/auth';
import { getFunctions, httpsCallable, connectFunctionsEmulator, type Functions } from 'firebase/functions'; // Import Firebase Functions SDK types

// Define Zod schema for the form (Keep this consistent with page.tsx if sharing logic)
const experienceSchema = z.object({
  jobTitle: z.string().min(1, { message: 'يجب إدخال المسمى الوظيفي' }).nullable().default(''),
  company: z.string().min(1, { message: 'يجب إدخال اسم الشركة' }).nullable().default(''),
  startDate: z.string().min(1, { message: 'يجب إدخال تاريخ البدء' }).nullable().default(''), // Consider using date type if needed
  endDate: z.string().optional().nullable(), // Allow null
  description: z.string().optional().nullable(), // Allow null
}).default({ jobTitle: null, company: null, startDate: null, endDate: null, description: null }); // Use null defaults

const educationSchema = z.object({
  degree: z.string().min(1, { message: 'يجب إدخال اسم الشهادة' }).nullable().default(''),
  institution: z.string().min(1, { message: 'يجب إدخال اسم المؤسسة التعليمية' }).nullable().default(''),
  graduationYear: z.string().min(1, { message: 'يجب إدخال سنة التخرج' }).nullable().default(''),
  details: z.string().optional().nullable(), // Allow null
}).default({ degree: null, institution: null, graduationYear: null, details: null }); // Use null defaults

const skillSchema = z.object({
  name: z.string().min(1, { message: 'يجب إدخال اسم المهارة' }).nullable().default(''),
}).default({ name: null }); // Use null default

export const cvSchema = z.object({
  resumeId: z.string().optional(), // To store the ID of the loaded/saved resume
  title: z.string().min(1, { message: 'يجب إدخال عنوان للسيرة الذاتية' }).default('مسودة السيرة الذاتية'),
  fullName: z.string().min(1, { message: 'يجب إدخال الاسم الكامل' }),
  jobTitle: z.string().min(1, { message: 'يجب إدخال المسمى الوظيفي الحالي أو المرغوب' }),
  email: z.string().email({ message: 'البريد الإلكتروني غير صالح' }),
  phone: z.string().min(1, { message: 'يجب إدخال رقم الهاتف' }),
  address: z.string().optional().nullable(), // Allow null
  summary: z.string().min(10, { message: 'يجب أن يكون الملخص 10 أحرف على الأقل' }),
  experience: z.array(experienceSchema).default([]),
  education: z.array(educationSchema).default([]),
  skills: z.array(skillSchema).default([]),
  // Add yearsExperience for AI summary function (optional, could derive from experience dates)
  yearsExperience: z.number().min(0).optional().nullable(), // Added for AI summary
  jobDescriptionForAI: z.string().optional().nullable(), // For AI enhancement
});

export type CvFormData = z.infer<typeof cvSchema>;

interface CvFormProps {
  isLoadingCv: boolean;
  handlePdfParsingComplete: (parsedData: Partial<FirestoreResumeData>) => void;
}

// --- Normalization Function (Keep this consistent with page.tsx if sharing logic) ---
export const normalizeResumeData = (raw: FirestoreResumeData | null, currentUser: User | null): CvFormData => {
    const defaults: CvFormData = {
        title: 'مسودة السيرة الذاتية',
        fullName: currentUser?.displayName || '',
        jobTitle: '',
        email: currentUser?.email || '',
        phone: '',
        address: null,
        summary: '',
        experience: [],
        education: [],
        skills: [],
        yearsExperience: 0, // Default years experience
        jobDescriptionForAI: null,
        resumeId: undefined,
    };

    if (!raw) return defaults;

    // TODO: Calculate yearsExperience based on raw.experience dates if needed

    // Map Firestore data (uses institute, year, title, start, end) to form data (institution, graduationYear, jobTitle, startDate, endDate)
    return {
        resumeId: raw.resumeId,
        title: raw.title ?? defaults.title,
        fullName: raw.personalInfo?.fullName ?? defaults.fullName,
        jobTitle: raw.personalInfo?.jobTitle ?? defaults.jobTitle,
        email: raw.personalInfo?.email ?? currentUser?.email ?? defaults.email,
        phone: raw.personalInfo?.phone ?? defaults.phone,
        address: raw.personalInfo?.address ?? defaults.address,
        summary: raw.summary ?? defaults.summary,
        education: (raw.education ?? []).map(edu => ({
            degree: edu.degree ?? '',
            institution: edu.institution ?? '',
            graduationYear: edu.graduationYear ?? '',
            details: edu.details ?? null,
        })).filter(edu => edu.degree || edu.institution || edu.graduationYear),
        experience: (raw.experience ?? []).map(exp => ({
            jobTitle: exp.jobTitle ?? '',
            company: exp.company ?? '',
            startDate: exp.startDate ?? '',
            endDate: exp.endDate ?? null,
            description: exp.description ?? null,
        })).filter(exp => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description),
        skills: (raw.skills ?? []).map(skill => ({
            name: typeof skill === 'string' ? skill : (skill.name ?? ''),
        })).filter(skill => skill.name),
        // Handle yearsExperience (could be calculated or stored)
        yearsExperience: defaults.yearsExperience, // Placeholder
        jobDescriptionForAI: defaults.jobDescriptionForAI,
    };
};
// --- End Normalization Function ---


// Use useFormContext to get the form instance from the parent provider
export function CvForm({ isLoadingCv, handlePdfParsingComplete }: CvFormProps) {
  const form = useFormContext<CvFormData>(); // Get form instance from context
  const [isGenerating, setIsGenerating] = useState(false); // For AI content enhancement
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingAISkills, setIsLoadingAISkills] = useState(false); // Loading state for AI skills
  const [isLoadingAISummary, setIsLoadingAISummary] = useState(false); // Loading state for AI summary
  const { toast } = useToast();
  const { currentUser } = useAuth();

  // --- Firebase Functions Initialization (Client-side only) ---
  const functionsInstance = useMemo(() => {
    // Ensure this runs only on the client where `auth.app` is available
    if (typeof window !== 'undefined' && auth.app) {
      const functions = getFunctions(auth.app);
      // Connect to emulator if configured
      if (process.env.NEXT_PUBLIC_USE_EMULATOR === 'true') {
        try {
          connectFunctionsEmulator(functions, "127.0.0.1", 5001);
          console.log("Connected to Functions Emulator from CvForm.");
        } catch (error) {
          // Avoid duplicate connection errors in hot-reload scenarios
           if (!(error instanceof Error && error.message.includes('already connected'))) {
             console.error("Error connecting to Functions emulator from CvForm:", error);
           }
        }
      }
      return functions;
    }
    return null; // Return null during SSR or if auth.app is not ready
  }, []); // Empty dependency array ensures it runs once on mount

  // Define HttpsCallable functions using the initialized instance
  const suggestSummaryFn = useMemo(() => functionsInstance ? httpsCallable(functionsInstance, 'suggestSummary') : null, [functionsInstance]);
  const suggestSkillsFn = useMemo(() => functionsInstance ? httpsCallable(functionsInstance, 'suggestSkills') : null, [functionsInstance]);
  // --- End Firebase Functions Initialization ---


  const { fields: experienceFields, append: appendExperience, remove: removeExperience } = useFieldArray({
    control: form.control,
    name: 'experience',
  });

  const { fields: educationFields, append: appendEducation, remove: removeEducation } = useFieldArray({
    control: form.control,
    name: 'education',
  });

  const { fields: skillFields, append: appendSkill, remove: removeSkill } = useFieldArray({
    control: form.control,
    name: 'skills',
  });

  // Function to format CV data into a single string for AI enhancement
  const formatCvForAI = (data: CvFormData): string => {
    let cvString = `الاسم: ${data.fullName}\n`;
    cvString += `المسمى الوظيفي: ${data.jobTitle}\n`;
    cvString += `البريد الإلكتروني: ${data.email}\n`;
    cvString += `الهاتف: ${data.phone}\n`;
    if (data.address) cvString += `العنوان: ${data.address}\n`;
    cvString += `الملخص: ${data.summary}\n\n`;

    cvString += "الخبرة العملية:\n";
    (data.experience || []).forEach((exp) => {
      cvString += `- ${exp.jobTitle} في ${exp.company} (${exp.startDate} - ${exp.endDate || 'الحاضر'})\n`;
      if (exp.description) cvString += `  ${exp.description}\n`;
    });
    cvString += "\n";

    cvString += "التعليم:\n";
    (data.education || []).forEach((edu) => {
      cvString += `- ${edu.degree}, ${edu.institution} (${edu.graduationYear})\n`;
      if (edu.details) cvString += `  ${edu.details}\n`;
    });
    cvString += "\n";

    cvString += "المهارات:\n";
    cvString += (data.skills || []).map(skill => skill.name).join(', ') + '\n';

    return cvString;
  };

   // --- AI Suggestion Handlers ---

   const handleAISkills = async () => {
    if (!suggestSkillsFn) {
        toast({ title: 'خطأ', description: 'خدمة اقتراح المهارات غير متاحة حالياً.', variant: 'destructive' });
        return;
    }
    const jobTitle = form.getValues('jobTitle');
    if (!jobTitle) {
        toast({ title: 'خطأ', description: 'الرجاء إدخال المسمى الوظيفي أولاً لاقتراح المهارات.', variant: 'destructive' });
        return;
    }
    setIsLoadingAISkills(true);
    try {
      const result: any = await suggestSkillsFn({ // Use 'any' for result type from callable for now
        jobTitle: jobTitle,
        max: 8,
        lang: "ar",
      });

      if (result.data?.skills && Array.isArray(result.data.skills)) {
          const existingSkills = form.getValues('skills').map(s => s.name?.toLowerCase()); // Get existing skill names (lowercase)
          const newSkills = result.data.skills
             .filter((skill: string) => skill && !existingSkills.includes(skill.toLowerCase())) // Filter out duplicates (case-insensitive) and empty strings
             .map((skill: string) => ({ name: skill })); // Map to { name: string } format

           if (newSkills.length > 0) {
                appendSkill(newSkills); // Append only unique new skills
                toast({ title: "نجاح", description: "تم اقتراح وإضافة مهارات جديدة بنجاح!" });
            } else {
                 toast({ title: "لا مهارات جديدة", description: "لم يتم العثور على مهارات جديدة لإضافتها." });
            }
      } else {
           throw new Error("Invalid response format from suggestSkills function.");
      }

    } catch (error: any) {
      console.error('AI Skills Suggestion Error:', error);
      toast({
        title: 'خطأ في اقتراح المهارات',
        description: error.message || 'حدث خطأ أثناء محاولة اقتراح المهارات. الرجاء المحاولة مرة أخرى.',
        variant: 'destructive',
      });
    } finally {
      setIsLoadingAISkills(false);
    }
  };

  const handleAISummary = async () => {
      if (!suggestSummaryFn) {
        toast({ title: 'خطأ', description: 'خدمة اقتراح النبذة غير متاحة حالياً.', variant: 'destructive' });
        return;
      }
      const jobTitle = form.getValues('jobTitle');
      const yearsExp = form.getValues('yearsExperience'); // Ensure this field exists in the form/schema
      const skills = form.getValues('skills').map(s => s.name).filter(Boolean).slice(0, 5) as string[]; // Get top 5 skill names

      if (!jobTitle) {
          toast({ title: 'خطأ', description: 'الرجاء إدخال المسمى الوظيفي أولاً لتوليد النبذة.', variant: 'destructive' });
          return;
      }

      setIsLoadingAISummary(true);
      try {
          const result: any = await suggestSummaryFn({
              jobTitle: jobTitle,
              yearsExp: yearsExp ?? 0, // Pass yearsExperience (default to 0 if null/undefined)
              skills: skills,
              lang: "ar",
          });

         if (result.data?.summary && typeof result.data.summary === 'string') {
              form.setValue('summary', result.data.summary, { shouldValidate: true });
              toast({ title: "نجاح", description: "تم توليد النبذة بنجاح!" });
          } else {
               throw new Error("Invalid response format from suggestSummary function.");
          }

      } catch (error: any) {
          console.error('AI Summary Generation Error:', error);
          toast({
              title: 'خطأ في توليد النبذة',
              description: error.message || 'حدث خطأ أثناء محاولة توليد النبذة. الرجاء المحاولة مرة أخرى.',
              variant: 'destructive',
          });
      } finally {
          setIsLoadingAISummary(false);
      }
  };


  const handleEnhanceContent = async () => {
    const jobDesc = form.getValues('jobDescriptionForAI');
    const currentSummary = form.getValues('summary');
    const cvContent = formatCvForAI(form.getValues());

    if (!jobDesc) {
      toast({
        title: 'خطأ',
        description: 'الرجاء إدخال وصف وظيفي لتحسين المحتوى.',
        variant: 'destructive',
      });
      return;
    }

    setIsGenerating(true);
    try {
       const inputData: EnhanceCvContentInput = {
         cvContent: `الملخص الحالي: ${currentSummary}\n\nالسيرة الذاتية الكاملة:\n${cvContent}`,
         jobDescription: jobDesc,
       };
      const result = await enhanceCvContent(inputData);
      form.setValue('summary', result.enhancedCvContent, { shouldValidate: true });
      toast({
        title: 'نجاح',
        description: 'تم تحسين ملخص السيرة الذاتية بنجاح!',
      });
    } catch (error) {
      console.error('AI Enhancement Error:', error);
      toast({
        title: 'خطأ في التحسين',
        description: 'حدث خطأ أثناء محاولة تحسين المحتوى. الرجاء المحاولة مرة أخرى.',
        variant: 'destructive',
      });
    } finally {
      setIsGenerating(false);
    }
  };

    async function onSubmit(values: CvFormData) {
        if (!currentUser) {
            toast({ title: 'خطأ', description: 'يجب تسجيل الدخول لحفظ السيرة الذاتية.', variant: 'destructive' });
            return;
        }
        setIsSaving(true);
        try {
            // Map form data (CvFormData) back to Firestore structure (FirestoreResumeData)
            const resumeDataToSave: Omit<FirestoreResumeData, 'createdAt' | 'updatedAt' | 'parsingDone' | 'originalFileName' | 'storagePath'> & { updatedAt: any, createdAt?: any } = {
                userId: currentUser.uid,
                resumeId: values.resumeId || '',
                title: values.title,
                personalInfo: {
                    fullName: values.fullName,
                    jobTitle: values.jobTitle,
                    email: values.email,
                    phone: values.phone,
                    address: values.address,
                },
                summary: values.summary,
                education: values.education.map(edu => ({
                    degree: edu.degree || null,
                    institution: edu.institution || null,
                    graduationYear: edu.graduationYear || null,
                    details: edu.details || null,
                })).filter(edu => edu.degree || edu.institution || edu.graduationYear),
                experience: values.experience.map(exp => ({
                    jobTitle: exp.jobTitle || null,
                    company: exp.company || null,
                    startDate: exp.startDate || null,
                    endDate: exp.endDate || null,
                    description: exp.description || null,
                })).filter(exp => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description),
                skills: values.skills.map(skill => ({
                    name: skill.name || null,
                })).filter(skill => skill.name),
                languages: [], // Default empty
                hobbies: [], // Default empty
                customSections: [], // Default empty
                updatedAt: serverTimestamp(),
            };

            let docRef;
            if (values.resumeId) {
                docRef = doc(db, 'users', currentUser.uid, 'resumes', values.resumeId);
                await updateDoc(docRef, resumeDataToSave);
                toast({ title: 'تم التحديث', description: 'تم تحديث سيرتك الذاتية بنجاح.' });
                console.log('CV Updated:', values.resumeId);
            } else {
                const resumesCollectionRef = collection(db, 'users', currentUser.uid, 'resumes');
                docRef = doc(resumesCollectionRef);
                resumeDataToSave.resumeId = docRef.id;

                const fullDataToSave: FirestoreResumeData = {
                    ...resumeDataToSave,
                    parsingDone: false,
                    originalFileName: null,
                    storagePath: null,
                    createdAt: serverTimestamp(),
                    languages: resumeDataToSave.languages ?? [],
                    hobbies: resumeDataToSave.hobbies ?? [],
                    customSections: resumeDataToSave.customSections ?? [],
                };

                await setDoc(docRef, fullDataToSave);
                form.setValue('resumeId', docRef.id);
                toast({ title: 'تم الحفظ', description: 'تم حفظ سيرتك الذاتية بنجاح.' });
                console.log('CV Saved with new ID:', docRef.id);
            }

        } catch (error) {
            console.error('Error saving CV:', error);
            toast({
                title: 'خطأ في الحفظ',
                description: 'لم نتمكن من حفظ السيرة الذاتية. الرجاء المحاولة مرة أخرى.',
                variant: 'destructive',
            });
        } finally {
            setIsSaving(false);
        }
    }

  if (isLoadingCv) {
     return (
       <div className="flex min-h-[calc(100vh-100px)] items-center justify-center p-8">
         <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className='mr-4 text-muted-foreground'>جاري تحميل بيانات السيرة الذاتية...</p>
       </div>
     );
   }

  const resumeId = form.watch('resumeId');
  const jobTitle = form.watch('jobTitle'); // Watch jobTitle to disable AI buttons

  return (
      <div className="p-4">
         <div className="mb-8">
            <PdfUploader onParsingComplete={handlePdfParsingComplete} />
         </div>

         <form
           className="space-y-8"
           onSubmit={form.handleSubmit(onSubmit)}
         >
            {/* --- Personal Information Disclosure --- */}
             <Disclosure defaultOpen>
               {({ open }) => (
                 <Card>
                     <Disclosure.Button as={React.Fragment}>
                         <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-muted/50 rounded-t-lg p-4">
                           <CardTitle className="text-lg">المعلومات الشخصية</CardTitle>
                            <ChevronDown className={clsx("h-5 w-5 transition-transform", open && "rotate-180")} />
                         </CardHeader>
                     </Disclosure.Button>
                     <Disclosure.Panel as={React.Fragment}>
                         <CardContent className="pt-4 space-y-4"> {/* Add pt-4 for spacing */}
                           <FormField
                             control={form.control}
                             name="fullName"
                             render={({ field }) => (
                               <FormItem>
                                 <FormLabel>الاسم الكامل</FormLabel>
                                 <FormControl>
                                   <Input placeholder="مثال: محمد أحمد عبدالله" {...field} />
                                 </FormControl>
                                 <FormMessage />
                               </FormItem>
                             )}
                           />
                           <FormField
                             control={form.control}
                             name="jobTitle"
                             render={({ field }) => (
                               <FormItem>
                                 <FormLabel>المسمى الوظيفي</FormLabel>
                                 <FormControl>
                                   <Input placeholder="مثال: مهندس برمجيات" {...field} />
                                 </FormControl>
                                 <FormMessage />
                               </FormItem>
                             )}
                           />
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <FormField
                                 control={form.control}
                                 name="email"
                                 render={({ field }) => (
                                   <FormItem>
                                     <FormLabel>البريد الإلكتروني</FormLabel>
                                     <FormControl>
                                       <Input type="email" placeholder="example@mail.com" {...field} readOnly={!!currentUser} className={currentUser ? 'cursor-not-allowed opacity-70' : ''}/>
                                     </FormControl>
                                      {currentUser && <FormDescription>لا يمكن تغيير البريد الإلكتروني بعد تسجيل الدخول.</FormDescription>}
                                     <FormMessage />
                                   </FormItem>
                                 )}
                               />
                               <FormField
                                 control={form.control}
                                 name="phone"
                                 render={({ field }) => (
                                   <FormItem>
                                     <FormLabel>رقم الهاتف</FormLabel>
                                     <FormControl>
                                       <Input placeholder="+966 5X XXX XXXX" {...field} dir="ltr" className="text-right"/>
                                     </FormControl>
                                     <FormMessage />
                                   </FormItem>
                                 )}
                               />
                            </div>
                           <FormField
                             control={form.control}
                             name="address"
                              render={({ field }) => (
                               <FormItem>
                                 <FormLabel>العنوان (اختياري)</FormLabel>
                                 <FormControl>
                                   <Input placeholder="مثال: الرياض، المملكة العربية السعودية" {...field} value={field.value ?? ''} />
                                 </FormControl>
                                 <FormMessage />
                               </FormItem>
                             )}
                           />
                           {/* Add yearsExperience field if needed */}
                            {/* <FormField
                                control={form.control}
                                name="yearsExperience"
                                render={({ field }) => (
                                <FormItem>
                                    <FormLabel>سنوات الخبرة</FormLabel>
                                    <FormControl>
                                        <Input type="number" min="0" placeholder="مثال: 5" {...field} value={field.value ?? 0} onChange={e => field.onChange(parseInt(e.target.value, 10) || 0)} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                                )}
                            /> */}
                         </CardContent>
                     </Disclosure.Panel>
                 </Card>
               )}
            </Disclosure>


           {/* --- Summary Disclosure --- */}
           <Disclosure defaultOpen>
                {({ open }) => (
                    <Card>
                        <Disclosure.Button as={React.Fragment}>
                             <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-muted/50 rounded-t-lg p-4">
                               <CardTitle className="text-lg">الملخص الشخصي</CardTitle>
                                <ChevronDown className={clsx("h-5 w-5 transition-transform", open && "rotate-180")} />
                             </CardHeader>
                        </Disclosure.Button>
                         <Disclosure.Panel as={React.Fragment}>
                             <CardContent className="pt-4 space-y-4"> {/* Add pt-4 for spacing */}
                               <FormField
                                 control={form.control}
                                 name="summary"
                                 render={({ field }) => (
                                   <FormItem>
                                     <FormLabel>الملخص</FormLabel>
                                     <FormControl>
                                       <Textarea
                                         placeholder="اكتب نبذة مختصرة عن خبراتك وأهدافك المهنية..."
                                         className="resize-y min-h-[100px]"
                                         {...field}
                                       />
                                     </FormControl>
                                     <FormDescription>
                                        أدخل مسمى وظيفي لتمكين اقتراح النبذة بالذكاء الاصطناعي.
                                    </FormDescription>
                                     <FormMessage />
                                   </FormItem>
                                 )}
                               />
                                {/* AI Summary Button */}
                                <Button
                                     type="button"
                                     variant="ghost"
                                     onClick={handleAISummary}
                                     disabled={isLoadingAISummary || !jobTitle || !suggestSummaryFn}
                                     className="mt-2 text-accent hover:bg-accent/10"
                                     aria-label="كتابة نبذة بالذكاء الاصطناعي"
                                 >
                                     {isLoadingAISummary ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Wand2 className="ml-2 h-4 w-4" />}
                                     {isLoadingAISummary ? 'جاري التوليد...' : 'كتابة نبذة بالذكاء الاصطناعي'}
                                 </Button>
                             </CardContent>
                         </Disclosure.Panel>
                    </Card>
                )}
           </Disclosure>

          {/* AI Enhancement Section - Keep separate or integrate? Keeping separate for now */}
           <Disclosure defaultOpen>
                {({ open }) => (
                    <Card>
                        <Disclosure.Button as={React.Fragment}>
                            <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-muted/50 rounded-t-lg p-4">
                                <CardTitle className="text-lg">تحسين المحتوى بالذكاء الاصطناعي (تجريبي)</CardTitle>
                                <ChevronDown className={clsx("h-5 w-5 transition-transform", open && "rotate-180")} />
                            </CardHeader>
                         </Disclosure.Button>
                         <Disclosure.Panel as={React.Fragment}>
                              <CardContent className="pt-4 space-y-4">
                                 <FormField
                                     control={form.control}
                                     name="jobDescriptionForAI"
                                     render={({ field }) => (
                                       <FormItem>
                                         <FormLabel>الوصف الوظيفي للوظيفة المستهدفة</FormLabel>
                                         <FormControl>
                                           <Textarea
                                             placeholder="الصق هنا الوصف الوظيفي للوظيفة التي تتقدم لها..."
                                             className="resize-y min-h-[150px]"
                                              value={field.value ?? ''}
                                              onChange={field.onChange}
                                              onBlur={field.onBlur}
                                              name={field.name}
                                              ref={field.ref}
                                           />
                                         </FormControl>
                                          <FormDescription>
                                             سيقوم الذكاء الاصطناعي باستخدام هذا الوصف لتحسين محتوى سيرتك الذاتية (مثل الملخص).
                                         </FormDescription>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                  <Button
                                     type="button"
                                     onClick={handleEnhanceContent}
                                     disabled={isGenerating || !form.watch('jobDescriptionForAI')}
                                     className="bg-accent hover:bg-accent/90 text-accent-foreground"
                                     aria-label="تحسين الملخص"
                                   >
                                     {isGenerating ? (
                                       <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                                     ) : (
                                        <Wand2 className="ml-2 h-4 w-4" />
                                     )}
                                     {isGenerating ? 'جاري التحسين...' : 'تحسين الملخص (Enhance)'}
                                   </Button>
                              </CardContent>
                         </Disclosure.Panel>
                    </Card>
                )}
           </Disclosure>

           {/* --- Work Experience Disclosure --- */}
           <Disclosure defaultOpen>
                {({ open }) => (
                    <Card>
                        <Disclosure.Button as={React.Fragment}>
                             <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-muted/50 rounded-t-lg p-4">
                               <CardTitle className="text-lg">الخبرة العملية</CardTitle>
                                <div className="flex items-center gap-2">
                                     <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); appendExperience(experienceSchema.parse({})); }} // Stop propagation to prevent disclosure toggle
                                        className="z-10" // Ensure button is clickable over header
                                        aria-label="إضافة خبرة"
                                    >
                                        <PlusCircle className="ml-2 h-4 w-4" />
                                        إضافة
                                    </Button>
                                     <ChevronDown className={clsx("h-5 w-5 transition-transform", open && "rotate-180")} />
                                </div>
                             </CardHeader>
                        </Disclosure.Button>
                         <Disclosure.Panel as={React.Fragment}>
                             <CardContent className="pt-4 space-y-6">
                                {!experienceFields || experienceFields.length === 0 && (
                                     <p className="text-muted-foreground text-center py-4">لم تتم إضافة أي خبرة عملية بعد.</p>
                                )}
                               {experienceFields.map((field, index) => (
                                 <div key={field.id} className="space-y-4 p-4 border rounded-md relative group">
                                    <FormField
                                       control={form.control}
                                       name={`experience.${index}.jobTitle`}
                                       render={({ field }) => (
                                         <FormItem>
                                           <FormLabel>المسمى الوظيفي</FormLabel>
                                           <FormControl>
                                             <Input placeholder="مثال: مطور واجهة أمامية" {...field} value={field.value ?? ''} />
                                           </FormControl>
                                           <FormMessage />
                                         </FormItem>
                                       )}
                                     />
                                      <FormField
                                       control={form.control}
                                       name={`experience.${index}.company`}
                                       render={({ field }) => (
                                         <FormItem>
                                           <FormLabel>الشركة</FormLabel>
                                           <FormControl>
                                             <Input placeholder="مثال: شركة تقنية ناشئة" {...field} value={field.value ?? ''} />
                                           </FormControl>
                                           <FormMessage />
                                         </FormItem>
                                       )}
                                     />
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                          <FormField
                                             control={form.control}
                                             name={`experience.${index}.startDate`}
                                             render={({ field }) => (
                                               <FormItem>
                                                 <FormLabel>تاريخ البدء</FormLabel>
                                                 <FormControl>
                                                   <Input placeholder="مثال: يناير 2020" {...field} value={field.value ?? ''} />
                                                 </FormControl>
                                                 <FormMessage />
                                               </FormItem>
                                             )}
                                           />
                                           <FormField
                                             control={form.control}
                                             name={`experience.${index}.endDate`}
                                              render={({ field }) => (
                                               <FormItem>
                                                 <FormLabel>تاريخ الانتهاء (اتركه فارغًا للحالي)</FormLabel>
                                                 <FormControl>
                                                   <Input placeholder="مثال: ديسمبر 2022" {...field} value={field.value ?? ''} />
                                                 </FormControl>
                                                 <FormMessage />
                                               </FormItem>
                                             )}
                                           />
                                      </div>
                                      <FormField
                                       control={form.control}
                                       name={`experience.${index}.description`}
                                        render={({ field }) => (
                                         <FormItem>
                                           <FormLabel>الوصف (اختياري)</FormLabel>
                                           <FormControl>
                                              <Textarea
                                                 placeholder="صف مهامك وإنجازاتك الرئيسية..."
                                                 {...field}
                                                 value={field.value ?? ''}
                                                 />
                                           </FormControl>
                                           <FormMessage />
                                         </FormItem>
                                       )}
                                     />
                                   <Button
                                     type="button"
                                     variant="ghost"
                                     size="icon"
                                     onClick={() => removeExperience(index)}
                                     className="absolute top-2 left-2 w-7 h-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                                     aria-label="حذف الخبرة"
                                   >
                                     <Trash2 className="h-4 w-4" />
                                   </Button>
                                 </div>
                               ))}
                             </CardContent>
                         </Disclosure.Panel>
                    </Card>
                )}
           </Disclosure>

            {/* --- Education Disclosure --- */}
            <Disclosure defaultOpen>
                {({ open }) => (
                    <Card>
                        <Disclosure.Button as={React.Fragment}>
                             <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-muted/50 rounded-t-lg p-4">
                               <CardTitle className="text-lg">التعليم</CardTitle>
                               <div className="flex items-center gap-2">
                                     <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); appendEducation(educationSchema.parse({})); }} // Stop propagation
                                        className="z-10"
                                        aria-label="إضافة تعليم"
                                    >
                                        <PlusCircle className="ml-2 h-4 w-4" />
                                        إضافة
                                    </Button>
                                    <ChevronDown className={clsx("h-5 w-5 transition-transform", open && "rotate-180")} />
                                </div>
                             </CardHeader>
                        </Disclosure.Button>
                         <Disclosure.Panel as={React.Fragment}>
                              <CardContent className="pt-4 space-y-6">
                               {!educationFields || educationFields.length === 0 && (
                                  <p className="text-muted-foreground text-center py-4">لم تتم إضافة أي مؤهلات علمية بعد.</p>
                               )}
                               {educationFields.map((field, index) => (
                                 <div key={field.id} className="space-y-4 p-4 border rounded-md relative group">
                                   <FormField
                                     control={form.control}
                                     name={`education.${index}.degree`}
                                     render={({ field }) => (
                                       <FormItem>
                                         <FormLabel>الشهادة أو الدرجة العلمية</FormLabel>
                                         <FormControl>
                                           <Input placeholder="مثال: بكالوريوس علوم الحاسب" {...field} value={field.value ?? ''} />
                                         </FormControl>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                    <FormField
                                     control={form.control}
                                     name={`education.${index}.institution`}
                                     render={({ field }) => (
                                       <FormItem>
                                         <FormLabel>المؤسسة التعليمية</FormLabel>
                                         <FormControl>
                                           <Input placeholder="مثال: جامعة الملك سعود" {...field} value={field.value ?? ''} />
                                         </FormControl>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                   <FormField
                                     control={form.control}
                                     name={`education.${index}.graduationYear`}
                                     render={({ field }) => (
                                       <FormItem>
                                         <FormLabel>سنة التخرج</FormLabel>
                                         <FormControl>
                                           <Input placeholder="مثال: 2019" {...field} value={field.value ?? ''} />
                                         </FormControl>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                   <FormField
                                     control={form.control}
                                     name={`education.${index}.details`}
                                      render={({ field }) => (
                                       <FormItem>
                                         <FormLabel>تفاصيل إضافية (اختياري)</FormLabel>
                                         <FormControl>
                                            <Textarea
                                             placeholder="مثال: مشروع التخرج، مرتبة الشرف..."
                                             {...field}
                                              value={field.value ?? ''}
                                             />
                                         </FormControl>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                  <Button
                                     type="button"
                                     variant="ghost"
                                     size="icon"
                                     onClick={() => removeEducation(index)}
                                     className="absolute top-2 left-2 w-7 h-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                                     aria-label="حذف التعليم"
                                   >
                                     <Trash2 className="h-4 w-4" />
                                   </Button>
                                 </div>
                               ))}
                             </CardContent>
                         </Disclosure.Panel>
                    </Card>
                )}
           </Disclosure>

           {/* --- Skills Disclosure --- */}
            <Disclosure defaultOpen>
                {({ open }) => (
                    <Card>
                         <Disclosure.Button as={React.Fragment}>
                             <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-muted/50 rounded-t-lg p-4">
                               <CardTitle className="text-lg">المهارات</CardTitle>
                                <div className="flex items-center gap-2">
                                     <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); appendSkill(skillSchema.parse({})); }} // Stop propagation
                                        className="z-10"
                                        aria-label="إضافة مهارة"
                                    >
                                        <PlusCircle className="ml-2 h-4 w-4" />
                                        إضافة
                                    </Button>
                                     <ChevronDown className={clsx("h-5 w-5 transition-transform", open && "rotate-180")} />
                                </div>
                             </CardHeader>
                         </Disclosure.Button>
                         <Disclosure.Panel as={React.Fragment}>
                             <CardContent className="pt-4 space-y-4">
                               <FormDescription>أضف المهارات الهامة ذات الصلة بالوظائف المستهدفة.</FormDescription>
                               {!skillFields || skillFields.length === 0 && (
                                    <p className="text-muted-foreground text-center py-4">لم تتم إضافة أي مهارات بعد.</p>
                               )}
                               {skillFields.map((field, index) => (
                                  <div key={field.id} className="flex items-center gap-2 group">
                                     <FormField
                                       control={form.control}
                                       name={`skills.${index}.name`}
                                       render={({ field }) => (
                                         <FormItem className="flex-grow">
                                           <FormLabel className="sr-only">المهارة</FormLabel>
                                           <FormControl>
                                             <Input placeholder={index === 0 ? "مثال: JavaScript, القيادة, حل المشكلات" : "مهارة أخرى..."} {...field} value={field.value ?? ''}/>
                                           </FormControl>
                                           <FormMessage />
                                         </FormItem>
                                       )}
                                     />
                                     <Button
                                       type="button"
                                       variant="ghost"
                                       size="icon"
                                       onClick={() => removeSkill(index)}
                                        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity w-7 h-7"
                                        aria-label="حذف المهارة"
                                     >
                                       <Trash2 className="h-4 w-4" />
                                     </Button>
                                  </div>
                               ))}
                                {/* AI Skills Button */}
                               <Button
                                     type="button"
                                     variant="ghost"
                                     onClick={handleAISkills}
                                     disabled={isLoadingAISkills || !jobTitle || !suggestSkillsFn}
                                     className="mt-2 text-accent hover:bg-accent/10"
                                     aria-label="اقتراح مهارات بالذكاء الاصطناعي"
                                 >
                                     {isLoadingAISkills ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Wand2 className="ml-2 h-4 w-4" />}
                                     {isLoadingAISkills ? 'جاري الاقتراح...' : 'اقتراح مهارات بالذكاء الاصطناعي'}
                                </Button>

                             </CardContent>
                         </Disclosure.Panel>
                    </Card>
                )}
           </Disclosure>

           <Separator />

           <div className="flex justify-end pb-4">
             <Button type="submit" size="lg" className="bg-primary hover:bg-primary/90" disabled={isSaving}>
                {isSaving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />}
               {isSaving ? 'جاري الحفظ...' : (resumeId ? 'تحديث السيرة الذاتية' : 'حفظ السيرة الذاتية')}
             </Button>
           </div>
         </form>
    </div>
  );
}
