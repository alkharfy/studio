
'use client';

import * as React from 'react';
import { useState, useCallback } from 'react'; // Added useCallback
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
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
import { Loader2, PlusCircle, Trash2, Wand2, LogOut, Save } from 'lucide-react'; // Added Save
import { ProtectedRoute } from '@/components/ProtectedRoute'; // Import ProtectedRoute
import { useAuth } from '@/context/AuthContext'; // Import useAuth
import { db } from '@/lib/firebase/config'; // Import db
import { doc, setDoc, collection, serverTimestamp, getDocs, query, where, orderBy, limit, updateDoc } from 'firebase/firestore'; // Firestore functions
import type { Resume } from '@/lib/dbTypes'; // Resume type
import { PdfUploader } from '@/components/pdf-uploader'; // Import PdfUploader

// Define Zod schema for the form
const experienceSchema = z.object({
  jobTitle: z.string().min(1, { message: 'يجب إدخال المسمى الوظيفي' }),
  company: z.string().min(1, { message: 'يجب إدخال اسم الشركة' }),
  startDate: z.string().min(1, { message: 'يجب إدخال تاريخ البدء' }), // Consider using date type if needed
  endDate: z.string().optional().nullable(), // Allow null
  description: z.string().optional().nullable(), // Allow null
}).default({ jobTitle: '', company: '', startDate: '', endDate: '', description: '' }); // Add default


const educationSchema = z.object({
  degree: z.string().min(1, { message: 'يجب إدخال اسم الشهادة' }),
  institution: z.string().min(1, { message: 'يجب إدخال اسم المؤسسة التعليمية' }),
  graduationYear: z.string().min(1, { message: 'يجب إدخال سنة التخرج' }),
  details: z.string().optional().nullable(), // Allow null
}).default({ degree: '', institution: '', graduationYear: '', details: '' }); // Add default


const skillSchema = z.object({
  name: z.string().min(1, { message: 'يجب إدخال اسم المهارة' }),
}).default({ name: '' }); // Add default

const cvSchema = z.object({
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


type CvFormData = z.infer<typeof cvSchema>;

 function CvBuilderPageContent() { // Renamed original content to a sub-component
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false); // Added saving state
  const [isLoadingCv, setIsLoadingCv] = useState(true); // State for loading initial CV
  const { toast } = useToast();
  const { signOut, currentUser } = useAuth(); // Get signOut and currentUser

  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    // Default values are set by the schema or loaded from Firestore
    // Provide initial empty strings for required fields to satisfy Zod schema
    defaultValues: {
        title: 'مسودة السيرة الذاتية',
        fullName: '',
        jobTitle: '',
        email: '',
        phone: '',
        summary: '',
        address: null,
        experience: [],
        education: [],
        skills: [],
        jobDescriptionForAI: null,
        resumeId: undefined,
    },
    mode: 'onChange', // Validate on change
  });

   // Function to load the most recent CV for the user
   const loadMostRecentCv = useCallback(async (userId: string) => {
    setIsLoadingCv(true);
    try {
        const resumesRef = collection(db, 'users', userId, 'resumes');
        const q = query(resumesRef, orderBy('updatedAt', 'desc'), limit(1));
        const querySnapshot = await getDocs(q);

        if (!querySnapshot.empty) {
            const cvDoc = querySnapshot.docs[0];
            const cvData = cvDoc.data() as Resume;

             // Ensure arrays are not undefined before resetting
             // Use schema parse to ensure data conforms and defaults are applied
             const formData = cvSchema.parse({
                ...cvData.personalInfo, // Spread personalInfo
                title: cvData.title || 'مسودة السيرة الذاتية',
                summary: cvData.summary || '',
                experience: cvData.experience || [],
                education: cvData.education || [],
                skills: cvData.skills || [],
                jobDescriptionForAI: null, // Reset AI field on load
                resumeId: cvDoc.id, // Store the loaded document ID
             });

            form.reset(formData);
            console.log("Loaded CV:", cvDoc.id, formData);
        } else {
            // No existing CV, reset with defaults and user info
             console.log("No existing CV found, using defaults.");
             // Reset with schema defaults + user info
             form.reset({
                 title: 'مسودة السيرة الذاتية',
                 fullName: currentUser?.displayName || '',
                 jobTitle: '', // No default job title
                 email: currentUser?.email || '',
                 phone: '', // No default phone
                 address: null,
                 summary: '', // No default summary
                 experience: [],
                 education: [],
                 skills: [],
                 jobDescriptionForAI: null,
                 resumeId: undefined,
            });
        }
    } catch (error) {
        console.error('Error loading CV:', error);
        toast({
            title: 'خطأ',
            description: 'لم نتمكن من تحميل بيانات السيرة الذاتية.',
            variant: 'destructive',
        });
        // Reset with defaults on error
         form.reset({
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
        });
    } finally {
        setIsLoadingCv(false);
    }
   }, [currentUser, form, toast]); // Dependencies


   // Effect to load CV when currentUser is available
   React.useEffect(() => {
      if (currentUser?.uid) {
        loadMostRecentCv(currentUser.uid);
      } else {
          // Handle case where user is not logged in (e.g., clear form or show login prompt)
          // For now, we just ensure loading is false if there's no user
          setIsLoadingCv(false);
           form.reset({ // Reset to empty defaults if no user
                title: 'مسودة السيرة الذاتية',
                fullName: '',
                jobTitle: '',
                email: '',
                phone: '',
                summary: '',
                address: null,
                experience: [],
                education: [],
                skills: [],
                jobDescriptionForAI: null,
                resumeId: undefined,
           });
      }
   }, [currentUser, loadMostRecentCv, form]); // Load when user changes


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
    (data.experience || []).forEach((exp) => { // Handle potentially undefined array
      cvString += `- ${exp.jobTitle} في ${exp.company} (${exp.startDate} - ${exp.endDate || 'الحاضر'})\n`;
      if (exp.description) cvString += `  ${exp.description}\n`;
    });
    cvString += "\n";

    cvString += "التعليم:\n";
    (data.education || []).forEach((edu) => { // Handle potentially undefined array
      cvString += `- ${edu.degree}, ${edu.institution} (${edu.graduationYear})\n`;
      if (edu.details) cvString += `  ${edu.details}\n`;
    });
    cvString += "\n";

    cvString += "المهارات:\n";
    cvString += (data.skills || []).map(skill => skill.name).join(', ') + '\n'; // Handle potentially undefined array

    return cvString;
  };

  const handleEnhanceContent = async () => {
    const jobDesc = form.getValues('jobDescriptionForAI');
    const currentSummary = form.getValues('summary'); // Example: Enhance summary
    const cvContent = formatCvForAI(form.getValues()); // Get full CV context

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
         // Pass relevant parts or the whole formatted CV
         // Let's try enhancing the summary based on the job description and full CV context
         cvContent: `الملخص الحالي: ${currentSummary}\n\nالسيرة الذاتية الكاملة:\n${cvContent}`,
         jobDescription: jobDesc,
       };
      const result = await enhanceCvContent(inputData);
      // Assuming the AI returns the enhanced summary in 'enhancedCvContent'
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

   // Function to handle data population from PDF Uploader
   const handlePdfParsingComplete = (parsedData: Partial<Resume>) => {
     console.log("Received parsed data:", parsedData);
     // Merge parsed data with existing form data, prioritizing parsed data
     // Use schema validation/parsing to ensure data integrity
     try {
       const currentValues = form.getValues();
        // Prepare data for parsing, ensuring required fields from parsedData or currentUser exist
        const dataToParse = {
            title: parsedData.title || currentValues.title || 'مسودة مستخرجة', // Provide a default title
            fullName: parsedData.personalInfo?.fullName ?? currentValues.fullName ?? currentUser?.displayName ?? '',
            jobTitle: parsedData.personalInfo?.jobTitle ?? currentValues.jobTitle ?? '',
            email: currentUser?.email || parsedData.personalInfo?.email || currentValues.email || '', // Prioritize logged-in user email
            phone: parsedData.personalInfo?.phone ?? currentValues.phone ?? '',
            address: parsedData.personalInfo?.address ?? currentValues.address ?? null,
            summary: parsedData.summary ?? currentValues.summary ?? '',
            experience: parsedData.experience || currentValues.experience || [],
            education: parsedData.education || currentValues.education || [],
            skills: parsedData.skills || currentValues.skills || [],
            jobDescriptionForAI: currentValues.jobDescriptionForAI, // Keep existing AI description
            resumeId: currentValues.resumeId, // Preserve current resume ID if editing
        };

       const mergedData = cvSchema.parse(dataToParse);

         form.reset(mergedData);
         toast({
             title: "تم ملء النموذج",
             description: "تم تحديث النموذج بالبيانات المستخرجة. الرجاء المراجعة والحفظ.",
         });
     } catch (error) {
         console.error("Error merging parsed data:", error);
         toast({
             title: "خطأ في البيانات",
             description: `حدث خطأ أثناء دمج البيانات المستخرجة. ${error instanceof z.ZodError ? error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') : 'قد تحتاج إلى إدخالها يدويًا.'}`,
             variant: "destructive",
         });
     }
   };


  async function onSubmit(values: CvFormData) {
      if (!currentUser) {
          toast({ title: 'خطأ', description: 'يجب تسجيل الدخول لحفظ السيرة الذاتية.', variant: 'destructive' });
          return;
      }
      setIsSaving(true);
      try {
          const resumeData: Omit<Resume, 'createdAt' | 'updatedAt'> & { updatedAt: any, createdAt?: any } = { // Type for Firestore data
                userId: currentUser.uid,
                resumeId: values.resumeId || '', // Will be set below if new
                title: values.title,
                personalInfo: {
                    fullName: values.fullName,
                    jobTitle: values.jobTitle,
                    email: values.email,
                    phone: values.phone,
                    address: values.address,
                },
                summary: values.summary,
                 // Ensure arrays are passed correctly, even if empty
                experience: values.experience || [],
                education: values.education || [],
                skills: values.skills || [],
                 // Add other fields from Resume type if they exist in the form
                 languages: [], // Example: Add if you have a languages field
                 hobbies: [],   // Example: Add if you have a hobbies field
                 customSections: [], // Example: Add if you have custom sections
                 updatedAt: serverTimestamp(), // Update timestamp
          };

           let docRef;
           if (values.resumeId) {
               // Update existing document
               docRef = doc(db, 'users', currentUser.uid, 'resumes', values.resumeId);
               await updateDoc(docRef, resumeData);
               toast({ title: 'تم التحديث', description: 'تم تحديث سيرتك الذاتية بنجاح.' });
               console.log('CV Updated:', values.resumeId);
           } else {
               // Create new document
               const resumesCollectionRef = collection(db, 'users', currentUser.uid, 'resumes');
               docRef = doc(resumesCollectionRef); // Auto-generate ID
               resumeData.resumeId = docRef.id; // Store the generated ID
               resumeData.createdAt = serverTimestamp(); // Add createdAt for new docs
               await setDoc(docRef, resumeData);
                form.setValue('resumeId', docRef.id); // Update form state with the new ID
               toast({ title: 'تم الحفظ', description: 'تم حفظ سيرتك الذاتية بنجاح.' });
                console.log('CV Saved:', docRef.id);
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
       <div className="flex min-h-[calc(100vh-100px)] items-center justify-center">
         <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className='mr-4 text-muted-foreground'>جاري تحميل بيانات السيرة الذاتية...</p>
       </div>
     );
   }

  // Watch the resumeId field to update the button text
  const resumeId = form.watch('resumeId');


  return (
     <div className="container mx-auto p-4 md:p-8">
      <header className="mb-8 flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="text-center sm:text-right flex-grow"> {/* Adjusted alignment */}
          <h1 className="text-3xl font-bold text-primary mb-2">صانع السيرة الذاتية العربي</h1>
          <p className="text-muted-foreground">أنشئ سيرتك الذاتية الاحترافية بسهولة مع تحسينات الذكاء الاصطناعي</p>
        </div>
         {currentUser && (
             <div className='flex items-center gap-2'>
                {/* Display current CV title being edited */}
                 <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem className="w-48"> {/* Limit width */}
                        {/* <FormLabel className='text-xs text-muted-foreground'>عنوان السيرة</FormLabel> */}
                        <FormControl>
                          <Input placeholder="عنوان السيرة الذاتية" {...field} className="h-9 text-sm"/>
                        </FormControl>
                        <FormMessage className="text-xs"/>
                      </FormItem>
                    )}
                  />
                <Button variant="ghost" onClick={signOut} size="sm">
                    <LogOut className="ml-2 h-4 w-4" />
                    تسجيل الخروج
                </Button>
             </div>
         )}
      </header>

        {/* PDF Uploader Section */}
        <div className="mb-8">
           <PdfUploader onParsingComplete={handlePdfParsingComplete} />
        </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
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
                           {/* Make email read-only if logged in */}
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
                      {/* Handle null value */}
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
                             // Handle null value for textarea
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
                       <Wand2 className="ml-2 h-4 w-4" /> // Swapped mr to ml for RTL
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
                onClick={() => appendExperience(experienceSchema.parse({}))} // Use schema default
              >
                <PlusCircle className="ml-2 h-4 w-4" /> {/* Swapped mr to ml */}
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
                            <Input placeholder="مثال: مطور واجهة أمامية" {...field} />
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
                            <Input placeholder="مثال: شركة تقنية ناشئة" {...field} />
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
                                  {/* Consider using a date picker component */}
                                  <Input placeholder="مثال: يناير 2020" {...field} />
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
                                   {/* Handle null value */}
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
                                // Handle null value by providing empty string if null/undefined
                                value={field.value ?? ''}
                                />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  <Button
                    type="button"
                    variant="ghost" // Changed to ghost for less visual noise
                    size="icon"
                    onClick={() => removeExperience(index)}
                    className="absolute top-2 left-2 w-7 h-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity" // Position top-left for RTL, hide until hover
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
                onClick={() => appendEducation(educationSchema.parse({}))} // Use schema default
              >
                 <PlusCircle className="ml-2 h-4 w-4" /> {/* Swapped mr to ml */}
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
                          <Input placeholder="مثال: بكالوريوس علوم الحاسب" {...field} />
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
                          <Input placeholder="مثال: جامعة الملك سعود" {...field} />
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
                           {/* Consider using a year picker */}
                          <Input placeholder="مثال: 2019" {...field} />
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
                             // Handle null value
                             value={field.value ?? ''}
                            />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                 <Button
                    type="button"
                    variant="ghost" // Changed to ghost
                    size="icon"
                    onClick={() => removeEducation(index)}
                    className="absolute top-2 left-2 w-7 h-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity" // Position top-left for RTL, hide until hover
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
                 onClick={() => appendSkill(skillSchema.parse({}))} // Use schema default
              >
                 <PlusCircle className="ml-2 h-4 w-4" /> {/* Swapped mr to ml */}
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
                           {/* Hide label for subsequent items */}
                          <FormLabel className="sr-only">المهارة</FormLabel>
                          <FormControl>
                            <Input placeholder={index === 0 ? "مثال: JavaScript, القيادة, حل المشكلات" : "مهارة أخرى..."} {...field} />
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

          <div className="flex justify-end">
            <Button type="submit" size="lg" className="bg-primary hover:bg-primary/90" disabled={isSaving}>
               {isSaving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />}
              {isSaving ? 'جاري الحفظ...' : (resumeId ? 'تحديث السيرة الذاتية' : 'حفظ السيرة الذاتية')}
            </Button>
             {/* Add Preview/Download button later */}
          </div>
        </form>
      </Form>
    </div>
  );
}


export default function Home() {
  // Wrap the CV builder content with ProtectedRoute
  return (
    <ProtectedRoute>
      <CvBuilderPageContent />
    </ProtectedRoute>
  );
}

    
