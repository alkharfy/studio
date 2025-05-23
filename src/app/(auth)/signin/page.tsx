'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation'; // Use next/navigation for App Router
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react'; // Keep Loader2

// Define Zod schema for the sign-in form
const signInSchema = z.object({
  email: z.string().email({ message: 'الرجاء إدخال بريد إلكتروني صالح' }),
  password: z.string().min(1, { message: 'الرجاء إدخال كلمة المرور' }),
});

type SignInFormData = z.infer<typeof signInSchema>;

// Inline SVG for Google icon
const GoogleIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="24px" height="24px">
    <path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/>
    <path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/>
    <path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/>
    <path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.574l6.19,5.238C39.99,36.62,44,31.134,44,24C44,22.659,43.862,21.35,43.611,20.083z"/>
  </svg>
);


export default function SignInPage() {
  const { signInWithEmail, signInWithGoogle, loading: authLoading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = React.useState(false); // Local loading state for form submission

  const form = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const onSubmit = async (data: SignInFormData) => {
    setIsSubmitting(true);
    const user = await signInWithEmail(data);
    if (user) {
      router.push('/'); // Redirect to dashboard or home on success
    }
    // Error handling is done within signInWithEmail via toast
    setIsSubmitting(false);
  };

   const handleGoogleSignIn = async () => {
     setIsSubmitting(true); // Also set loading for Google sign-in attempt
     const user = await signInWithGoogle();
     if (user) {
       router.push('/'); // Redirect to dashboard or home on success
     }
     // Error handling is done within signInWithGoogle via toast
      setIsSubmitting(false);
   };

   const isLoading = authLoading || isSubmitting;


  return (
    <Card className="mx-auto max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">تسجيل الدخول</CardTitle>
        <CardDescription>
          أدخل بريدك الإلكتروني وكلمة المرور للوصول إلى حسابك
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">البريد الإلكتروني</Label>
            <Input
              id="email"
              type="email"
              placeholder="mail@example.com"
              required
              {...form.register('email')}
              aria-invalid={form.formState.errors.email ? 'true' : 'false'}
              disabled={isLoading}
            />
            {form.formState.errors.email && (
              <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">كلمة المرور</Label>
              {/* Optional: Add Forgot Password link here */}
              {/* <Link href="/forgot-password" className="text-sm text-primary hover:underline">
                نسيت كلمة المرور؟
              </Link> */}
            </div>
            <Input
              id="password"
              type="password"
              required
              {...form.register('password')}
              aria-invalid={form.formState.errors.password ? 'true' : 'false'}
               disabled={isLoading}
            />
             {form.formState.errors.password && (
              <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
             {isLoading && !authLoading && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
             تسجيل الدخول
          </Button>
        </form>
         <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">
              أو أكمل بواسطة
            </span>
          </div>
        </div>
        <Button variant="outline" className="w-full" onClick={handleGoogleSignIn} disabled={isLoading}>
           {isLoading && !authLoading && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
           {!isLoading && <GoogleIcon /> } {/* Display icon when not loading */}
          الدخول باستخدام جوجل
        </Button>
      </CardContent>
      <CardFooter className="text-center text-sm">
        ليس لديك حساب؟{' '}
        <Link href="/signup" className="text-primary hover:underline mr-1">
          إنشاء حساب
        </Link>
      </CardFooter>
    </Card>
  );
}
