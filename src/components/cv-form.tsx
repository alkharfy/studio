
'use client';

import * as React from 'react';
import { useState, useCallback } from 'react'; // Added useCallback
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useFieldArray, type UseFormReturn, useFormContext } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  // Form, // Correctly REMOVED as context is provided by parent
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
import { Loader2, PlusCircle, Trash2, Wand2, Save } from 'lucide-react'; // Removed LogOut
import { useAuth } from '@/context/AuthContext'; // Import useAuth
import { db } from '@/lib/firebase/config'; // Import db
import { doc, setDoc, collection, serverTimestamp, updateDoc } from 'firebase/firestore'; // Firestore functions
import type { Resume as FirestoreResumeData } from '@/lib/dbTypes'; // Use Firestore specific type alias
import { PdfUploader } from '@/components/pdf-uploader'; // Import PdfUploader
import type { User } from 'firebase/auth'; // Import User type

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
        jobDescriptionForAI: null,
        resumeId: undefined,
    };

    if (!raw) return defaults;

    // Map Firestore data (uses institute, year, title, start, end) to form data (institution, graduationYear, jobTitle, startDate, endDate)
    return {
        resumeId: raw.resumeId,
        title: raw.title ?? defaults.title,
        fullName: raw.personalInfo?.fullName ?? defaults.fullName,
        // Map personalInfo.title to form's jobTitle
        jobTitle: raw.personalInfo?.jobTitle ?? defaults.jobTitle,
        email: raw.personalInfo?.email ?? currentUser?.email ?? defaults.email,
        phone: raw.personalInfo?.phone ?? defaults.phone,
        address: raw.personalInfo?.address ?? defaults.address,
        // Map objective to summary if summary is missing
        summary: raw.summary ?? defaults.summary,
        // Map education fields
        education: (raw.education ?? []).map(edu => ({
            degree: edu.degree ?? '',
            // Map institute to institution
            institution: edu.institution ?? '',
            // Map year to graduationYear
            graduationYear: edu.graduationYear ?? '',
            details: edu.details ?? null, // Keep details
        })).filter(edu => edu.degree || edu.institution || edu.graduationYear), // Filter empty entries
        // Map experience fields
        experience: (raw.experience ?? []).map(exp => ({
            // Map title to jobTitle
            jobTitle: exp.jobTitle ?? '',
            company: exp.company ?? '',
            // Map start to startDate
            startDate: exp.startDate ?? '',
            // Map end to endDate
            endDate: exp.endDate ?? null,
            description: exp.description ?? null,
        })).filter(exp => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description), // Filter empty entries
        // Map skills (handle both string[] and {name: string}[])
        skills: (raw.skills ?? []).map(skill => ({
             // If skill is a string, use it; otherwise, use skill.name
            name: typeof skill === 'string' ? skill : (skill.name ?? ''),
        })).filter(skill => skill.name), // Filter empty entries
        // Ensure languages and hobbies are handled if they exist in FirestoreResumeData
        // languages: (raw.languages ?? []).map(lang => ({ name: lang.name ?? '', level: lang.level ?? '' })), // Example if complex
        // hobbies: (raw.hobbies ?? []), // Example if simple string array
        jobDescriptionForAI: defaults.jobDescriptionForAI,
    };
};
// --- End Normalization Function ---


// Use useFormContext to get the form instance from the parent provider
export function CvForm({ isLoadingCv, handlePdfParsingComplete }: CvFormProps) {
  const form = useFormContext<CvFormData>(); // Get form instance from context
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();
  const { currentUser } = useAuth(); // Get currentUser


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

  // Function to format CV data into a single string for AI
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
            // Note: FirestoreResumeData now includes languages, hobbies, customSections based on dbTypes
            const resumeDataToSave: Omit<FirestoreResumeData, 'createdAt' | 'updatedAt' | 'parsingDone' | 'originalFileName' | 'storagePath'> & { updatedAt: any, createdAt?: any } = {
                userId: currentUser.uid,
                resumeId: values.resumeId || '', // Keep existing ID or empty string for new doc
                title: values.title,
                personalInfo: {
                    fullName: values.fullName,
                    jobTitle: values.jobTitle, // Ensure jobTitle is mapped
                    email: values.email,
                    phone: values.phone,
                    address: values.address,
                },
                summary: values.summary, // Map form's summary
                // Map education fields back to Firestore structure
                education: values.education.map(edu => ({
                    degree: edu.degree || null,
                    institution: edu.institution || null, // Map institution back
                    graduationYear: edu.graduationYear || null, // Map graduationYear back
                    details: edu.details || null,
                })).filter(edu => edu.degree || edu.institution || edu.graduationYear),
                 // Map experience fields back to Firestore structure
                experience: values.experience.map(exp => ({
                    jobTitle: exp.jobTitle || null, // Map jobTitle back
                    company: exp.company || null,
                    startDate: exp.startDate || null, // Map startDate back
                    endDate: exp.endDate || null, // Map endDate back
                    description: exp.description || null,
                })).filter(exp => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description),
                // Map skills back to Firestore structure {name: string | null}[]
                skills: values.skills.map(skill => ({
                    name: skill.name || null,
                })).filter(skill => skill.name),
                // Provide default empty arrays or null for fields not in the form
                languages: [], // TODO: Add form fields if languages need saving
                hobbies: [], // TODO: Add form fields if hobbies need saving
                customSections: [], // TODO: Add form fields if custom sections need saving
                updatedAt: serverTimestamp(),
            };

            let docRef;
            if (values.resumeId) {
                // --- Update existing document ---
                docRef = doc(db, 'users', currentUser.uid, 'resumes', values.resumeId);
                 // Ensure all fields expected by updateDoc are present (especially 'updatedAt')
                 // We can directly use resumeDataToSave here as it includes 'updatedAt'
                await updateDoc(docRef, resumeDataToSave);
                toast({ title: 'تم التحديث', description: 'تم تحديث سيرتك الذاتية بنجاح.' });
                console.log('CV Updated:', values.resumeId);
            } else {
                 // --- Create new document ---
                const resumesCollectionRef = collection(db, 'users', currentUser.uid, 'resumes');
                docRef = doc(resumesCollectionRef); // Generate a new document reference WITH an ID
                resumeDataToSave.resumeId = docRef.id; // Assign the generated ID to the data

                // Create the full FirestoreResumeData object for setDoc
                const fullDataToSave: FirestoreResumeData = {
                    ...resumeDataToSave,
                    parsingDone: false, // Default for manual save
                    originalFileName: null, // Not applicable for manual save
                    storagePath: null, // Not applicable for manual save
                    createdAt: serverTimestamp(), // Add server timestamp for creation
                     // Ensure all required fields from FirestoreResumeData are present or provide defaults
                    languages: resumeDataToSave.languages ?? [],
                    hobbies: resumeDataToSave.hobbies ?? [],
                    customSections: resumeDataToSave.customSections ?? [],
                     // Include userId and resumeId which are now part of resumeDataToSave
                };

                await setDoc(docRef, fullDataToSave); // Use setDoc with the reference containing the ID
                form.setValue('resumeId', docRef.id); // Update the form state with the new ID
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

  // Display loading indicator while fetching CV data
  if (isLoadingCv) {
     return (
       <div className="flex min-h-[calc(100vh-100px)] items-center justify-center p-8">
         <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className='mr-4 text-muted-foreground'>جاري تحميل بيانات السيرة الذاتية...</p>
       </div>
     );
   }

  // Watch the resumeId field to update the button text
  const resumeId = form.watch('resumeId');

  return (
      // Container div for padding and layout control
      <div className="p-4">
          {/* PDF Uploader Section */}
         <div className="mb-8"> {/* Add margin bottom */}
            <PdfUploader onParsingComplete={handlePdfParsingComplete} />
         </div>

         {/* Form element with correct props */}
         <form
           className="space-y-8"
           onSubmit={form.handleSubmit(onSubmit)}
         >
           {/* Personal Information Section */}
           <Card>
             <CardHeader>
               <CardTitle>المعلومات الشخصية</CardTitle>
             </CardHeader>
             <CardContent className="space-y-4">
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
                <FormField
                 control={form.control}
                 name="summary"
                 render={({ field }) => (
                   <FormItem>
                     <FormLabel>الملخص الشخصي</FormLabel>
                     <FormControl>
                       <Textarea
                         placeholder="اكتب نبذة مختصرة عن خبراتك وأهدافك المهنية..."
                         className="resize-y min-h-[100px]"
                         {...field}
                       />
                     </FormControl>
                      <FormDescription>
                         أدخل الوصف الوظيفي أدناه وانقر على "تحسين بالذكاء الاصطناعي" لتحسين هذا الملخص.
                     </FormDescription>
                     <FormMessage />
                   </FormItem>
                 )}
               />
             </CardContent>
           </Card>

          {/* AI Enhancement Section */}
           <Card>
              <CardHeader>
                <CardTitle>تحسين المحتوى بالذكاء الاصطناعي</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
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
                   >
                     {isGenerating ? (
                       <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                     ) : (
                        <Wand2 className="ml-2 h-4 w-4" />
                     )}
                     {isGenerating ? 'جاري التحسين...' : 'تحسين بالذكاء الاصطناعي'}
                   </Button>
              </CardContent>
           </Card>

           {/* Work Experience Section */}
           <Card>
             <CardHeader className="flex flex-row items-center justify-between">
               <CardTitle>الخبرة العملية</CardTitle>
               <Button
                 type="button"
                 variant="ghost"
                 size="sm"
                 onClick={() => appendExperience(experienceSchema.parse({}))}
               >
                 <PlusCircle className="ml-2 h-4 w-4" />
                 إضافة خبرة
               </Button>
             </CardHeader>
             <CardContent className="space-y-6">
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
           </Card>

           {/* Education Section */}
           <Card>
             <CardHeader className="flex flex-row items-center justify-between">
               <CardTitle>التعليم</CardTitle>
               <Button
                 type="button"
                 variant="ghost"
                 size="sm"
                 onClick={() => appendEducation(educationSchema.parse({}))}
               >
                  <PlusCircle className="ml-2 h-4 w-4" />
                  إضافة تعليم
               </Button>
             </CardHeader>
             <CardContent className="space-y-6">
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
           </Card>

           {/* Skills Section */}
           <Card>
             <CardHeader className="flex flex-row items-center justify-between">
               <CardTitle>المهارات</CardTitle>
               <Button
                 type="button"
                 variant="ghost"
                 size="sm"
                  onClick={() => appendSkill(skillSchema.parse({}))}
               >
                  <PlusCircle className="ml-2 h-4 w-4" />
                  إضافة مهارة
               </Button>
             </CardHeader>
             <CardContent className="space-y-2">
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
             </CardContent>
           </Card>

           <Separator />

           <div className="flex justify-end pb-4"> {/* Add padding bottom */}
             <Button type="submit" size="lg" className="bg-primary hover:bg-primary/90" disabled={isSaving}>
                {isSaving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />}
               {isSaving ? 'جاري الحفظ...' : (form.watch('resumeId') ? 'تحديث السيرة الذاتية' : 'حفظ السيرة الذاتية')}
             </Button>
           </div>
         </form>
    </div> // Close the container div
  );
}
