'use client';

import * as React from 'react';
import { useState } from 'react';
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
import { Loader2, PlusCircle, Trash2, Wand2 } from 'lucide-react';

// Define Zod schema for the form
const experienceSchema = z.object({
  jobTitle: z.string().min(1, { message: 'يجب إدخال المسمى الوظيفي' }),
  company: z.string().min(1, { message: 'يجب إدخال اسم الشركة' }),
  startDate: z.string().min(1, { message: 'يجب إدخال تاريخ البدء' }), // Consider using date type if needed
  endDate: z.string().optional(),
  description: z.string().optional(),
});

const educationSchema = z.object({
  degree: z.string().min(1, { message: 'يجب إدخال اسم الشهادة' }),
  institution: z.string().min(1, { message: 'يجب إدخال اسم المؤسسة التعليمية' }),
  graduationYear: z.string().min(1, { message: 'يجب إدخال سنة التخرج' }),
  details: z.string().optional(),
});

const skillSchema = z.object({
  name: z.string().min(1, { message: 'يجب إدخال اسم المهارة' }),
});

const cvSchema = z.object({
  fullName: z.string().min(1, { message: 'يجب إدخال الاسم الكامل' }),
  jobTitle: z.string().min(1, { message: 'يجب إدخال المسمى الوظيفي الحالي أو المرغوب' }),
  email: z.string().email({ message: 'البريد الإلكتروني غير صالح' }),
  phone: z.string().min(1, { message: 'يجب إدخال رقم الهاتف' }),
  address: z.string().optional(),
  summary: z.string().min(10, { message: 'يجب أن يكون الملخص 10 أحرف على الأقل' }),
  experience: z.array(experienceSchema),
  education: z.array(educationSchema),
  skills: z.array(skillSchema),
  jobDescriptionForAI: z.string().optional(), // For AI enhancement
});

type CvFormData = z.infer<typeof cvSchema>;

export default function Home() {
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast } = useToast();

  const form = useForm<CvFormData>({
    resolver: zodResolver(cvSchema),
    defaultValues: {
      fullName: '',
      jobTitle: '',
      email: '',
      phone: '',
      address: '',
      summary: '',
      experience: [{ jobTitle: '', company: '', startDate: '', endDate: '', description: '' }],
      education: [{ degree: '', institution: '', graduationYear: '', details: '' }],
      skills: [{ name: '' }],
      jobDescriptionForAI: '',
    },
    mode: 'onChange', // Validate on change
  });

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
    data.experience.forEach((exp, index) => {
      cvString += `- ${exp.jobTitle} في ${exp.company} (${exp.startDate} - ${exp.endDate || 'الحاضر'})\n`;
      if (exp.description) cvString += `  ${exp.description}\n`;
    });
    cvString += "\n";

    cvString += "التعليم:\n";
    data.education.forEach((edu) => {
      cvString += `- ${edu.degree}, ${edu.institution} (${edu.graduationYear})\n`;
      if (edu.details) cvString += `  ${edu.details}\n`;
    });
    cvString += "\n";

    cvString += "المهارات:\n";
    cvString += data.skills.map(skill => skill.name).join(', ') + '\n';

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

  function onSubmit(values: CvFormData) {
    // Handle final CV submission/saving logic here
    console.log(values);
    toast({
      title: 'تم الحفظ',
      description: 'تم حفظ بيانات السيرة الذاتية (مؤقتًا في الكونسول).',
    });
    // In a real app, you'd save this to Firestore or generate a PDF
  }

  return (
    <div className="container mx-auto p-4 md:p-8">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-primary mb-2">صانع السيرة الذاتية العربي</h1>
        <p className="text-muted-foreground">أنشئ سيرتك الذاتية الاحترافية بسهولة مع تحسينات الذكاء الاصطناعي</p>
      </header>

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
                          <Input type="email" placeholder="example@mail.com" {...field} />
                        </FormControl>
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
                      <Input placeholder="مثال: الرياض، المملكة العربية السعودية" {...field} />
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
                            {...field}
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
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
                onClick={() => appendExperience({ jobTitle: '', company: '', startDate: '', endDate: '', description: '' })}
              >
                <PlusCircle className="ml-2 h-4 w-4" /> {/* Swapped mr to ml */}
                إضافة خبرة
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              {experienceFields.map((field, index) => (
                <div key={field.id} className="space-y-4 p-4 border rounded-md relative">
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
                                <FormLabel>تاريخ الانتهاء (أو اتركه فارغًا للحالي)</FormLabel>
                                <FormControl>
                                  <Input placeholder="مثال: ديسمبر 2022" {...field} />
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
                            <Textarea placeholder="صف مهامك وإنجازاتك الرئيسية..." {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    onClick={() => removeExperience(index)}
                    className="absolute top-2 left-2 w-7 h-7" // Position top-left for RTL
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
                onClick={() => appendEducation({ degree: '', institution: '', graduationYear: '', details: '' })}
              >
                 <PlusCircle className="ml-2 h-4 w-4" /> {/* Swapped mr to ml */}
                 إضافة تعليم
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              {educationFields.map((field, index) => (
                <div key={field.id} className="space-y-4 p-4 border rounded-md relative">
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
                          <Textarea placeholder="مثال: مشروع التخرج، مرتبة الشرف..." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    onClick={() => removeEducation(index)}
                    className="absolute top-2 left-2 w-7 h-7" // Position top-left for RTL
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
                onClick={() => appendSkill({ name: '' })}
              >
                 <PlusCircle className="ml-2 h-4 w-4" /> {/* Swapped mr to ml */}
                 إضافة مهارة
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              <FormDescription>أضف المهارات الهامة ذات الصلة بالوظائف المستهدفة.</FormDescription>
              {skillFields.map((field, index) => (
                 <div key={field.id} className="flex items-center gap-2">
                    <FormField
                      control={form.control}
                      name={`skills.${index}.name`}
                      render={({ field }) => (
                        <FormItem className="flex-grow">
                           {/* Hide label for subsequent items */}
                          {index === 0 && <FormLabel className="sr-only">المهارة</FormLabel>}
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
                       className="text-destructive hover:text-destructive/80 w-7 h-7"
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
            <Button type="submit" size="lg" className="bg-primary hover:bg-primary/90">
              حفظ السيرة الذاتية
            </Button>
             {/* Add Preview/Download button later */}
          </div>
        </form>
      </Form>
    </div>
  );
}
