'use client';

import * as React from 'react';
import { useState, useCallback, useMemo } from 'react';
// import { zodResolver } from '@hookform/resolvers/zod'; // Already in page.tsx
import { useFieldArray, useFormContext } from 'react-hook-form';
import { z } from 'zod'; // Imported Zod
import { Disclosure } from '@headlessui/react';
import clsx from 'clsx';
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
import { Loader2, PlusCircle, Trash2, Wand2, Save, ChevronDown } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { db, auth } from '@/lib/firebase/config';
import { doc, setDoc, collection, serverTimestamp, updateDoc } from 'firebase/firestore';
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes';
import { PdfUploader } from '@/components/pdf-uploader';
import type { User } from 'firebase/auth';
import { getFunctions, httpsCallable, connectFunctionsEmulator, type HttpsCallableResult } from 'firebase/functions';

// Define Zod schema for the form
const experienceSchema = z.object({
  jobTitle: z.string().min(1, "يجب إدخال المسمى الوظيفي").nullable().default(''),
  company: z.string().min(1, "يجب إدخال اسم الشركة").nullable().default(''),
  startDate: z.string().min(1, "يجب إدخال تاريخ البدء").nullable().default(''),
  endDate: z.string().optional().nullable().default(''),
  description: z.string().optional().nullable().default(''),
}).default({});

const educationSchema = z.object({
  degree: z.string().nullable().default(''),
  institution: z.string().nullable().default(''),
  graduationYear: z.string().nullable().default(''),
  details: z.string().optional().nullable().default(''),
}).default({});

const skillSchema = z.object({
  name: z.string().nullable().default(''),
}).default({});


export const cvSchema = z.object({
  resumeId: z.string().optional(),
  title: z.string().min(1, { message: 'يجب إدخال عنوان للسيرة الذاتية' }).default('مسودة السيرة الذاتية'),
  fullName: z.string().min(1, { message: 'يجب إدخال الاسم الكامل' }),
  jobTitle: z.string().min(1, { message: 'يجب إدخال المسمى الوظيفي الحالي أو المرغوب' }),
  email: z.string().email({ message: 'البريد الإلكتروني غير صالح' }).min(1, { message: 'يجب إدخال البريد الإلكتروني' }),
  phone: z.string().min(1, { message: 'يجب إدخال رقم الهاتف' }),
  address: z.string().optional().nullable(),
  summary: z.string().min(10, { message: 'يجب أن يكون الملخص 10 أحرف على الأقل' }),
  experience: z.array(experienceSchema).default([]),
  education: z.array(educationSchema).default([]),
  skills: z.array(skillSchema).default([]),
  yearsExperience: z.number().min(0).optional().nullable(),
  jobDescriptionForAI: z.string().optional().nullable(),
});


export type CvFormData = z.infer<typeof cvSchema>;

interface CvFormProps {
  isLoadingCv: boolean;
}

export const normalizeResumeData = (raw: FirestoreResumeData | null, currentUser: User | null): CvFormData => {
    // Manually define the default structure for CvFormData
    const defaults: CvFormData = {
        title: 'مسودة السيرة الذاتية',
        fullName: '',
        jobTitle: '',
        email: '',
        phone: '',
        address: null, // Optional and nullable
        summary: '',
        experience: [],
        education: [],
        skills: [],
        yearsExperience: null, // Optional and nullable
        jobDescriptionForAI: null, // Optional and nullable
        // resumeId is optional and will be set if data is loaded
    };

    // Override defaults with current user info if available
    if (currentUser) {
      defaults.fullName = currentUser.displayName || defaults.fullName;
      defaults.email = currentUser.email || defaults.email;
    }

    if (!raw) return defaults;

    console.info("[normalizeResumeData] Raw Firestore data:", raw);

    const normalized: CvFormData = {
        ...defaults, // Spread defaults first
        resumeId: raw.resumeId,
        title: raw.title || defaults.title,
        fullName: raw.personalInfo?.fullName || defaults.fullName,
        jobTitle: raw.personalInfo?.jobTitle || defaults.jobTitle,
        email: raw.personalInfo?.email || defaults.email,
        phone: raw.personalInfo?.phone || defaults.phone,
        address: raw.personalInfo?.address || defaults.address,
        summary: raw.summary || raw.objective || defaults.summary, // Use summary, fallback to objective
        education: (raw.education ?? []).map(edu => ({
            degree: edu.degree ?? '',
            institution: edu.institution ?? edu.institute ?? '', // Handle both institution/institute
            graduationYear: edu.graduationYear ?? edu.year ?? '', // Handle both graduationYear/year
            details: edu.details ?? '',
        })).filter(edu => edu.degree || edu.institution || edu.graduationYear),
        experience: (raw.experience ?? []).map(exp => ({
            jobTitle: exp.jobTitle ?? exp.title ?? '', // Handle both jobTitle/title
            company: exp.company ?? '',
            startDate: exp.startDate ?? exp.start ?? '', // Handle both startDate/start
            endDate: exp.endDate ?? exp.end ?? '',
            description: exp.description ?? '',
        })).filter(exp => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description),
        skills: (raw.skills ?? []).map(skill => ({ // Ensure skills are objects {name: string}
            name: typeof skill === 'string' ? skill : (skill?.name ?? ''),
        })).filter(skill => skill.name),
        yearsExperience: raw.yearsExperience ?? defaults.yearsExperience,
        jobDescriptionForAI: raw.jobDescriptionForAI ?? defaults.jobDescriptionForAI,
    };

     console.info("[normalizeResumeData] Normalized form data:", normalized);
    return normalized;
};

export function CvForm({ isLoadingCv }: CvFormProps) {
  const form = useFormContext<CvFormData>();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingAISkills, setIsLoadingAISkills] = useState(false);
  const [isLoadingAISummary, setIsLoadingAISummary] = useState(false);
  const { toast } = useToast();
  const { currentUser } = useAuth();

  const functionsInstance = useMemo(() => {
    if (typeof window !== 'undefined' && auth.app) { // Check auth.app as well
      const functions = getFunctions(auth.app);
      if (process.env.NEXT_PUBLIC_USE_EMULATOR === 'true') {
        try {
          connectFunctionsEmulator(functions, "127.0.0.1", 5001);
          console.info("Connected to Functions Emulator from CvForm.");
        } catch (error: any) {
           if (!(error instanceof Error && error.message.includes('already connected'))) {
             console.error("Error connecting to Functions emulator from CvForm:", error);
           }
        }
      }
      return functions;
    }
    return null;
  }, []);

  const suggestSummaryFn = useMemo(() => functionsInstance ? httpsCallable< { jobTitle: string; yearsExp: number; skills: string[]; lang: string; }, { summary: string } >(functionsInstance, 'suggestSummary') : null, [functionsInstance]);
  const suggestSkillsFn = useMemo(() => functionsInstance ? httpsCallable< { jobTitle: string; max?: number; lang?: string; }, { skills: string[] } >(functionsInstance, 'suggestSkills') : null, [functionsInstance]);


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

  const formatCvForAI = useCallback((data: CvFormData): string => {
    let cvString = `الاسم: ${data.fullName || ''}\n`;
    cvString += `المسمى الوظيفي: ${data.jobTitle || ''}\n`;
    cvString += `البريد الإلكتروني: ${data.email || ''}\n`;
    cvString += `الهاتف: ${data.phone || ''}\n`;
    if (data.address) cvString += `العنوان: ${data.address}\n`;
    cvString += `الملخص: ${data.summary || ''}\n\n`;

    cvString += "الخبرة العملية:\n";
    (data.experience || []).forEach((exp) => {
      cvString += `- ${exp.jobTitle || ''} في ${exp.company || ''} (${exp.startDate || ''} - ${exp.endDate || 'الحاضر'})\n`;
      if (exp.description) cvString += `  ${exp.description}\n`;
    });
    cvString += "\n";

    cvString += "التعليم:\n";
    (data.education || []).forEach((edu) => {
      cvString += `- ${edu.degree || ''}, ${edu.institution || ''} (${edu.graduationYear || ''})\n`;
      if (edu.details) cvString += `  ${edu.details}\n`;
    });
    cvString += "\n";

    cvString += "المهارات:\n";
    cvString += (data.skills || []).map(skill => skill.name).join(', ') + '\n';

    return cvString;
  }, []);

   const handleAISkills = useCallback(async () => {
    if (!suggestSkillsFn) {
        toast({ title: 'خطأ', description: 'خدمة اقتراح المهارات غير متاحة حالياً.', variant: 'destructive' });
        return;
    }
    const jobTitle = form.getValues('jobTitle');
    if (!jobTitle) {
        toast({ title: 'معلومة', description: 'الرجاء إدخال المسمى الوظيفي أولاً لاقتراح المهارات.', variant: 'default' });
        return;
    }
    setIsLoadingAISkills(true);
    try {
      const result: HttpsCallableResult<{ skills: string[] }> = await suggestSkillsFn({
        jobTitle: jobTitle,
        max: 8,
        lang: "ar",
      });

      if (result.data?.skills && Array.isArray(result.data.skills)) {
          const currentSkillNames = form.getValues('skills').map(s => s.name?.toLowerCase()).filter(Boolean);
          const newSkillsToAdd = result.data.skills
             .filter(skill => skill && !currentSkillNames.includes(skill.toLowerCase()))
             .map(skill => ({ name: skill }));

           if (newSkillsToAdd.length > 0) {
                appendSkill(newSkillsToAdd);
                toast({ title: "نجاح", description: "تم اقتراح وإضافة مهارات جديدة بنجاح!" });
            } else {
                 toast({ title: "لا مهارات جديدة", description: "لم يتم العثور على مهارات جديدة لإضافتها.", variant:'default' });
            }
      } else {
           console.warn("Suggest Skills: AI returned no skills or invalid format", result.data);
           toast({ title: "لم يتم العثور على مهارات", description: "لم يتمكن الذكاء الاصطناعي من اقتراح مهارات لهذا المسمى الوظيفي.", variant: 'default' });
      }

    } catch (error: any) {
        console.error('AI Skills Suggestion Error:', error);
        const message = error.code === 'internal' || error.message.includes('internal')
            ? 'حدث خطأ داخلي في الخادم أثناء اقتراح المهارات. الرجاء المحاولة لاحقاً.'
            : error.message || 'حدث خطأ أثناء محاولة اقتراح المهارات.';
        toast({
            title: 'خطأ في اقتراح المهارات',
            description: message,
            variant: 'destructive',
        });
    } finally {
      setIsLoadingAISkills(false);
    }
  }, [suggestSkillsFn, form, toast, appendSkill]);

  const handleAISummary = useCallback(async () => {
      if (!suggestSummaryFn) {
        toast({ title: 'خطأ', description: 'خدمة اقتراح النبذة غير متاحة حالياً.', variant: 'destructive' });
        return;
      }
      const jobTitle = form.getValues('jobTitle');
      const yearsExp = form.getValues('yearsExperience');
      const skills = form.getValues('skills').map(s => s.name).filter(Boolean).slice(0, 5) as string[];

      if (!jobTitle) {
          toast({ title: 'معلومة', description: 'الرجاء إدخال المسمى الوظيفي أولاً لتوليد النبذة.', variant: 'default' });
          return;
      }

      setIsLoadingAISummary(true);
      try {
          const result: HttpsCallableResult<{ summary: string }> = await suggestSummaryFn({
              jobTitle: jobTitle,
              yearsExp: yearsExp ?? 0,
              skills: skills,
              lang: "ar",
          });

         if (result.data?.summary && typeof result.data.summary === 'string') {
              form.setValue('summary', result.data.summary, { shouldValidate: true });
              toast({ title: "نجاح", description: "تم توليد النبذة بنجاح!" });
          } else {
               console.warn("Suggest Summary: AI returned no summary or invalid format", result.data);
               toast({ title: "لم يتم إنشاء النبذة", description: "لم يتمكن الذكاء الاصطناعي من توليد نبذة.", variant: 'default' });
          }

      } catch (error: any) {
          console.error('AI Summary Generation Error:', error);
          const message = error.code === 'internal' || error.message.includes('internal')
              ? 'حدث خطأ داخلي في الخادم أثناء توليد النبذة. الرجاء المحاولة لاحقاً.'
              : error.message || 'حدث خطأ أثناء محاولة توليد النبذة.';
          toast({
              title: 'خطأ في توليد النبذة',
              description: message,
              variant: 'destructive',
          });
      } finally {
          setIsLoadingAISummary(false);
      }
  }, [suggestSummaryFn, form, toast]);


  const handleEnhanceContent = useCallback(async () => {
    const jobDesc = form.getValues('jobDescriptionForAI');
    const currentSummary = form.getValues('summary');
    const cvContent = formatCvForAI(form.getValues());

    if (!jobDesc) {
      toast({
        title: 'معلومة',
        description: 'الرجاء إدخال وصف وظيفي لتحسين المحتوى.',
        variant: 'default',
      });
      return;
    }

    setIsGenerating(true);
    try {
       const inputData: EnhanceCvContentInput = {
         cvContent: `الملخص الحالي: ${currentSummary || ''}\n\nالسيرة الذاتية الكاملة:\n${cvContent}`,
         jobDescription: jobDesc,
       };
      const result = await enhanceCvContent(inputData);

       if (result.enhancedCvContent) {
           form.setValue('summary', result.enhancedCvContent, { shouldValidate: true });
           toast({
             title: 'نجاح',
             description: 'تم تحسين ملخص السيرة الذاتية بنجاح!',
           });
       } else {
            console.warn("Enhance Content: AI returned no enhanced content.");
            toast({
                title: 'لم يتم التحسين',
                description: 'لم يتمكن الذكاء الاصطناعي من تحسين الملخص.',
                variant: 'default',
            });
       }
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
  }, [form, formatCvForAI, toast]);

    const onSubmit = useCallback(async (values: CvFormData) => {
        if (!currentUser) {
            toast({ title: 'خطأ', description: 'يجب تسجيل الدخول لحفظ السيرة الذاتية.', variant: 'destructive' });
            return;
        }
        setIsSaving(true);
         console.info("[onSubmit] Form values being saved:", values);
        try {
            const resumeDataToSave: Partial<FirestoreResumeData> = { // Use Partial to allow resumeId to be added later
                userId: currentUser.uid,
                // resumeId: values.resumeId || '', // resumeId will be set if new or kept if existing
                title: values.title || 'مسودة السيرة الذاتية',
                personalInfo: {
                    fullName: values.fullName || null,
                    jobTitle: values.jobTitle || null,
                    email: values.email || null,
                    phone: values.phone || null,
                    address: values.address || null,
                },
                summary: values.summary || null,
                education: (values.education || []).map(edu => ({
                    degree: edu.degree || null,
                    institution: edu.institution || null,
                    graduationYear: edu.graduationYear || null,
                    details: edu.details || null,
                })).filter(edu => edu.degree || edu.institution || edu.graduationYear),
                experience: (values.experience || []).map(exp => ({
                    jobTitle: exp.jobTitle || null,
                    company: exp.company || null,
                    startDate: exp.startDate || null,
                    endDate: exp.endDate || null,
                    description: exp.description || null,
                })).filter(exp => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description),
                skills: (values.skills || []).map(skill => ({
                    name: skill.name || null,
                })).filter(skill => skill.name),
                // Ensure all fields from FirestoreResumeData are present or explicitly null/undefined
                languages: [], // Example, ensure these are handled if they can come from `values`
                hobbies: [],
                customSections: [],
                yearsExperience: values.yearsExperience ?? null,
                jobDescriptionForAI: values.jobDescriptionForAI ?? null,
                updatedAt: serverTimestamp(),
                // parsingDone, storagePath, originalFileName, createdAt are handled based on new/existing
            };

            let docRef;
            if (values.resumeId) {
                docRef = doc(db, 'users', currentUser.uid, 'resumes', values.resumeId);
                await updateDoc(docRef, resumeDataToSave as FirestoreResumeData); // Cast to full type for update
                toast({ title: 'تم التحديث', description: 'تم تحديث سيرتك الذاتية بنجاح.' });
                console.info('[onSubmit] CV Updated:', values.resumeId);
            } else {
                const resumesCollectionRef = collection(db, 'users', currentUser.uid, 'resumes');
                docRef = doc(resumesCollectionRef); // Auto-generate ID for new resume
                const newResumeId = docRef.id;

                const fullDataToSave: FirestoreResumeData = {
                    ...(resumeDataToSave as Omit<FirestoreResumeData, 'resumeId' | 'createdAt' | 'parsingDone' | 'storagePath' | 'originalFileName'>), // Cast carefully
                    resumeId: newResumeId,
                    parsingDone: false, // New manual entry, no PDF parsing
                    storagePath: null,
                    originalFileName: null,
                    createdAt: serverTimestamp(),
                };
                await setDoc(docRef, fullDataToSave);
                form.setValue('resumeId', newResumeId); // Update form state with the new ID
                toast({ title: 'تم الحفظ', description: 'تم حفظ سيرتك الذاتية الجديدة بنجاح.' });
                console.info('[onSubmit] CV Saved with new ID:', newResumeId);
            }

        } catch (error) {
            console.error('[onSubmit] Error saving CV:', error);
            toast({
                title: 'خطأ في الحفظ',
                description: 'لم نتمكن من حفظ السيرة الذاتية. الرجاء المحاولة مرة أخرى.',
                variant: 'destructive',
            });
        } finally {
            setIsSaving(false);
        }
    }, [currentUser, toast, form]);

  if (isLoadingCv) {
     return (
       <div className="flex min-h-[calc(100vh-100px)] items-center justify-center p-8">
         <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className='mr-4 text-muted-foreground'>
              جاري تحميل البيانات أو معالجة الملف...
            </p>
       </div>
     );
   }

  const resumeId = form.watch('resumeId');
  const jobTitleValue = form.watch('jobTitle');
  const jobDescriptionForAIValue = form.watch('jobDescriptionForAI');

  return (
      <div className="p-4">
         <div className="mb-8">
            <PdfUploader />
         </div>

         <form
           className="space-y-8"
           onSubmit={form.handleSubmit(onSubmit)}
         >
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
                         <CardContent className="pt-4 space-y-4">
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
                                       <Input type="email" placeholder="example@mail.com" {...field} readOnly={!!currentUser?.email} className={currentUser?.email ? 'cursor-not-allowed opacity-70' : ''}/>
                                     </FormControl>
                                      {currentUser?.email && <FormDescription>لا يمكن تغيير البريد الإلكتروني المسجل به.</FormDescription>}
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
                         </CardContent>
                     </Disclosure.Panel>
                 </Card>
               )}
            </Disclosure>


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
                             <CardContent className="pt-4 space-y-4">
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
                                <Button
                                     type="button"
                                     variant="ghost"
                                     onClick={handleAISummary}
                                     disabled={isLoadingAISummary || !jobTitleValue || !suggestSummaryFn}
                                     className="mt-2 text-accent hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
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

           <Disclosure defaultOpen>
                {({ open }) => (
                    <Card>
                        <Disclosure.Button as={React.Fragment}>
                            <CardHeader className="flex flex-row items-center justify-between cursor-pointer hover:bg-muted/50 rounded-t-lg p-4">
                                <CardTitle className="text-lg">تحسين المحتوى بالذكاء الاصطناعي</CardTitle>
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
                                             سيقوم الذكاء الاصطناعي باستخدام هذا الوصف لتحسين محتوى الملخص ليتناسب مع الوظيفة.
                                         </FormDescription>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                  <Button
                                     type="button"
                                     onClick={handleEnhanceContent}
                                     disabled={isGenerating || !jobDescriptionForAIValue}
                                     className="bg-accent hover:bg-accent/90 text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                                     aria-label="تحسين الملخص بناءً على الوصف الوظيفي"
                                   >
                                     {isGenerating ? (
                                       <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                                     ) : (
                                        <Wand2 className="ml-2 h-4 w-4" />
                                     )}
                                     {isGenerating ? 'جاري التحسين...' : 'تحسين الملخص للوظيفة'}
                                   </Button>
                              </CardContent>
                         </Disclosure.Panel>
                    </Card>
                )}
           </Disclosure>

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
                                        onClick={(e) => { e.stopPropagation(); appendExperience(experienceSchema.parse({jobTitle: '', company: '', startDate: ''})); }}
                                        className="z-10"
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
                                {experienceFields.length === 0 && (
                                     <p className="text-muted-foreground text-center py-4">لم تتم إضافة أي خبرة عملية بعد.</p>
                                )}
                               {experienceFields.map((field, index) => (
                                 <div key={field.id} className="space-y-4 p-4 border rounded-md relative group">
                                    <FormField
                                       control={form.control}
                                       name={`experience.${index}.jobTitle`}
                                       render={({ field: formField }) => ( 
                                         <FormItem>
                                           <FormLabel>المسمى الوظيفي</FormLabel>
                                           <FormControl>
                                             <Input placeholder="مثال: مطور واجهة أمامية" {...formField} value={formField.value ?? ''} />
                                           </FormControl>
                                           <FormMessage />
                                         </FormItem>
                                       )}
                                     />
                                      <FormField
                                       control={form.control}
                                       name={`experience.${index}.company`}
                                       render={({ field: formField }) => (
                                         <FormItem>
                                           <FormLabel>الشركة</FormLabel>
                                           <FormControl>
                                             <Input placeholder="مثال: شركة تقنية ناشئة" {...formField} value={formField.value ?? ''} />
                                           </FormControl>
                                           <FormMessage />
                                         </FormItem>
                                       )}
                                     />
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                          <FormField
                                             control={form.control}
                                             name={`experience.${index}.startDate`}
                                             render={({ field: formField }) => (
                                               <FormItem>
                                                 <FormLabel>تاريخ البدء</FormLabel>
                                                 <FormControl>
                                                   <Input placeholder="مثال: يناير 2020" {...formField} value={formField.value ?? ''} />
                                                 </FormControl>
                                                 <FormMessage />
                                               </FormItem>
                                             )}
                                           />
                                           <FormField
                                             control={form.control}
                                             name={`experience.${index}.endDate`}
                                              render={({ field: formField }) => (
                                               <FormItem>
                                                 <FormLabel>تاريخ الانتهاء (اتركه فارغًا للحالي)</FormLabel>
                                                 <FormControl>
                                                   <Input placeholder="مثال: ديسمبر 2022" {...formField} value={formField.value ?? ''} />
                                                 </FormControl>
                                                 <FormMessage />
                                               </FormItem>
                                             )}
                                           />
                                      </div>
                                      <FormField
                                       control={form.control}
                                       name={`experience.${index}.description`}
                                        render={({ field: formField }) => (
                                         <FormItem>
                                           <FormLabel>الوصف (اختياري)</FormLabel>
                                           <FormControl>
                                              <Textarea
                                                 placeholder="صف مهامك وإنجازاتك الرئيسية..."
                                                 className="min-h-[80px]"
                                                 {...formField}
                                                 value={formField.value ?? ''}
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
                                        onClick={(e) => { e.stopPropagation(); appendEducation(educationSchema.parse({})); }}
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
                               {educationFields.length === 0 && (
                                  <p className="text-muted-foreground text-center py-4">لم تتم إضافة أي مؤهلات علمية بعد.</p>
                               )}
                               {educationFields.map((field, index) => (
                                 <div key={field.id} className="space-y-4 p-4 border rounded-md relative group">
                                   <FormField
                                     control={form.control}
                                     name={`education.${index}.degree`}
                                     render={({ field: formField }) => (
                                       <FormItem>
                                         <FormLabel>الشهادة أو الدرجة العلمية</FormLabel>
                                         <FormControl>
                                           <Input placeholder="مثال: بكالوريوس علوم الحاسب" {...formField} value={formField.value ?? ''} />
                                         </FormControl>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                    <FormField
                                     control={form.control}
                                     name={`education.${index}.institution`}
                                     render={({ field: formField }) => (
                                       <FormItem>
                                         <FormLabel>المؤسسة التعليمية</FormLabel>
                                         <FormControl>
                                           <Input placeholder="مثال: جامعة الملك سعود" {...formField} value={formField.value ?? ''} />
                                         </FormControl>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                   <FormField
                                     control={form.control}
                                     name={`education.${index}.graduationYear`}
                                     render={({ field: formField }) => (
                                       <FormItem>
                                         <FormLabel>سنة التخرج</FormLabel>
                                         <FormControl>
                                           <Input placeholder="مثال: 2019" {...formField} value={formField.value ?? ''} />
                                         </FormControl>
                                         <FormMessage />
                                       </FormItem>
                                     )}
                                   />
                                   <FormField
                                     control={form.control}
                                     name={`education.${index}.details`}
                                      render={({ field: formField }) => (
                                       <FormItem>
                                         <FormLabel>تفاصيل إضافية (اختياري)</FormLabel>
                                         <FormControl>
                                            <Textarea
                                             placeholder="مثال: مشروع التخرج، مرتبة الشرف..."
                                             className="min-h-[80px]"
                                             {...formField}
                                              value={formField.value ?? ''}
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
                                        onClick={(e) => { e.stopPropagation(); appendSkill(skillSchema.parse({})); }}
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
                               {skillFields.length === 0 && (
                                    <p className="text-muted-foreground text-center py-4">لم تتم إضافة أي مهارات بعد.</p>
                               )}
                               {skillFields.map((field, index) => (
                                  <div key={field.id} className="flex items-center gap-2 group">
                                     <FormField
                                       control={form.control}
                                       name={`skills.${index}.name`}
                                       render={({ field: formField }) => (
                                         <FormItem className="flex-grow">
                                           <FormLabel className="sr-only">المهارة</FormLabel>
                                           <FormControl>
                                             <Input placeholder={index === 0 ? "مثال: JavaScript, القيادة, حل المشكلات" : "مهارة أخرى..."} {...formField} value={formField.value ?? ''}/>
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
                               <Button
                                     type="button"
                                     variant="ghost"
                                     onClick={handleAISkills}
                                     disabled={isLoadingAISkills || !jobTitleValue || !suggestSkillsFn}
                                     className="mt-2 text-accent hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
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

