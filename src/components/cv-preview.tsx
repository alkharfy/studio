
'use client';

import * as React from 'react';
import type { CvFormData } from '@/components/cv-form'; // Import the form data type

interface CvPreviewProps {
  data: CvFormData;
}

// Basic component to display the CV preview based on form data
export function CvPreview({ data }: CvPreviewProps) {
  return (
    <div className="p-8 font-serif text-sm leading-relaxed bg-white text-gray-800 min-h-full">
      {/* Header */}
      <header className="text-center mb-8 border-b pb-4 border-gray-300">
        <h1 className="text-3xl font-bold text-primary mb-1">{data.fullName || 'الاسم الكامل'}</h1>
        <p className="text-lg text-muted-foreground">{data.jobTitle || 'المسمى الوظيفي'}</p>
        <div className="flex justify-center gap-4 text-xs mt-2 text-muted-foreground">
          <span>{data.email || 'البريد الإلكتروني'}</span>
          {data.phone && <span>|</span>}
          <span>{data.phone || 'رقم الهاتف'}</span>
          {data.address && <span>|</span>}
          {data.address && <span>{data.address}</span>}
        </div>
      </header>

      {/* Summary */}
      {data.summary && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold border-b border-primary text-primary mb-2 pb-1">الملخص الشخصي</h2>
          <p className="text-gray-700">{data.summary}</p>
        </section>
      )}

      {/* Experience */}
      {data.experience && data.experience.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold border-b border-primary text-primary mb-3 pb-1">الخبرة العملية</h2>
          <ul className="space-y-4">
            {data.experience.map((exp, index) => (
              <li key={index} className="mb-3">
                <h3 className="text-md font-semibold text-gray-900">{exp.jobTitle || 'المسمى الوظيفي'}</h3>
                <p className="text-sm text-gray-700 italic">{exp.company || 'الشركة'}</p>
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
              <li key={index} className="mb-2">
                <h3 className="text-md font-semibold text-gray-900">{edu.degree || 'الشهادة'}</h3>
                <p className="text-sm text-gray-700 italic">{edu.institution || 'المؤسسة التعليمية'}</p>
                <p className="text-xs text-muted-foreground mb-1">
                  {edu.graduationYear || 'سنة التخرج'}
                </p>
                 {edu.details && <p className="text-sm text-gray-600">{edu.details}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Skills */}
      {data.skills && data.skills.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold border-b border-primary text-primary mb-2 pb-1">المهارات</h2>
          <ul className="flex flex-wrap gap-2">
            {data.skills.map((skill, index) => (
              skill.name && <li key={index} className="bg-secondary text-secondary-foreground text-xs px-3 py-1 rounded-full">{skill.name}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Placeholder for other sections like Languages, Hobbies etc. */}

    </div>
  );
}
