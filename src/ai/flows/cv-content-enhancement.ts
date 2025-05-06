'use server';

/**
 * @fileOverview An AI agent to enhance CV content with AI.
 *
 * - enhanceCvContent - A function that enhances CV content based on a job description.
 * - EnhanceCvContentInput - The input type for the enhanceCvContent function.
 * - EnhanceCvContentOutput - The return type for the enhanceCvContent function.
 */

import {ai} from '@/ai/ai-instance';
import {z} from 'genkit';

const EnhanceCvContentInputSchema = z.object({
  cvContent: z.string().describe('The current CV content to be enhanced.'),
  jobDescription: z.string().describe('The job description to tailor the CV content to.'),
});
export type EnhanceCvContentInput = z.infer<typeof EnhanceCvContentInputSchema>;

const EnhanceCvContentOutputSchema = z.object({
  enhancedCvContent: z
    .string()
    .describe('The enhanced CV content optimized for the job description.'),
});
export type EnhanceCvContentOutput = z.infer<typeof EnhanceCvContentOutputSchema>;

export async function enhanceCvContent(input: EnhanceCvContentInput): Promise<EnhanceCvContentOutput> {
  return enhanceCvContentFlow(input);
}

const prompt = ai.definePrompt({
  name: 'enhanceCvContentPrompt',
  input: {
    schema: z.object({
      cvContent: z.string().describe('The current CV content to be enhanced.'),
      jobDescription: z.string().describe('The job description to tailor the CV content to.'),
    }),
  },
  output: {
    schema: z.object({
      enhancedCvContent:
        z.string().describe('The enhanced CV content optimized for the job description.'),
    }),
  },
  prompt: `You are an expert CV writer specializing in tailoring CVs to specific job descriptions.

You will use the job description to suggest improvements to the CV content, optimizing for relevant keywords and phrasing.

Job Description: {{{jobDescription}}}

CV Content: {{{cvContent}}}

Enhanced CV Content:`,
});

const enhanceCvContentFlow = ai.defineFlow<
  typeof EnhanceCvContentInputSchema,
  typeof EnhanceCvContentOutputSchema // Ensure output type matches here
>({
  name: 'enhanceCvContentFlow',
  inputSchema: EnhanceCvContentInputSchema,
  outputSchema: EnhanceCvContentOutputSchema, // And here
},
async input => {
  const {output} = await prompt(input);
  // Ensure the returned object matches EnhanceCvContentOutputSchema
  return {
    enhancedCvContent: output?.enhancedCvContent || "", // Provide a default empty string if undefined
  };
});
