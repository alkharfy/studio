// functions/src/index.ts
import * as fs from 'fs'; // For local file operations if any (removed direct usage, using buffer)
// import type { CloudEvent } from "firebase-functions/v2"; // No longer v2
// import { onObjectFinalized, type StorageObjectData } from "firebase-functions/v2/storage"; // No longer v2
import { initializeApp, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore, FieldValue, setDoc as firestoreSetDoc, doc as firestoreDoc, serverTimestamp as firestoreServerTimestamp, updateDoc as firestoreUpdateDoc } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { VertexAI, type Content } from "@google-cloud/vertexai";
import * as functions from "firebase-functions";
// import { logger as functionsLogger } from "firebase-functions/logger"; // Use functions.logger for v1
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
const GCP_PROJECT_ID_ENV = process.env.GCLOUD_PROJECT; // Standard env var for GCP project ID
const DOC_PROCESSOR_PATH_ENV = process.env.CV_DOC_PROCESSOR_PATH;


const gcpProjectId = GCP_PROJECT_ID_ENV || functions.config().cv?.project_id;
const vertexModelConfig = VERTEX_MODEL_ENV || functions.config().cv?.vertex_model;
const docProcessorPathConfig = DOC_PROCESSOR_PATH_ENV || functions.config().cv?.doc_processor_path;


functions.logger.info("Initial Configuration Check:", {
    vertexModelConfigValue: vertexModelConfig,
    gcpProjectIdValue: gcpProjectId,
    docProcessorPathConfigValue: docProcessorPathConfig,
    VERTEX_MODEL_ENV,
    GCP_PROJECT_ID_ENV,
    DOC_PROCESSOR_PATH_ENV,
    firebaseFunctionsConfigCV: functions.config().cv,
});

let generativeModel: ReturnType<VertexAI["getGenerativeModel"]> | undefined;

if (vertexModelConfig && gcpProjectId) {
  try {
    const vertexAI = new VertexAI({ project: gcpProjectId, location: "us-central1" });
    generativeModel = vertexAI.getGenerativeModel({ model: vertexModelConfig });
    functions.logger.info("Vertex AI client initialized successfully.");
  } catch (clientInitError: any) {
    functions.logger.error("Error initializing Vertex AI client:", {
      errorMessage: clientInitError.message,
      errorStack: clientInitError.stack,
      vertexModelConfig,
      gcpProjectId
    });
  }
} else {
  functions.logger.error("CRITICAL: Vertex AI model or GCP Project ID is NOT configured. Function will not process PDFs correctly.", {
    hasVertexModel: !!vertexModelConfig,
    hasGcpProjectId: !!gcpProjectId
  });
}

// Determine the correct bucket name based on environment
const bucketNameToListen = process.env.FUNCTIONS_EMULATOR === 'true'
    ? 'default-bucket' // Default bucket for Firebase Storage Emulator
    : gcpProjectId ? `${gcpProjectId}.appspot.com` : undefined;

if (!bucketNameToListen) {
    functions.logger.error("CRITICAL: Cannot determine bucket to listen on. GCLOUD_PROJECT env var might be missing for production, or not in emulator mode. Function will not trigger.");
} else {
    functions.logger.info(`Function will listen on bucket: ${bucketNameToListen}`);
}


export const parseResumePdf = functions
  .region("us-central1") // Specify region for v1
  .runWith({ memory: "1GiB", timeoutSeconds: 540 }) // Specify runtime options for v1
  .storage
  .bucket(bucketNameToListen!) // Specify bucket for v1, ensure bucketNameToListen is defined
  .object()
  .onFinalize(async (object, context) => { // v1 trigger signature
    const { bucket, name, metageneration, timeCreated, updated } = object; // object directly contains these
    const eventId = context.eventId; // Get eventId from context for v1

    functions.logger.info(`🔔 Function TRIGGERED. Event ID: ${eventId}, Bucket: ${bucket}, File: ${name}, Metageneration: ${metageneration}, TimeCreated: ${timeCreated}, Updated: ${updated}`);

    if (!name) {
      functions.logger.warn("Object name is undefined, exiting.", { eventId });
      return;
    }

    // Check for metageneration to avoid infinite loops from updates by the function itself
    // This check might be too aggressive if metadata updates are legitimate triggers for some workflows,
    // but for PDF parsing, we typically only want to run on initial upload or significant content changes.
    if (metageneration && parseInt(metageneration, 10) > 1) {
        functions.logger.info(`Skipping processing for metadata update (metageneration: ${metageneration}) for file: ${name}`, { eventId });
        return;
    }
    
    // Check if file is in the correct path (v1 doesn't have eventFilters like v2 Storage)
    // However, the `object()` trigger in v1 listens to all objects in the specified bucket.
    // We must filter by path prefix inside the function.
    if (!name.startsWith("resumes_uploads/")) {
        functions.logger.info(`File ${name} is not in resumes_uploads/, skipping.`);
        return;
    }

    // Extract UID from the path: resumes_uploads/UID/fileName.pdf
    const pathParts = name.split("/");
    if (pathParts.length < 3 || pathParts[0] !== "resumes_uploads" || !pathParts[1]) {
        functions.logger.error(`Could not extract UID from path or invalid path structure: ${name}. Expected format 'resumes_uploads/UID/filename.pdf'`, { eventId, pathParts });
        return;
    }
    const uid = pathParts[1];
    functions.logger.info(`Extracted UID: ${uid} from path: ${name}`, { eventId });

    const fileName = pathParts[pathParts.length -1]; // Get the actual file name

    // Check if Vertex AI and Document AI are configured
    if (!generativeModel || !vertexModelConfig || !gcpProjectId || !docProcessorPathConfig) {
      functions.logger.error("CRITICAL: Vertex AI or Document AI services not initialized due to missing configuration. Aborting parseResumePdf for file.", {
        fileName,
        uid,
        eventId,
        hasGenModel: !!generativeModel,
        hasVertexModelConfig: !!vertexModelConfig,
        hasDocProcessorPathConfig: !!docProcessorPathConfig,
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
          functions.logger.error("Failed to write config_error_services_not_initialized to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId });
      }
      return;
    }

    functions.logger.info("Using Vertex AI Model:", { model: vertexModelConfig });
    functions.logger.info("Using Document AI Processor Path:", { processor: docProcessorPathConfig });


    const tempFilePath = `/tmp/${fileName.replace(/\//g, '_')}`; // Ensure fileName is safe for tmp path

    try {
      functions.logger.info(`Attempting to download ${name} from bucket ${bucket}`, { eventId });
      await adminStorage.bucket(bucket).file(name).download({ destination: tempFilePath });
      functions.logger.info(`📄 File downloaded to ${tempFilePath}`, { name, eventId });

      const fileContentBuffer = fs.readFileSync(tempFilePath); // Read from temp file as buffer

      let rawText = "";
      // Try pdf.js first for local text extraction (fallback or primary if Document AI fails/not configured fully)
      try {
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileContentBuffer) });
        const pdfDocument = await loadingTask.promise;
        functions.logger.info(`pdf.js: Number of pages: ${pdfDocument.numPages}`, { name, eventId });

        for (let i = 1; i <= pdfDocument.numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const textContent = await page.getTextContent();
            rawText += textContent.items.map((item: any) => (item && typeof item.str === 'string' ? item.str : '')).join(" ") + "\n";
        }
        functions.logger.info(`📝 pdf.js extracted text length: ${rawText.length}`, { name, eventId });

      } catch (pdfJsError: any) {
        functions.logger.warn("⚠️ pdf.js text extraction failed. Will proceed if Document AI is primary. If Document AI also fails, this will be an issue.", { errorMessage: pdfJsError.message, name, eventId });
        // Do not return here if Document AI is the primary method, let it try.
        // If pdf.js is the primary, then an error should be recorded.
      }

      // If pdf.js didn't yield text, or if Document AI is preferred, use Document AI
      if (!rawText.trim()) {
          functions.logger.info("pdf.js yielded no text or Document AI is preferred. Attempting Document AI OCR.", {name, eventId});
          try {
              const docAIClient = new functions.google.documentai.v1.DocumentProcessorServiceClient();
              const [docAiResult] = await docAIClient.processDocument({
                  name: docProcessorPathConfig, // Use the configured processor path
                  rawDocument: { content: fileContentBuffer, mimeType: "application/pdf" },
              });
              rawText = docAiResult.document?.text ?? "";
              functions.logger.info("📝 Document AI OCR extracted text length:", rawText.length, {name, eventId});
          } catch (docAiError: any) {
              functions.logger.error("🚨 Document AI OCR error:", { errorMessage: docAiError.message, name, eventId, errorObj: docAiError });
              const errorResumeId = Date.now().toString();
              await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
                  parsingError: `doc_ai_ocr_error: ${docAiError.message.substring(0,100)}`,
                  storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
              });
              return;
          }
      }


      if (!rawText.trim()) {
        functions.logger.warn("OCR result is empty (from both pdf.js and Document AI). Writing parsingError to Firestore.", { name, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ocr_empty_result",
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      const textSnippet = rawText.slice(0, 15000);
      functions.logger.info(`Using text snippet for Vertex AI (length: ${textSnippet.length})`, { eventId });

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
        functions.logger.info(`🎯 Vertex AI raw JSON string: "${jsonString}"`, { name, eventId, length: jsonString.length });
      } catch (vertexError: any) {
         functions.logger.error("🚨 Vertex AI processing error:", { errorMessage: vertexError.message, errorDetails: vertexError.details, code: vertexError.code, name, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `vertex_ai_error: ${vertexError.code || 'UNKNOWN'} - ${vertexError.message.substring(0,100)}`,
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }


      if (!jsonString.trim()) {
        functions.logger.warn("Vertex AI returned empty string. Writing parsingError to Firestore.", { name, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "vertex_empty_response",
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      let extractedData;
      try {
        const cleanedJsonString = jsonString.replace(/```json\n?/g, "").replace(/```\n?/g, "").replace(/\n/g, "").trim();
        if (!cleanedJsonString.startsWith("{") || !cleanedJsonString.endsWith("}")) {
            throw new Error("Cleaned string is not valid JSON object format.");
        }
        extractedData = JSON.parse(cleanedJsonString);
        functions.logger.info("📊 Parsed JSON from Vertex AI (after cleaning):", { name, eventId, data: extractedData });
      } catch (e: any) {
        functions.logger.error("🚨 Failed to parse JSON from Vertex AI:", { errorMessage: e.message, rawString: jsonString, name, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
          parsingError: `vertex_json_parse_error: ${e.message.substring(0, 100)}`,
          rawAiOutput: jsonString.substring(0, 1000),
          storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }


      if (!extractedData.personalInfo?.fullName) {
        functions.logger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError to Firestore.", { name, extractedData, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname",
            extractedData: extractedData,
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return;
      }

      const resumeId = Date.now().toString();
      const resumeDocRef = firestoreDoc(db, "users", uid, "resumes", resumeId);
      functions.logger.info(`Attempting to write to Firestore path: users/${uid}/resumes/${resumeId}`, { eventId });

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
        rawAiOutput: jsonString.substring(0,1000),
        storagePath: name,
        originalFileName: fileName,
        createdAt: firestoreServerTimestamp() as any,
        updatedAt: firestoreServerTimestamp() as any,
      };

      await firestoreSetDoc(resumeDocRef, finalResumeData);
      functions.logger.log(`✅ Successfully wrote resume to users/${uid}/resumes/${resumeId}`, { name, eventId, firestorePath: resumeDocRef.path });

      try {
        await adminStorage.bucket(bucket).file(name).setMetadata({ metadata: { firebaseStorageDownloadTokens: null, resumeId: resumeId, parsingStatus: 'completed', firestorePath: resumeDocRef.path } });
        functions.logger.info("✅ Set metadata on storage object:", { name, resumeId, eventId });
      } catch (metaError: any) {
        functions.logger.error("🚨 Error setting metadata on storage object:", { name, errorMessage: metaError.message, metaErrorObj: metaError, eventId });
      }

      try {
        const userDocRef = firestoreDoc(db, "users", uid);
        await firestoreUpdateDoc(userDocRef, { latestResumeId: resumeId, updatedAt: firestoreServerTimestamp() });
        functions.logger.info("✅ Updated latestResumeId for user:", { uid, resumeId, eventId });
      } catch (userUpdateError: any) {
         functions.logger.error("🚨 Error updating latestResumeId for user:", { uid, resumeId, errorMessage: userUpdateError.message, userUpdateErrorObj: userUpdateError, eventId });
      }


    } catch (error: any) {
      functions.logger.error("🚨 Unhandled error in parseResumePdf:", { name, errorMessage: error.message, errorObj: error, eventId });
      const errorResumeId = Date.now().toString();
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `unknown_function_error: ${error.message.substring(0, 100)}`,
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
      } catch (dbError: any) {
          functions.logger.error("Failed to write unhandled_error to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId });
      }
    } finally {
      if (fs.existsSync(tempFilePath)) {
          try {
              fs.unlinkSync(tempFilePath);
              functions.logger.info("🗑️ Temporary file deleted:", tempFilePath);
          } catch (unlinkError: any) { // Add type for unlinkError
              functions.logger.error("🚨 Error deleting temporary file:", { message: unlinkError.message, path: tempFilePath });
          }
      }
    }
  }
);

// --- suggestSummary Cloud Function (HTTPS Callable) ---
// import { onCall, type CallableRequest } from "firebase-functions/v2/https"; // Use v1 https for consistency

export const suggestSummary = functions
  .region("us-central1") // Specify region for v1
  .runWith({ memory: "512MiB" }) // Specify runtime options for v1
  .https.onCall(async (data, context) => { // v1 signature: data, context
  // Check for authentication
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  // Check if Vertex AI model is initialized
  if (!generativeModel) {
    functions.logger.error("Vertex AI service not initialized for suggestSummary. Missing configuration.");
    throw new functions.https.HttpsError('internal', 'AI service not available. Please try again later.');
  }

  const { jobTitle, yearsExp = 0, skills = [], lang = "ar" } = data; // data directly holds the payload

  if (!jobTitle || typeof jobTitle !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
  }
  functions.logger.info("suggestSummary called with:", { jobTitle, yearsExp, skills, lang, uid: context.auth.uid });

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

    functions.logger.info("💡 suggestSummary AI response:", { jobTitle, summaryText, uid: context.auth.uid });
    return { summary: summaryText.trim() };
  } catch (error: any) {
    functions.logger.error("🚨 Error in suggestSummary:", { errorMessage: error.message, jobTitle, errorObj: error, uid: context.auth.uid });
    throw new functions.https.HttpsError('internal', 'Failed to generate summary.', error.message);
  }
});

// --- suggestSkills Cloud Function (HTTPS Callable) ---
export const suggestSkills = functions
  .region("us-central1") // Specify region for v1
  .runWith({ memory: "512MiB" }) // Specify runtime options for v1
  .https.onCall(async (data, context) => { // v1 signature
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  if (!generativeModel) {
    functions.logger.error("Vertex AI service not initialized for suggestSkills. Missing configuration.");
    throw new functions.https.HttpsError('internal', 'AI service not available. Please try again later.');
  }

  const { jobTitle, max = 8, lang = "ar" } = data;

  if (!jobTitle || typeof jobTitle !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
  }
  functions.logger.info("suggestSkills called with:", { jobTitle, max, lang, uid: context.auth.uid });

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

    functions.logger.info("💡 suggestSkills AI raw response:", { jobTitle, skillsJsonString, uid: context.auth.uid });

    let suggestedSkills: string[] = [];
    try {
        const cleanedJsonString = skillsJsonString.replace(/```json\n?/g, "").replace(/```\n?/g, "").replace(/\n/g, "").trim();
        const parsed = JSON.parse(cleanedJsonString);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            suggestedSkills = parsed;
        } else {
            functions.logger.warn("suggestSkills: AI response was not a valid JSON array of strings after cleaning.", {raw: skillsJsonString, cleaned: cleanedJsonString, jobTitle, uid: context.auth.uid });
        }
    } catch (parseError: any) {
        functions.logger.error("🚨 Error parsing skills JSON from AI:", {errorMessage: parseError.message, raw: skillsJsonString, jobTitle, parseErrorObj: parseError, uid: context.auth.uid });
         if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
            suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
            functions.logger.info("Fallback: Parsed skills from comma-separated string", { suggestedSkills, uid: context.auth.uid });
         }
    }

    functions.logger.info("💡 suggestSkills processed skills:", { jobTitle, skills: suggestedSkills.slice(0, max), uid: context.auth.uid });
    return { skills: suggestedSkills.slice(0, max) };
  } catch (error: any) {
    functions.logger.error("🚨 Error in suggestSkills:", { errorMessage: error.message, jobTitle, errorObj: error, uid: context.auth.uid });
    throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
  }
});

