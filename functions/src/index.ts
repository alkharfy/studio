// functions/src/index.ts
import * as fs from 'fs'; // For local file operations if any (removed direct usage, using buffer)
import type { CloudEvent } from "firebase-functions/v2";
import { onObjectFinalized, type StorageObjectData } from "firebase-functions/v2/storage";
import { initializeApp, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore, FieldValue, setDoc as firestoreSetDoc, doc as firestoreDoc, serverTimestamp as firestoreServerTimestamp, updateDoc as firestoreUpdateDoc } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { VertexAI, type Content } from "@google-cloud/vertexai";
import * as functions from "firebase-functions";
import { logger as functionsLogger } from "firebase-functions/logger";
import type { Resume as FirestoreResumeData } from "./dbTypes";
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js'; // For Node.js environment

// Initialize Firebase Admin SDK
if (!getAdminApps().length) {
  initializeApp();
}

// Globally initialized services
const db = getFirestore();
const adminStorage = getAdminStorage();

// Configuration for Vertex AI
const VERTEX_MODEL_ENV = process.env.CV_VERTEX_MODEL;
const GCP_PROJECT_ID_ENV = process.env.GCLOUD_PROJECT;

const gcpProjectId = GCP_PROJECT_ID_ENV || functions.config().cv?.project_id;
const vertexModelConfig = VERTEX_MODEL_ENV || functions.config().cv?.vertex_model;

functionsLogger.info("Initial Configuration Check:", {
    vertexModelConfigValue: vertexModelConfig,
    gcpProjectIdValue: gcpProjectId,
    VERTEX_MODEL_ENV,
    GCP_PROJECT_ID_ENV,
    firebaseFunctionsConfigCV: functions.config().cv,
});

let generativeModel: ReturnType<VertexAI["getGenerativeModel"]> | undefined;

if (vertexModelConfig && gcpProjectId) {
  try {
    const vertexAI = new VertexAI({ project: gcpProjectId, location: "us-central1" });
    generativeModel = vertexAI.getGenerativeModel({ model: vertexModelConfig });
    functionsLogger.info("Vertex AI client initialized successfully.");
  } catch (clientInitError: any) {
    functionsLogger.error("Error initializing Vertex AI client:", {
      errorMessage: clientInitError.message,
      errorStack: clientInitError.stack,
      vertexModelConfig,
      gcpProjectId
    });
  }
} else {
  functionsLogger.error("CRITICAL: Vertex AI model or GCP Project ID is NOT configured. Function will not process PDFs correctly.", {
    hasVertexModel: !!vertexModelConfig,
    hasGcpProjectId: !!gcpProjectId
  });
}

// Determine the correct bucket name based on environment
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
    bucket: bucketNameToListen!, // Use the determined bucket name. The "!" assumes bucketNameToListen will be defined if the function is to work.
    eventFilters: { "name": "resumes_uploads/**" }, // Ensure this matches the client upload path prefix
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

    // Extract UID from the path: resumes_uploads/UID/fileName.pdf
    const pathParts = name.split("/");
    if (pathParts.length < 3 || pathParts[0] !== "resumes_uploads" || !pathParts[1]) {
        functionsLogger.error(`Could not extract UID from path or invalid path structure: ${name}. Expected format 'resumes_uploads/UID/filename.pdf'`, { eventId: event.id, pathParts });
        return;
    }
    const uid = pathParts[1];
    functionsLogger.info(`Extracted UID: ${uid} from path: ${name}`, { eventId: event.id });

    const fileName = pathParts[pathParts.length -1]; // Get the actual file name

    // Check if Vertex AI is configured
    if (!generativeModel || !vertexModelConfig || !gcpProjectId) {
      functionsLogger.error("CRITICAL: Vertex AI services not initialized due to missing configuration. Aborting parseResumePdf for file.", { 
        fileName, 
        uid,
        eventId: event.id,
        hasGenModel: !!generativeModel,
        hasVertexModelConfig: !!vertexModelConfig,
        hasGcpProjectId: !!gcpProjectId
      });
      const errorResumeId = Date.now().toString();
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "config_error_vertex_not_initialized",
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
            resumeId: errorResumeId, 
            userId: uid, // Add userId
        });
      } catch (dbError: any) {
          functionsLogger.error("Failed to write config_error_vertex_not_initialized to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId: event.id });
      }
      return;
    }
    
    functionsLogger.info("Using Vertex AI Model:", { model: vertexModelConfig });

    try {
      functionsLogger.info(`Attempting to download ${name} from bucket ${bucket}`, { eventId: event.id });
      // Download file content as a buffer
      const [fileContent] = await adminStorage.bucket(bucket).file(name).download();
      functionsLogger.info(`📄 File downloaded, size: ${fileContent.byteLength} bytes`, { name, eventId: event.id });

      let rawText = "";
      try {
        // Use pdf.js to extract text
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileContent) }); // Pass buffer as Uint8Array
        const pdfDocument = await loadingTask.promise;
        functionsLogger.info(`Number of pages: ${pdfDocument.numPages}`, { name, eventId: event.id });
        
        for (let i = 1; i <= pdfDocument.numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const textContent = await page.getTextContent();
            // Ensure items exist and str is a string before joining
            rawText += textContent.items.map((item: any) => (item && typeof item.str === 'string' ? item.str : '')).join(" ") + "\n";
        }
        functionsLogger.info(`📝 pdf.js extracted text length: ${rawText.length}`, { name, eventId: event.id });

      } catch (pdfJsError: any) {
        functionsLogger.error("🚨 pdf.js text extraction error:", { errorMessage: pdfJsError.message, name, eventId: event.id, errorObj: pdfJsError });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `pdfjs_extraction_error: ${pdfJsError.message.substring(0,100)}`, // Limit error message length
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop processing
      }


      if (!rawText.trim()) {
        functionsLogger.warn("pdf.js extraction result is empty. Writing parsingError to Firestore.", { name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "pdfjs_empty_result",
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop further processing
      }

      const textSnippet = rawText.slice(0, 15000); // Limit text for Vertex AI
      functionsLogger.info(`Using text snippet for Vertex AI (length: ${textSnippet.length})`, { eventId: event.id });

      // Updated prompt
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
          education: { degree: string, institution: string, graduationYear: string, details?: string }[], // Changed institute to institution, year to graduationYear, added details
          experience: { jobTitle: string, company: string, startDate: string, endDate?: string, description?: string }[], // Changed title to jobTitle, start to startDate, end to endDate
          skills: { name: string }[], // Changed to array of objects
          languages: { name: string, level?: string }[],
          hobbies?: string[] // Made optional
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
        // Robustly access the text part of the response
        if (aiResponse.response?.candidates?.[0]?.content?.parts?.[0] && 'text' in aiResponse.response.candidates[0].content.parts[0]) {
            jsonString = aiResponse.response.candidates[0].content.parts[0].text || "";
        }
        functionsLogger.info(`🎯 Vertex AI raw JSON string: "${jsonString}"`, { name, eventId: event.id, length: jsonString.length });
      } catch (vertexError: any) {
         functionsLogger.error("🚨 Vertex AI processing error:", { errorMessage: vertexError.message, errorDetails: vertexError.details, code: vertexError.code, name, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `vertex_ai_error: ${vertexError.code || 'UNKNOWN'} - ${vertexError.message.substring(0,100)}`, // Limit message length
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
        // Clean the string: remove markdown code blocks if present
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
          parsingError: `vertex_json_parse_error: ${e.message.substring(0, 100)}`, // Limit message length
          rawAiOutput: jsonString.substring(0, 1000), // Store a snippet of the raw output
          storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop processing
      }
      

      // Validate crucial fields (e.g., fullName)
      if (!extractedData.personalInfo?.fullName) {
        functionsLogger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError to Firestore.", { name, extractedData, eventId: event.id });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname",
            extractedData: extractedData, // Store what was extracted
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      // 4. Write to Firestore
      const resumeId = Date.now().toString(); // Use Firestore server timestamp for ID generation if preferred
      const resumeDocRef = firestoreDoc(db, "users", uid, "resumes", resumeId);
      functionsLogger.info(`Attempting to write to Firestore path: users/${uid}/resumes/${resumeId}`, { eventId: event.id });

      // Construct the final object to save, matching the FirestoreResumeData interface
      const finalResumeData: FirestoreResumeData = {
        resumeId: resumeId, // Add the ID to the document itself
        userId: uid, // Add userId
        title: extractedData.title || fileName, // Fallback to filename if title is missing
        personalInfo: {
            fullName: extractedData.personalInfo?.fullName || null,
            email: extractedData.personalInfo?.email || null,
            phone: extractedData.personalInfo?.phone || null,
            address: extractedData.personalInfo?.address || null,
            jobTitle: extractedData.personalInfo?.jobTitle || null,
        },
        summary: extractedData.summary || extractedData.objective || null, // Use summary, fallback to objective
        education: (extractedData.education || []).map((edu: any) => ({
            degree: edu.degree || null,
            institution: edu.institution || edu.institute || null, // Handle both institution/institute
            graduationYear: edu.graduationYear || edu.year || null, // Handle both graduationYear/year
            details: edu.details || null,
        })),
        experience: (extractedData.experience || []).map((exp: any) => ({
            jobTitle: exp.jobTitle || exp.title || null, // Handle both jobTitle/title
            company: exp.company || null,
            startDate: exp.startDate || exp.start || null, // Handle both startDate/start
            endDate: exp.endDate || exp.end || null,
            description: exp.description || null,
        })),
        skills: (extractedData.skills || []).map((skill: any) => ({ // Ensure skills are objects {name: string}
            name: typeof skill === 'string' ? skill : (skill?.name || null)
        })).filter((s: any) => s.name), // Filter out empty/invalid skills
        languages: extractedData.languages || [],
        hobbies: extractedData.hobbies || [],
        customSections: extractedData.customSections || [], // Assuming customSections might be extracted
        // Metadata
        parsingDone: true,
        parsingError: null, // Explicitly set to null on success
        rawAiOutput: jsonString.substring(0,1000), // Store a snippet for debugging
        storagePath: name,
        originalFileName: fileName, // Store the original file name
        createdAt: firestoreServerTimestamp() as any, // Cast to any due to Firestore SDK types
        updatedAt: firestoreServerTimestamp() as any, // Cast to any
      };

      await firestoreSetDoc(resumeDocRef, finalResumeData);
      functionsLogger.log(`✅ Successfully wrote resume to users/${uid}/resumes/${resumeId}`, { name, eventId: event.id, firestorePath: resumeDocRef.path });

      // Optionally, update file metadata in Storage to indicate processing is complete
      // This can help avoid re-processing or provide a visual cue in Firebase Console.
      try {
        await adminStorage.bucket(bucket).file(name).setMetadata({ metadata: { firebaseStorageDownloadTokens: null, resumeId: resumeId, parsingStatus: 'completed', firestorePath: resumeDocRef.path } });
        functionsLogger.info("✅ Set metadata on storage object:", { name, resumeId, eventId: event.id });
      } catch (metaError: any) {
        functionsLogger.error("🚨 Error setting metadata on storage object:", { name, errorMessage: metaError.message, metaErrorObj: metaError, eventId: event.id });
      }
      
      // Update latestResumeId on user document
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
      // Attempt to write a generic error to Firestore for this resume attempt
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `unknown_function_error: ${error.message.substring(0, 100)}`, // Limit message
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
      } catch (dbError: any) {
          functionsLogger.error("Failed to write unhandled_error to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId: event.id });
      }
    } finally {
      // No temporary file to clean up if using buffer directly
    }
  }
);

// --- suggestSummary Cloud Function (HTTPS Callable) ---
// Ensure you have functions.https.onCall imported
import { onCall, type CallableRequest } from "firebase-functions/v2/https";

export const suggestSummary = onCall(
  { region: "us-central1", memory: "512MiB" }, 
  async (request: CallableRequest<{ jobTitle?: string; yearsExp?: number; skills?: string[]; lang?: string }>) => {
    const data = request.data; // Access data directly from request.data
  // Check for authentication
  if (!request.auth) {
    // Throwing an HttpsError automatically client-side.
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  // Check if Vertex AI model is initialized
  if (!generativeModel) {
    functionsLogger.error("Vertex AI service not initialized for suggestSummary. Missing configuration.");
    throw new functions.https.HttpsError('internal', 'AI service not available. Please try again later.');
  }

  const { jobTitle, yearsExp = 0, skills = [], lang = "ar" } = data; // Destructure from data

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
    // Propagate a more specific error message if available
    throw new functions.https.HttpsError('internal', 'Failed to generate summary.', error.message);
  }
});

// --- suggestSkills Cloud Function (HTTPS Callable) ---
export const suggestSkills = onCall(
  { region: "us-central1", memory: "512MiB" }, 
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
    let skillsJsonString = "[]"; // Default to an empty array string
    
    if (responseContent?.parts?.[0] && 'text' in responseContent.parts[0]) {
        skillsJsonString = responseContent.parts[0].text || "[]";
     }
    
    functionsLogger.info("💡 suggestSkills AI raw response:", { jobTitle, skillsJsonString, uid: request.auth.uid });

    let suggestedSkills: string[] = [];
    try {
        // Clean the string: remove markdown code blocks if present
        const cleanedJsonString = skillsJsonString.replace(/```json\n?/g, "").replace(/```\n?/g, "").replace(/\n/g, "").trim();
        const parsed = JSON.parse(cleanedJsonString);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            suggestedSkills = parsed;
        } else {
            functionsLogger.warn("suggestSkills: AI response was not a valid JSON array of strings after cleaning.", {raw: skillsJsonString, cleaned: cleanedJsonString, jobTitle, uid: request.auth.uid });
        }
    } catch (parseError: any) {
        functionsLogger.error("🚨 Error parsing skills JSON from AI:", {errorMessage: parseError.message, raw: skillsJsonString, jobTitle, parseErrorObj: parseError, uid: request.auth.uid });
         // Fallback: try to extract skills if it's a comma-separated list or similar, if not clearly JSON.
         if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
            suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
            functionsLogger.info("Fallback: Parsed skills from comma-separated string", { suggestedSkills, uid: request.auth.uid });
         }
    }

    functionsLogger.info("💡 suggestSkills processed skills:", { jobTitle, skills: suggestedSkills.slice(0, max), uid: request.auth.uid });
    return { skills: suggestedSkills.slice(0, max) }; // Ensure max limit
  } catch (error: any) {
    functionsLogger.error("🚨 Error in suggestSkills:", { errorMessage: error.message, jobTitle, errorObj: error, uid: request.auth.uid });
    throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
  }
});

    