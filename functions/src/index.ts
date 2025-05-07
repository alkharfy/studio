// functions/src/index.ts
import * as fs from 'fs';

import type { CloudEvent } from "firebase-functions/v2";
import { onObjectFinalized, type StorageObjectData } from "firebase-functions/v2/storage";
import { initializeApp, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore, FieldValue, setDoc as firestoreSetDoc, doc as firestoreDoc, serverTimestamp as firestoreServerTimestamp, updateDoc as firestoreUpdateDoc } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { VertexAI, type Content, type Part } from "@google-cloud/vertexai";
import * as functions from "firebase-functions"; // For functions.config()
import { HttpsCallableContext, CallableRequest, onCall } from "firebase-functions/v2/https";
import { logger as functionsLogger } from "firebase-functions/logger";
import type { Resume as FirestoreResumeData } from "./dbTypes";

// Initialize Firebase Admin SDK
if (!getAdminApps().length) {
  initializeApp();
}

// Globally initialized services
const db = getFirestore();
const adminStorage = getAdminStorage();

// Configuration for Document AI and Vertex AI
// Prefer environment variables, then fallback to Firebase functions config
// Ensure consistent casing for environment variables (e.g., uppercase)
const DOC_PROCESSOR_PATH_ENV = process.env.CV_DOC_PROCESSOR_PATH;
const VERTEX_MODEL_ENV = process.env.CV_VERTEX_MODEL;

const gcpProjectId = process.env.GCLOUD_PROJECT || functions.config().cv?.project_id;

// Initialize clients, ensuring config values are available
let docaiClient: DocumentProcessorServiceClient | undefined;
let generativeModel: ReturnType<VertexAI["getGenerativeModel"]> | undefined;

const docProcessorPathConfig = DOC_PROCESSOR_PATH_ENV || functions.config().cv?.doc_processor_path;
const vertexModelConfig = VERTEX_MODEL_ENV || functions.config().cv?.vertex_model;

if (docProcessorPathConfig && vertexModelConfig && gcpProjectId) {
  docaiClient = new DocumentProcessorServiceClient({ apiEndpoint: "us-documentai.googleapis.com" });
  const vertexAI = new VertexAI({ project: gcpProjectId, location: "us-central1" });
  generativeModel = vertexAI.getGenerativeModel({ model: vertexModelConfig });
  functionsLogger.info("Document AI and Vertex AI clients initialized.", { docProcessorPathConfig, vertexModelConfig, gcpProjectId });
} else {
  functionsLogger.error("Critical: Document AI processor path, Vertex AI model, or GCP Project ID is not configured. Check environment variables (CV_DOC_PROCESSOR_PATH, CV_VERTEX_MODEL, GCLOUD_PROJECT) or Firebase functions.config().", {
    hasDocPath: !!docProcessorPathConfig,
    hasVertexModel: !!vertexModelConfig,
    hasGcpProjectId: !!gcpProjectId // Corrected key
  });
}

// Determine bucket name based on environment
const GCLOUD_PROJECT_ID = process.env.GCLOUD_PROJECT;
const AppSpotBucket = GCLOUD_PROJECT_ID ? `${GCLOUD_PROJECT_ID}.appspot.com` : undefined;
const EMULATOR_STORAGE_BUCKET = "default-bucket"; // Default bucket for Firebase Storage Emulator

const bucketToListen = process.env.FUNCTIONS_EMULATOR === 'true' ? EMULATOR_STORAGE_BUCKET : AppSpotBucket;

if (!bucketToListen) {
    functionsLogger.error("CRITICAL: Cannot determine bucket to listen on. GCLOUD_PROJECT env var might be missing for production, or not in emulator mode.");
    // Potentially throw an error here or handle it gracefully if the function cannot operate
}


export const parseResumePdf = onObjectFinalized(
  {
    region: "us-central1",
    bucket: bucketToListen || AppSpotBucket!, // Fallback to AppSpotBucket if bucketToListen is somehow undefined (should not happen if GCLOUD_PROJECT is set)
    eventFilters: { name: "resumes_uploads/**" }, 
    memory: "1GiB",
    timeoutSeconds: 540,
    cpu: 1,
  },
  async (event: CloudEvent<StorageObjectData>) => {
    const { bucket, name, metageneration } = event.data;
    functionsLogger.info(`🔔 Function TRIGGERED. Event ID: ${event.id}, Bucket: ${bucket}, File: ${name}, Metageneration: ${metageneration}`);


    if (!name) {
      functionsLogger.log("Object name is undefined, exiting.", { eventId: event.id });
      return;
    }

    if (!name.startsWith("resumes_uploads/")) {
      functionsLogger.log(`File ${name} is not in resumes_uploads/, skipping.`, { eventId: event.id });
      return;
    }
    
    // Avoid infinite loops from metadata updates by the function itself
    // Casting metageneration to string before parseInt as it can be number or string
    if (metageneration && parseInt(String(metageneration), 10) > 1) {
      functionsLogger.log(`Metada update for ${name} (metageneration: ${metageneration}), skipping.`, { eventId: event.id });
      return;
    }

    const uid = name.split("/")[1];
    if (!uid) {
      functionsLogger.error(`Could not extract UID from path: ${name}`, { eventId: event.id });
      return;
    }

    const fileName = name.split("/").pop()!;
    const tempFilePath = `/tmp/${fileName}`;

    if (!docaiClient || !generativeModel || !docProcessorPathConfig || !vertexModelConfig || !gcpProjectId) {
      functionsLogger.error("Document AI or Vertex AI services not initialized due to missing configuration. Aborting parseResumePdf.", { 
        name, 
        eventId: event.id,
        hasDocClient: !!docaiClient,
        hasGenModel: !!generativeModel,
        hasDocPathConfig: !!docProcessorPathConfig,
        hasVertexModelConfig: !!vertexModelConfig,
        hasGcpProjectId: !!gcpProjectId
      });
      const errorResumeId = Date.now().toString();
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "config_error_services_not_initialized",
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
            resumeId: errorResumeId, // Add resumeId
            userId: uid, // Add userId
        });
      } catch (dbError) {
          functionsLogger.error("Failed to write config error to Firestore", { dbError, uid, errorResumeId, eventId: event.id });
      }
      return;
    }

    try {
      functionsLogger.log(`Attempting to download ${name} from bucket ${bucket} to ${tempFilePath}`, { eventId: event.id });
      await adminStorage.bucket(bucket).file(name).download({ destination: tempFilePath });
      functionsLogger.log(`📄 File downloaded to ${tempFilePath}`, { name, eventId: event.id });

      const fileContent = fs.readFileSync(tempFilePath);
      functionsLogger.log(`Read file content from ${tempFilePath}, size: ${fileContent.byteLength} bytes`, { eventId: event.id });
      
      const [docAiResult] = await docaiClient.processDocument({
        name: docProcessorPathConfig,
        rawDocument: { content: fileContent, mimeType: "application/pdf" },
      });
      const rawText = docAiResult.document?.text || "";
      functionsLogger.log(`📝 OCR extracted text length: ${rawText.length}`, { name, eventId: event.id });

      if (!rawText.trim()) {
        functionsLogger.warn("OCR result is empty. Writing parsingError to Firestore.", { name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ocr_empty_result",
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
            resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      const textSnippet = rawText.slice(0, 15000);
      functionsLogger.log(`Using text snippet for Vertex AI (length: ${textSnippet.length})`, { eventId: event.id });

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
      if (aiResponse.response?.candidates?.[0]?.content?.parts?.[0] && 'text' in aiResponse.response.candidates[0].content.parts[0]) {
          jsonString = aiResponse.response.candidates[0].content.parts[0].text || "";
      }
      functionsLogger.info(`🎯 Vertex AI raw JSON string: "${jsonString}"`, { name, eventId: event.id });

      if (!jsonString.trim()) {
        functionsLogger.warn("Vertex AI returned empty string. Writing parsingError to Firestore.", { name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "vertex_empty_response",
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
            resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      let extractedData;
      try {
        extractedData = JSON.parse(jsonString);
      } catch (e: any) {
        functionsLogger.error("🚨 Failed to parse JSON from Vertex AI:", e.message, "Raw string:", jsonString, { name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
          parsingError: `vertex_json_parse_error: ${e.message.substring(0, 100)}`, // Truncate message
          rawAiOutput: jsonString.substring(0, 500), // Store snippet of problematic string
          storagePath: name,
          originalFileName: fileName,
          createdAt: firestoreServerTimestamp(),
          updatedAt: firestoreServerTimestamp(),
          resumeId: errorResumeId, userId: uid,
        });
        return;
      }
      functionsLogger.log("📊 Parsed JSON from Vertex AI:", extractedData, { name, eventId: event.id });

      if (!extractedData.personalInfo?.fullName) {
        functionsLogger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError to Firestore.", { name, extractedData, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname",
            extractedData: extractedData, // Store what was extracted for debugging
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
            resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      const resumeId = Date.now().toString();
      const resumeDocRef = firestoreDoc(db, "users", uid, "resumes", resumeId);
      functionsLogger.info(`Attempting to write to Firestore path: users/${uid}/resumes/${resumeId}`, { eventId: event.id });


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
        createdAt: firestoreServerTimestamp() as any, 
        updatedAt: firestoreServerTimestamp() as any, 
      };

      await firestoreSetDoc(resumeDocRef, finalResumeData);
      functionsLogger.log(`✅ Successfully wrote resume to users/${uid}/resumes/${resumeId}`, { name, eventId: event.id, firestorePath: resumeDocRef.path });

      try {
        await adminStorage.bucket(bucket).file(name).setMetadata({ metadata: { resumeId: resumeId, parsingStatus: 'completed', firestorePath: resumeDocRef.path } });
        functionsLogger.log("✅ Set metadata on storage object:", name, { resumeId, eventId: event.id });
      } catch (metaError: any) {
        functionsLogger.error("🚨 Error setting metadata on storage object:", metaError.message, { name, metaErrorObj: metaError, eventId: event.id });
      }

      try {
        const userDocRef = firestoreDoc(db, "users", uid);
        await firestoreUpdateDoc(userDocRef, { latestResumeId: resumeId, updatedAt: firestoreServerTimestamp() });
        functionsLogger.log("✅ Updated latestResumeId for user:", uid, { resumeId, eventId: event.id });
      } catch (userUpdateError: any) {
         functionsLogger.error("🚨 Error updating latestResumeId for user:", userUpdateError.message, { uid, resumeId, userUpdateErrorObj: userUpdateError, eventId: event.id });
      }

    } catch (error: any) {
      functionsLogger.error("🚨 Unhandled error in parseResumePdf:", error.message, { name, errorObj: error, eventId: event.id });
      const errorResumeId = Date.now().toString();
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `unknown_function_error: ${error.message.substring(0, 100)}`,
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
            resumeId: errorResumeId, userId: uid,
        });
      } catch (dbError) {
          functionsLogger.error("Failed to write unhandled error to Firestore", { dbError, uid, errorResumeId, eventId: event.id });
      }
    } finally {
      if (fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          functionsLogger.log(`🗑️ Temporary file deleted: ${tempFilePath}`, { name, eventId: event.id });
        } catch (unlinkError: any) {
          functionsLogger.error("🚨 Error deleting temporary file:", unlinkError.message, { name, unlinkErrorObj: unlinkError, eventId: event.id });
        }
      }
    }
  }
);


// --- suggestSummary Cloud Function (HTTPS Callable) ---
export const suggestSummary = onCall(
  async (request: CallableRequest<{ jobTitle?: string; yearsExp?: number; skills?: string[]; lang?: string }>) => {
    const data = request.data;
  if (!request.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  if (!generativeModel) {
    functionsLogger.error("Vertex AI service not initialized for suggestSummary. Missing configuration.");
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
    const responseContent: Content | null = aiResponse.response.candidates?.[0]?.content ?? null;
    let summaryText = "";

     if (responseContent?.parts?.[0] && 'text' in responseContent.parts[0]) {
        summaryText = responseContent.parts[0].text || "";
     }

    functionsLogger.info("💡 suggestSummary AI response:", { jobTitle, summaryText });
    return { summary: summaryText.trim() };
  } catch (error: any) {
    functionsLogger.error("🚨 Error in suggestSummary:", error.message, { jobTitle, errorObj: error });
    throw new functions.https.HttpsError('internal', 'Failed to generate summary.', error.message);
  }
});


export const suggestSkills = onCall(
  async (request: CallableRequest<{ jobTitle?: string; max?: number; lang?: string }>) => {
    const data = request.data;
  if (!request.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  if (!generativeModel) {
    functionsLogger.error("Vertex AI service not initialized for suggestSkills. Missing configuration.");
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
    const responseContent: Content | null = aiResponse.response.candidates?.[0]?.content ?? null;
    let skillsJsonString = "[]"; // Default to empty array string
    if (responseContent?.parts?.[0] && 'text' in responseContent.parts[0]) {
        skillsJsonString = responseContent.parts[0].text || "[]";
     }
    
    functionsLogger.info("💡 suggestSkills AI response:", { jobTitle, skillsJsonString });
    let suggestedSkills: string[] = [];
    try {
        const parsed = JSON.parse(skillsJsonString);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            suggestedSkills = parsed;
        } else {
            functionsLogger.warn("suggestSkills: AI response was not a valid JSON array of strings. Raw:", skillsJsonString, { jobTitle });
        }
    } catch (parseError: any) {
        functionsLogger.error("🚨 Error parsing skills JSON from AI:", parseError.message, "Raw:", skillsJsonString, { jobTitle, parseErrorObj: parseError });
         if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
            suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
         }
    }

    return { skills: suggestedSkills.slice(0, max) };
  } catch (error: any) {
    functionsLogger.error("🚨 Error in suggestSkills:", error.message, { jobTitle, errorObj: error });
    throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
  }
});

