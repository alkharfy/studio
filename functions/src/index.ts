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
const DOC_PROCESSOR_PATH_ENV = process.env.CV_DOC_PROCESSOR_PATH;
const VERTEX_MODEL_ENV = process.env.CV_VERTEX_MODEL;
const GCP_PROJECT_ID_ENV = process.env.GCLOUD_PROJECT;

const gcpProjectId = GCP_PROJECT_ID_ENV || functions.config().cv?.project_id;

let docaiClient: DocumentProcessorServiceClient | undefined;
let generativeModel: ReturnType<VertexAI["getGenerativeModel"]> | undefined;

const docProcessorPathConfig = DOC_PROCESSOR_PATH_ENV || functions.config().cv?.doc_processor_path;
const vertexModelConfig = VERTEX_MODEL_ENV || functions.config().cv?.vertex_model;

functionsLogger.info("Initial Configuration Check:", {
    docProcessorPathConfigValue: docProcessorPathConfig,
    vertexModelConfigValue: vertexModelConfig,
    gcpProjectIdValue: gcpProjectId,
    DOC_PROCESSOR_PATH_ENV,
    VERTEX_MODEL_ENV,
    GCP_PROJECT_ID_ENV,
    firebaseFunctionsConfigCV: functions.config().cv,
});


if (docProcessorPathConfig && vertexModelConfig && gcpProjectId) {
  try {
    docaiClient = new DocumentProcessorServiceClient({ apiEndpoint: "us-documentai.googleapis.com" });
    const vertexAI = new VertexAI({ project: gcpProjectId, location: "us-central1" }); // Ensure location matches your Vertex AI model
    generativeModel = vertexAI.getGenerativeModel({ model: vertexModelConfig });
    functionsLogger.info("Document AI and Vertex AI clients initialized successfully.");
  } catch (clientInitError: any) {
    functionsLogger.error("Error initializing Document AI or Vertex AI clients:", {
      errorMessage: clientInitError.message,
      errorStack: clientInitError.stack,
      docProcessorPathConfig,
      vertexModelConfig,
      gcpProjectId
    });
  }
} else {
  functionsLogger.error("CRITICAL: Document AI processor path, Vertex AI model, or GCP Project ID is NOT configured. Function will not process PDFs.", {
    hasDocPath: !!docProcessorPathConfig,
    hasVertexModel: !!vertexModelConfig,
    hasGcpProjectId: !!gcpProjectId
  });
}

const bucketNameToListen = process.env.FUNCTIONS_EMULATOR === 'true' 
    ? 'default-bucket' // Default bucket for Firebase Storage Emulator
    : gcpProjectId ? `${gcpProjectId}.appspot.com` : undefined;

if (!bucketNameToListen) {
    functionsLogger.error("CRITICAL: Cannot determine bucket to listen on. GCLOUD_PROJECT env var might be missing for production, or not in emulator mode. Function will not trigger.");
} else {
    functionsLogger.info(`Function will listen on bucket: ${bucketNameToListen}`);
}


export const parseResumePdf = onObjectFinalized(
  {
    region: "us-central1",
    bucket: bucketNameToListen!, // Use the determined bucket name
    eventFilters: { "name": "resumes_uploads/**" }, 
    memory: "1GiB",
    timeoutSeconds: 540,
    cpu: 1,
  },
  async (event: CloudEvent<StorageObjectData>) => {
    const { bucket, name, metageneration, timeCreated, updated } = event.data;
    functionsLogger.info(`🔔 Function TRIGGERED. Event ID: ${event.id}, Bucket: ${bucket}, File: ${name}, Metageneration: ${metageneration}, TimeCreated: ${timeCreated}, Updated: ${updated}`);

    if (!name) {
      functionsLogger.warn("Object name is undefined, exiting.", { eventId: event.id });
      return;
    }

    if (!name.startsWith("resumes_uploads/")) {
      functionsLogger.info(`File ${name} is not in resumes_uploads/, skipping.`, { eventId: event.id });
      return;
    }
    
    // Avoid infinite loops from metadata updates by the function itself
    if (metageneration && parseInt(String(metageneration), 10) > 1) {
      functionsLogger.info(`Metadata update for ${name} (metageneration: ${metageneration}), skipping.`, { eventId: event.id });
      return;
    }

    const uidParts = name.split("/");
    if (uidParts.length < 3 || !uidParts[1]) {
        functionsLogger.error(`Could not extract UID from path: ${name}. Expected format 'resumes_uploads/UID/filename.pdf'`, { eventId: event.id, pathParts: uidParts });
        return;
    }
    const uid = uidParts[1];
    functionsLogger.info(`Extracted UID: ${uid} from path: ${name}`, { eventId: event.id });


    const fileName = name.split("/").pop()!;
    const tempFilePath = `/tmp/${fileName.replace(/\//g, '_')}`; // Sanitize filename for temp path

    if (!docaiClient || !generativeModel || !docProcessorPathConfig || !vertexModelConfig || !gcpProjectId) {
      functionsLogger.error("CRITICAL: Document AI or Vertex AI services not initialized due to missing configuration. Aborting parseResumePdf for file.", { 
        fileName, 
        uid,
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
            resumeId: errorResumeId, 
            userId: uid, 
        });
      } catch (dbError: any) {
          functionsLogger.error("Failed to write config_error_services_not_initialized to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId: event.id });
      }
      return;
    }
    
    functionsLogger.info("Using Document AI Processor Path:", { path: docProcessorPathConfig });
    functionsLogger.info("Using Vertex AI Model:", { model: vertexModelConfig });

    try {
      functionsLogger.info(`Attempting to download ${name} from bucket ${bucket} to ${tempFilePath}`, { eventId: event.id });
      await adminStorage.bucket(bucket).file(name).download({ destination: tempFilePath });
      functionsLogger.info(`📄 File downloaded to ${tempFilePath}`, { name, eventId: event.id });

      const fileContent = fs.readFileSync(tempFilePath);
      functionsLogger.info(`Read file content from ${tempFilePath}, size: ${fileContent.byteLength} bytes`, { eventId: event.id });
      
      let rawText = "";
      try {
        const [docAiResult] = await docaiClient.processDocument({
          name: docProcessorPathConfig,
          rawDocument: { content: fileContent, mimeType: "application/pdf" },
        });
        rawText = docAiResult.document?.text || "";
        functionsLogger.info(`📝 OCR extracted text length: ${rawText.length}`, { name, eventId: event.id });
      } catch (docAiError: any) {
        functionsLogger.error("🚨 Document AI processing error:", { errorMessage: docAiError.message, errorDetails: docAiError.details, code: docAiError.code, name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `doc_ai_error: ${docAiError.code || 'UNKNOWN'} - ${docAiError.message.substring(0,100)}`,
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }


      if (!rawText.trim()) {
        functionsLogger.warn("OCR result is empty. Writing parsingError to Firestore.", { name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ocr_empty_result",
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      const textSnippet = rawText.slice(0, 15000);
      functionsLogger.info(`Using text snippet for Vertex AI (length: ${textSnippet.length})`, { eventId: event.id });

      const prompt = `
        You are an expert Arabic/English résumé parser.
        Return ONLY minified JSON that exactly matches this TypeScript type – no comments, no extra keys, no Markdown:

        type Resume = {
          title: string,
          personalInfo: {
            fullName: string, email: string,
            phone: string, address: string, jobTitle: string
          },
          summary: string, 
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

      let jsonString = "";
      try {
        const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
        if (aiResponse.response?.candidates?.[0]?.content?.parts?.[0] && 'text' in aiResponse.response.candidates[0].content.parts[0]) {
            jsonString = aiResponse.response.candidates[0].content.parts[0].text || "";
        }
        functionsLogger.info(`🎯 Vertex AI raw JSON string: "${jsonString}"`, { name, eventId: event.id, length: jsonString.length });
      } catch (vertexError: any) {
         functionsLogger.error("🚨 Vertex AI processing error:", { errorMessage: vertexError.message, errorDetails: vertexError.details, code: vertexError.code, name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `vertex_ai_error: ${vertexError.code || 'UNKNOWN'} - ${vertexError.message.substring(0,100)}`,
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }


      if (!jsonString.trim()) {
        functionsLogger.warn("Vertex AI returned empty string. Writing parsingError to Firestore.", { name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "vertex_empty_response",
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      let extractedData;
      try {
        // Attempt to clean the string: remove markdown, newlines, then parse
        const cleanedJsonString = jsonString.replace(/```json\n?/g, "").replace(/```\n?/g, "").replace(/\n/g, "").trim();
        if (!cleanedJsonString.startsWith("{") || !cleanedJsonString.endsWith("}")) {
            throw new Error("Cleaned string is not valid JSON object format.");
        }
        extractedData = JSON.parse(cleanedJsonString);
        functionsLogger.info("📊 Parsed JSON from Vertex AI (after cleaning):", { name, eventId: event.id, data: extractedData });
      } catch (e: any) {
        functionsLogger.error("🚨 Failed to parse JSON from Vertex AI:", { errorMessage: e.message, rawString: jsonString, name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
          parsingError: `vertex_json_parse_error: ${e.message.substring(0, 100)}`, 
          rawAiOutput: jsonString.substring(0, 1000), // Store snippet of problematic string
          storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }
      

      if (!extractedData.personalInfo?.fullName) {
        functionsLogger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError to Firestore.", { name, extractedData, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname",
            extractedData: extractedData, 
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      const resumeId = Date.now().toString(); // Consider using Firestore's auto-ID or a more robust unique ID
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
        })).filter((s: any) => s.name), // Ensure skills are objects and filter out empty ones
        languages: extractedData.languages || [],
        hobbies: extractedData.hobbies || [],
        customSections: extractedData.customSections || [],
        parsingDone: true,
        parsingError: null,
        rawAiOutput: jsonString.substring(0, 1000), // Store for potential future debugging/analysis
        storagePath: name,
        originalFileName: fileName,
        createdAt: firestoreServerTimestamp() as any, 
        updatedAt: firestoreServerTimestamp() as any, 
      };

      await firestoreSetDoc(resumeDocRef, finalResumeData);
      functionsLogger.log(`✅ Successfully wrote resume to users/${uid}/resumes/${resumeId}`, { name, eventId: event.id, firestorePath: resumeDocRef.path });

      try {
        await adminStorage.bucket(bucket).file(name).setMetadata({ metadata: { firebaseStorageDownloadTokens: null, resumeId: resumeId, parsingStatus: 'completed', firestorePath: resumeDocRef.path } });
        functionsLogger.info("✅ Set metadata on storage object:", { name, resumeId, eventId: event.id });
      } catch (metaError: any) {
        functionsLogger.error("🚨 Error setting metadata on storage object:", { name, errorMessage: metaError.message, metaErrorObj: metaError, eventId: event.id });
      }

      try {
        const userDocRef = firestoreDoc(db, "users", uid);
        await firestoreUpdateDoc(userDocRef, { latestResumeId: resumeId, updatedAt: firestoreServerTimestamp() });
        functionsLogger.info("✅ Updated latestResumeId for user:", { uid, resumeId, eventId: event.id });
      } catch (userUpdateError: any) {
         functionsLogger.error("🚨 Error updating latestResumeId for user:", { uid, resumeId, errorMessage: userUpdateError.message, userUpdateErrorObj: userUpdateError, eventId: event.id });
      }

    } catch (error: any) {
      functionsLogger.error("🚨 Unhandled error in parseResumePdf:", { name, errorMessage: error.message, errorObj: error, eventId: event.id });
      const errorResumeId = Date.now().toString();
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `unknown_function_error: ${error.message.substring(0, 100)}`,
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
      } catch (dbError: any) {
          functionsLogger.error("Failed to write unhandled_error to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId: event.id });
      }
    } finally {
      if (fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          functionsLogger.log(`🗑️ Temporary file deleted: ${tempFilePath}`, { name, eventId: event.id });
        } catch (unlinkError: any) {
          functionsLogger.error("🚨 Error deleting temporary file:", { name, errorMessage: unlinkError.message, unlinkErrorObj: unlinkError, eventId: event.id });
        }
      }
    }
  }
);


// --- suggestSummary Cloud Function (HTTPS Callable) ---
export const suggestSummary = onCall(
  { region: "us-central1", memory: "512MiB" }, // Added region and memory
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
  functionsLogger.info("suggestSummary called with:", { jobTitle, yearsExp, skills, lang, uid: request.auth.uid });

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

    functionsLogger.info("💡 suggestSummary AI response:", { jobTitle, summaryText, uid: request.auth.uid });
    return { summary: summaryText.trim() };
  } catch (error: any) {
    functionsLogger.error("🚨 Error in suggestSummary:", { errorMessage: error.message, jobTitle, errorObj: error, uid: request.auth.uid });
    throw new functions.https.HttpsError('internal', 'Failed to generate summary.', error.message);
  }
});


export const suggestSkills = onCall(
  { region: "us-central1", memory: "512MiB" }, // Added region and memory
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
  functionsLogger.info("suggestSkills called with:", { jobTitle, max, lang, uid: request.auth.uid });

  const prompt = `
    Suggest up to ${max} relevant skills (technical and soft) in ${lang} for a person with the job title "${jobTitle}".
    Return the skills as a simple JSON array of strings, like ["skill1", "skill2"]. Do not include any other text or explanation.
    Example for "مهندس برمجيات": ["JavaScript", "React", "Node.js", "حل المشكلات", "التواصل الفعال"]
  `;

  try {
    const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const responseContent: Content | null = aiResponse.response.candidates?.[0]?.content ?? null;
    let skillsJsonString = "[]"; 
    if (responseContent?.parts?.[0] && 'text' in responseContent.parts[0]) {
        skillsJsonString = responseContent.parts[0].text || "[]";
     }
    
    functionsLogger.info("💡 suggestSkills AI raw response:", { jobTitle, skillsJsonString, uid: request.auth.uid });
    let suggestedSkills: string[] = [];
    try {
        // Attempt to clean the string: remove markdown, newlines, then parse
        const cleanedJsonString = skillsJsonString.replace(/```json\n?/g, "").replace(/```\n?/g, "").replace(/\n/g, "").trim();
        const parsed = JSON.parse(cleanedJsonString);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            suggestedSkills = parsed;
        } else {
            functionsLogger.warn("suggestSkills: AI response was not a valid JSON array of strings after cleaning.", {raw: skillsJsonString, cleaned: cleanedJsonString, jobTitle, uid: request.auth.uid });
        }
    } catch (parseError: any) {
        functionsLogger.error("🚨 Error parsing skills JSON from AI:", {errorMessage: parseError.message, raw: skillsJsonString, jobTitle, parseErrorObj: parseError, uid: request.auth.uid });
         if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
            suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
            functionsLogger.info("Fallback: Parsed skills from comma-separated string", { suggestedSkills, uid: request.auth.uid });
         }
    }
    functionsLogger.info("💡 suggestSkills processed skills:", { jobTitle, skills: suggestedSkills.slice(0, max), uid: request.auth.uid });
    return { skills: suggestedSkills.slice(0, max) };
  } catch (error: any) {
    functionsLogger.error("🚨 Error in suggestSkills:", { errorMessage: error.message, jobTitle, errorObj: error, uid: request.auth.uid });
    throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
  }
});

// Ensure all functions have region and memory settings if they are HTTP callable from client
// and might benefit from co-location or specific resource allocation.
// For storage triggers, region is already set.
