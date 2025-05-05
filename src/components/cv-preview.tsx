
'use client';

import * as React from 'react';
import type { CvFormData } from '@/components/cv-form'; // Import the form data type

interface CvPreviewProps {
  data: CvFormData;
}

// Basic component to display the CV preview based on form data
export function CvPreview({ data }: CvPreviewProps) {
  return (
    // Ensure the container takes full height and apply base styling
    <div className="p-8 font-serif text-sm leading-relaxed bg-white text-gray-800 min-h-full h-full">
      {/* Header */}
      <header className="text-center mb-8 border-b pb-4 border-gray-300">
        <h1 className="text-3xl font-bold text-primary mb-1">{data.fullName || 'الاسم الكامل'}</h1>
        <p className="text-lg text-muted-foreground">{data.jobTitle || 'المسمى الوظيفي'}</p>
        <div className="flex justify-center flex-wrap gap-x-4 gap-y-1 text-xs mt-2 text-muted-foreground">
          <span>{data.email || 'البريد الإلكتروني'}</span>
          {data.phone && <span>|</span>}
          {data.phone && <span>{data.phone}</span>}
          {data.address && <span>|</span>}
          {data.address && <span>{data.address}</span>}
        </div>
      </header>

      {/* Summary */}
      {data.summary && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold border-b border-primary text-primary mb-2 pb-1">الملخص الشخصي</h2>
          <p className="text-gray-700 whitespace-pre-line">{data.summary}</p> {/* Use whitespace-pre-line */}
        </section>
      )}

      {/* Experience */}
      {data.experience && data.experience.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold border-b border-primary text-primary mb-3 pb-1">الخبرة العملية</h2>
          <ul className="space-y-4">
            {data.experience.map((exp, index) => (
               (exp.jobTitle || exp.company) && // Only render if jobTitle or company exists
              <li key={index} className="mb-3 break-inside-avoid"> {/* Prevent breaking inside list items */}
                <h3 className="text-md font-semibold text-gray-900">{exp.jobTitle || 'المسمى الوظيفي'}</h3>
                {exp.company && <p className="text-sm text-gray-700 italic">{exp.company}</p>}
                <p className="text-xs text-muted-foreground mb-1">
                  {exp.startDate || 'تاريخ البدء'} - {exp.endDate || 'الحاضر'}
                </p>
                {exp.description && <p className="text-sm text-gray-600 whitespace-pre-line">{exp.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Education */}
      {data.education && data.education.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold border-b border-primary text-primary mb-3 pb-1">التعليم</h2>
          <ul className="space-y-3">
            {data.education.map((edu, index) => (
               (edu.degree || edu.institution) && // Only render if degree or institution exists
              <li key={index} className="mb-2 break-inside-avoid">
                <h3 className="text-md font-semibold text-gray-900">{edu.degree || 'الشهادة'}</h3>
                {edu.institution && <p className="text-sm text-gray-700 italic">{edu.institution}</p>}
                <p className="text-xs text-muted-foreground mb-1">
                  {edu.graduationYear || 'سنة التخرج'}
                </p>
                 {edu.details && <p className="text-sm text-gray-600 whitespace-pre-line">{edu.details}</p>} {/* Use whitespace-pre-line */}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Skills */}
      {data.skills && data.skills.length > 0 && (
        <section className="mb-6"> {/* Added margin-bottom */}
          <h2 className="text-xl font-semibold border-b border-primary text-primary mb-2 pb-1">المهارات</h2>
          <ul className="flex flex-wrap gap-2">
            {data.skills.map((skill, index) => (
              skill.name && <li key={index} className="bg-secondary text-secondary-foreground text-xs px-3 py-1 rounded-full">{skill.name}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Placeholder for other sections like Languages, Hobbies etc. */}
      {/* Consider adding Languages/Hobbies here if present in CvFormData */}

    </div>
  );
}
