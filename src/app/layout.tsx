
import type { Metadata } from 'next';
import { Cairo } from 'next/font/google'; // Import Cairo font
import './globals.css';
import { cn } from '@/lib/utils';
import { Toaster } from '@/components/ui/toaster'; // Import Toaster
import { AuthProvider } from '@/context/AuthContext'; // Import AuthProvider

// Configure Cairo font
const cairo = Cairo({
  subsets: ['arabic', 'latin'], // Include Arabic subset
  variable: '--font-cairo', // Set CSS variable
});

export const metadata: Metadata = {
  title: 'Arabic CV Architect', // Update title
  description: 'Build your professional CV in Arabic with AI enhancements.', // Update description
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Set lang="ar-EG" and dir="rtl"
    <html lang="ar-EG" dir="rtl">
      <body
        className={cn(
          'min-h-screen bg-background font-sans antialiased',
          cairo.variable // Apply Cairo font variable
        )}
      >
         <AuthProvider> {/* Wrap children with AuthProvider */}
            {/* The main layout structure (grid/flex) is now inside page.tsx */}
            {children}
            <Toaster /> {/* Add Toaster component */}
        </AuthProvider>
      </body>
    </html>
  );
}
