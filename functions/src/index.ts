// functions/src/index.ts

import * as logger from "firebase-functions/logger";
import type { CloudEvent, CallableRequest } from "firebase-functions/v2";
import { onObjectFinalized, type StorageObjectData } from "firebase-functions/v2/storage";
import { initializeApp, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore, serverTimestamp, setDoc, doc } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { VertexAI } from "@google-cloud/vertexai";
import * as functions from "firebase-functions";
import * as fs from "node:fs";
import type { Resume as FirestoreResumeData } from "./dbTypes"; // Import the dbTypes

// Initialize Firebase Admin SDK
if (!getAdminApps().length) {
  initializeApp();
}

// Globally initialized services
const db = getFirestore();
const adminStorage = getAdminStorage();

// Configuration for Document AI and Vertex AI
// Prioritize environment variables, then fallback to functions.config()
// Ensure your Cloud Functions environment variables are set for production (e.g., CV_DOC_PROCESSOR_PATH, CV_VERTEX_MODEL)
// functions.config() is more for Firebase CLI local testing or older v1 function patterns.
const docProcessorPathConfig = process.env.CV_DOC_PROCESSOR_PATH || functions.config().cv?.doc_processor_path;
const vertexModelConfig = process.env.CV_VERTEX_MODEL || functions.config().cv?.vertex_model;
const gcpProjectId = process.env.GCLOUD_PROJECT; // Automatically available in Cloud Functions

let docaiClient: DocumentProcessorServiceClient | undefined;
let generativeModel: ReturnType<VertexAI["getGenerativeModel"]> | undefined;

if (docProcessorPathConfig && vertexModelConfig && gcpProjectId) {
  docaiClient = new DocumentProcessorServiceClient();
  const vertexAI = new VertexAI({ project: gcpProjectId, location: "us-central1" });
  generativeModel = vertexAI.getGenerativeModel({ model: vertexModelConfig });
} else {
  logger.error("Critical: Document AI processor path or Vertex AI model or GCP Project ID is not configured. Check environment variables (CV_DOC_PROCESSOR_PATH, CV_VERTEX_MODEL) or Firebase functions.config().");
}

export const parseResumePdf = onObjectFinalized(
  {
    region: "us-central1",
    bucket: `${gcpProjectId}.appspot.com`, // Use the project ID to construct bucket name
    eventFilters: { ["object.name"]: "resumes_uploads/**" },
    memory: "1GiB",
    timeoutSeconds: 540,
    cpu: 1,
  },
  async (event: CloudEvent<StorageObjectData>) => {
    const { bucket, name } = event.data;

    if (!name) {
      logger.log("Object name is undefined, exiting.");
      return;
    }

    // Check for metageneration to avoid infinite loops from updates by the function itself
    // This check can sometimes be tricky with how Firebase Storage/Functions handle events.
    // If `metageneration` is not consistently reliable, consider other idempotency strategies.
    if (event.data.metageneration && parseInt(event.data.metageneration as string, 10) > 1) {
      logger.log("This is a metadata update event, not a new upload. Skipping.", { name, metageneration: event.data.metageneration });
      return;
    }

    logger.log("🔔 TRIGGERED on", name);

    if (!name.startsWith("resumes_uploads/")) {
      logger.log("File is not in resumes_uploads/, skipping.", { name });
      return;
    }

    const uid = name.split("/")[1];
    if (!uid) {
      logger.error("Could not extract UID from path:", name);
      return;
    }

    const fileName = name.split("/").pop()!;
    const tempFilePath = `/tmp/${fileName}`;

    if (!docaiClient || !generativeModel || !docProcessorPathConfig) {
      logger.error("Document AI or Vertex AI services not initialized due to missing configuration. Aborting parseResumePdf.", { name });
      const errorResumeId = Date.now().toString();
      await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
        parsingError: "config_error_services_not_initialized",
        storagePath: name,
        originalFileName: fileName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return;
    }

    try {
      // 1. Download file
      await adminStorage.bucket(bucket).file(name).download({ destination: tempFilePath });
      logger.log("📄 File downloaded to", tempFilePath, { name });

      // 2. OCR via Document AI
      const fileContent = fs.readFileSync(tempFilePath);
      const [docAiResult] = await docaiClient.processDocument({
        name: docProcessorPathConfig, // Use the validated config path
        rawDocument: { content: fileContent, mimeType: "application/pdf" },
      });
      const rawText = docAiResult.document?.text ?? "";
      logger.log("📝 OCR extracted text length:", rawText.length, { name });

      if (!rawText.trim()) {
        logger.warn("OCR result is empty. Writing parsingError to Firestore.", { name });
        const errorResumeId = Date.now().toString();
        await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ocr_empty_result",
            storagePath: name,
            originalFileName: fileName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        return;
      }

      const textSnippet = rawText.slice(0, 15000);

      // 3. Extract structured JSON via Vertex AI
      const prompt = `
        You are an expert Arabic/English résumé parser.
        Return ONLY minified JSON that exactly matches this TypeScript type – no comments, no extra keys, no Markdown:

        type Resume = {
          title: string,
          personalInfo: {
            fullName: string, email: string,
            phone: string, address: string, jobTitle: string
          },
          summary: string, // Changed from objective
          education: { degree: string, institution: string, graduationYear: string, details?: string }[],
          experience: { jobTitle: string, company: string, startDate: string, endDate?: string, description?: string }[],
          skills: { name: string }[],
          languages: { name: string, level?: string }[],
          hobbies?: string[]
        }

        –––––––––––––––––––––––––––––––––
        ★ Arabic OUTPUT REQUIRED if source is Arabic ★
        –––––––––––––––––––––––––––––––––

        👉 Example you MUST follow
        INPUT snippet
        September 2018 – July 2023 Bachelor of petroleum engineering
        Suez University Grade: Excellent with honor
        EXPECTED JSON fragment
        \`\`\`json
        "education":[
          {"degree":"بكالوريوس هندسة بترول","institution":"جامعة السويس","graduationYear":"2018–2023"}
        ]
        \`\`\`

        👉 Another snippet
        July 2022 Production Operations Trainee
        Oasis Petroleum Company
        Analyzed daily production department workflows …
        EXPECTED JSON fragment
        \`\`\`json
        "experience":[
          {"jobTitle":"متدرب عمليات الإنتاج","company":"Oasis Petroleum Company",
           "startDate":"07/2022","endDate":"","description":"حللت سير عمل قسم الإنتاج اليومي …"}
        ]
        \`\`\`
        If a field is truly missing, output an empty string "" or empty array [].
        For skills, ensure each skill is an object like {"name": "skill_name"}.
        For personalInfo.jobTitle, extract the current or most recent job title. If multiple, pick the most prominent.

        TEXT TO ANALYSE (Arabic + English may be mixed – keep Arabic in output, especially for names, degrees, job titles):
        """
        ${textSnippet}
        """
      `;

      const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
      let jsonString = "";
      if (aiResponse.response && aiResponse.response.candidates && aiResponse.response.candidates.length > 0) {
          const firstCandidate = aiResponse.response.candidates[0];
          if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
              jsonString = firstCandidate.content.parts[0].text || "";
          }
      }
      logger.log("🎯 Vertex AI raw JSON string:", jsonString, { name });

      if (!jsonString.trim()) {
        logger.warn("Vertex AI returned empty string. Writing parsingError to Firestore.", { name });
         const errorResumeId = Date.now().toString();
         await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
             parsingError: "vertex_empty_response",
             storagePath: name,
             originalFileName: fileName,
             createdAt: serverTimestamp(),
             updatedAt: serverTimestamp(),
         });
        return;
      }

      let extractedData;
      try {
        extractedData = JSON.parse(jsonString);
      } catch (e: any) {
        logger.error("🚨 Failed to parse JSON from Vertex AI:", e.message, "Raw string:", jsonString, { name });
        const errorResumeId = Date.now().toString();
        await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
          parsingError: `vertex_json_parse_error: ${e.message}`,
          rawAiOutput: jsonString,
          storagePath: name,
          originalFileName: fileName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return;
      }
      logger.log("📊 Parsed JSON from Vertex AI:", extractedData, { name });

      if (!extractedData.personalInfo?.fullName) {
        logger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError to Firestore.", { name, extractedData });
        const errorResumeId = Date.now().toString();
        await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname",
            extractedData: extractedData,
            storagePath: name,
            originalFileName: fileName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        return;
      }

      // 4. Write to Firestore
      const resumeId = Date.now().toString();
      const resumeDocRef = doc(db, "users", uid, "resumes", resumeId);

      const finalResumeData: FirestoreResumeData = {
        resumeId: resumeId,
        userId: uid,
        title: extractedData.title || fileName,
        personalInfo: {
            fullName: extractedData.personalInfo?.fullName || null,
            email: extractedData.personalInfo?.email || null,
            phone: extractedData.personalInfo?.phone || null,
            address: extractedData.personalInfo?.address || null,
            jobTitle: extractedData.personalInfo?.jobTitle || null,
        },
        summary: extractedData.summary || extractedData.objective || null,
        education: (extractedData.education || []).map((edu: any) => ({
            degree: edu.degree || null,
            institution: edu.institution || edu.institute || null,
            graduationYear: edu.graduationYear || edu.year || null,
            details: edu.details || null,
        })),
        experience: (extractedData.experience || []).map((exp: any) => ({
            jobTitle: exp.jobTitle || exp.title || null,
            company: exp.company || null,
            startDate: exp.startDate || exp.start || null,
            endDate: exp.endDate || exp.end || null,
            description: exp.description || null,
        })),
        skills: (extractedData.skills || []).map((skill: any) => ({
            name: typeof skill === 'string' ? skill : (skill?.name || null)
        })).filter((s: any) => s.name),
        languages: extractedData.languages || [],
        hobbies: extractedData.hobbies || [],
        customSections: extractedData.customSections || [],
        parsingDone: true,
        parsingError: null,
        storagePath: name,
        originalFileName: fileName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      await setDoc(resumeDocRef, finalResumeData);
      logger.log("✅ Successfully wrote resume to users/%s/resumes/%s", uid, resumeId, { name });

    } catch (error: any) {
      logger.error("🚨 Unhandled error in parseResumePdf:", error.message, { name, errorObj: error });
      const errorResumeId = Date.now().toString();
      await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
        parsingError: `unknown_function_error: ${error.message}`,
        storagePath: name,
        originalFileName: fileName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } finally {
        if (fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                logger.log("🗑️ Temporary file deleted:", tempFilePath, { name });
            } catch (unlinkError: any) {
                logger.error("🚨 Error deleting temporary file:", unlinkError.message, { name, unlinkErrorObj: unlinkError });
            }
        }
    }
  }
);

export const suggestSummary = functions.https.onCall(async (data: { jobTitle?: string; yearsExp?: number; skills?: string[]; lang?: string }, context: CallableRequest<any>) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  if (!generativeModel) {
    logger.error("Vertex AI service not initialized for suggestSummary. Missing configuration.");
    throw new functions.https.HttpsError('internal', 'AI service not available. Please try again later.');
  }

  const { jobTitle, yearsExp = 0, skills = [], lang = "ar" } = data;
  if (!jobTitle || typeof jobTitle !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
  }

  const prompt = `
    Write a concise, engaging professional summary (~70–90 words, 2–3 sentences) in ${lang}
    for someone with the job title "${jobTitle}", ${yearsExp} years experience and skills: ${skills.join(", ")}.
    Emphasise impact and soft skills. Ensure the output is plain text, without any Markdown or JSON formatting.
  `;

  try {
    const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    let summaryText = "";
     if (aiResponse.response && aiResponse.response.candidates && aiResponse.response.candidates.length > 0) {
         const firstCandidate = aiResponse.response.candidates[0];
         if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
             summaryText = firstCandidate.content.parts[0].text || "";
         }
     }
    logger.info("💡 suggestSummary AI response:", { jobTitle, summaryText });
    return { summary: summaryText.trim() };
  } catch (error: any) {
    logger.error("🚨 Error in suggestSummary:", error.message, { jobTitle, errorObj: error });
    throw new functions.https.HttpsError('internal', 'Failed to generate summary.', error.message);
  }
});

export const suggestSkills = functions.https.onCall(async (data: { jobTitle?: string; max?: number; lang?: string }, context: CallableRequest<any>) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  if (!generativeModel) {
    logger.error("Vertex AI service not initialized for suggestSkills. Missing configuration.");
    throw new functions.https.HttpsError('internal', 'AI service not available. Please try again later.');
  }

  const { jobTitle, max = 8, lang = "ar" } = data;
  if (!jobTitle || typeof jobTitle !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
  }

  const prompt = `
    Suggest up to ${max} relevant skills (technical and soft) in ${lang} for a person with the job title "${jobTitle}".
    Return the skills as a simple JSON array of strings, like ["skill1", "skill2"]. Do not include any other text or explanation.
    Example for "مهندس برمجيات": ["JavaScript", "React", "Node.js", "حل المشكلات", "التواصل الفعال"]
  `;

  try {
    const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    let skillsJsonString = "";
    if (aiResponse.response && aiResponse.response.candidates && aiResponse.response.candidates.length > 0) {
         const firstCandidate = aiResponse.response.candidates[0];
         if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
             skillsJsonString = firstCandidate.content.parts[0].text || "[]";
         }
     }

    logger.info("💡 suggestSkills AI response:", { jobTitle, skillsJsonString });
    let suggestedSkills: string[] = [];
    try {
        const parsed = JSON.parse(skillsJsonString);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            suggestedSkills = parsed;
        } else {
            logger.warn("suggestSkills: AI response was not a valid JSON array of strings. Raw:", skillsJsonString, { jobTitle });
        }
    } catch (parseError: any) {
        logger.error("🚨 Error parsing skills JSON from AI:", parseError.message, "Raw:", skillsJsonString, { jobTitle, parseErrorObj: parseError });
         if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
            suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
         }
    }

    return { skills: suggestedSkills.slice(0, max) };
  } catch (error: any) {
    logger.error("🚨 Error in suggestSkills:", error.message, { jobTitle, errorObj: error });
    throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
  }
});
