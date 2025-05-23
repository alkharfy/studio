// functions/src/index.ts
import * as fs from 'fs';
import { initializeApp, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore, setDoc as firestoreSetDoc, doc as firestoreDoc, serverTimestamp as firestoreServerTimestamp, updateDoc as firestoreUpdateDoc } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { VertexAI, type Content } from "@google-cloud/vertexai";
import * as functions from "firebase-functions"; // For v1 HTTPS callable functions and logger
import { onObjectFinalized, type StorageEvent, type ObjectMetadata } from "firebase-functions/v2/storage"; // For v2 Storage trigger
import type { Resume as FirestoreResumeData } from "./dbTypes";
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import { DocumentProcessorServiceClient } from "@google-cloud/documentai"; // For Document AI

// Initialize Firebase Admin SDK
if (!getAdminApps().length) {
  initializeApp();
}

// Globally initialized services
const db = getFirestore();
const adminStorage = getAdminStorage();

// Configuration for Vertex AI and Document AI
const VERTEX_MODEL_ENV = process.env.CV_VERTEX_MODEL;
const GCP_PROJECT_ID_ENV = process.env.GCLOUD_PROJECT; // This should be automatically set in Cloud Functions environment
const DOC_PROCESSOR_PATH_ENV = process.env.CV_DOC_PROCESSOR_PATH;


const gcpProjectId = GCP_PROJECT_ID_ENV || functions.config().cv?.project_id;
const vertexModelConfig = VERTEX_MODEL_ENV || functions.config().cv?.vertex_model;
// Ensure consistent casing for doc_processor_path from config
const docProcessorPathConfig = DOC_PROCESSOR_PATH_ENV || functions.config().cv?.doc_processor_path || functions.config().cv?.docprocessorpath;


functions.logger.info("Initial Configuration Check:", {
    vertexModelConfigValue: vertexModelConfig,
    gcpProjectIdValue: gcpProjectId,
    docProcessorPathConfigValue: docProcessorPathConfig,
    VERTEX_MODEL_ENV_FROM_PROCESS: process.env.CV_VERTEX_MODEL,
    GCP_PROJECT_ID_ENV_FROM_PROCESS: process.env.GCLOUD_PROJECT,
    DOC_PROCESSOR_PATH_ENV_FROM_PROCESS: process.env.CV_DOC_PROCESSOR_PATH,
    firebaseFunctionsConfigCV: functions.config().cv,
});

let generativeModel: ReturnType<VertexAI["getGenerativeModel"]> | undefined;
let docAIClient: DocumentProcessorServiceClient | undefined;


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
  functions.logger.error("CRITICAL: Vertex AI model or GCP Project ID is NOT configured for Vertex AI. Function will not process PDFs correctly.", {
    hasVertexModel: !!vertexModelConfig,
    hasGcpProjectId: !!gcpProjectId
  });
}

if (docProcessorPathConfig) {
    try {
        docAIClient = new DocumentProcessorServiceClient();
        functions.logger.info("Document AI client initialized successfully.");
    } catch(docClientError: any) {
         functions.logger.error("Error initializing Document AI client:", {
            errorMessage: docClientError.message,
            docProcessorPathConfig
        });
    }
} else {
    functions.logger.error("CRITICAL: Document AI Processor Path is NOT configured. PDF parsing will likely fail or use fallback only.", {
        hasDocProcessorPathConfig: !!docProcessorPathConfig
    });
}


// Determine the correct bucket name based on environment
// This MUST match the storageBucket in your client-side config
const BUCKET = gcpProjectId ? `${gcpProjectId}.appspot.com` : undefined; // Ensure .appspot.com

if (!BUCKET) {
    functions.logger.error("CRITICAL: Cannot determine bucket to listen on. GCLOUD_PROJECT env var might be missing for production, or not in emulator mode. Function will not trigger.");
} else {
    functions.logger.info(`Function will listen on bucket: ${BUCKET}`);
}


export const parseResumePdf = onObjectFinalized(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
    bucket: BUCKET!, // Use the determined bucket name (ensures .appspot.com)
    // REMOVED eventFilters based on path prefix - Function will check path internally
  },
  async (event: StorageEvent<ObjectMetadata>) => {
    const { bucket, name, metageneration, timeCreated, updated } = event.data;
    const eventId = event.id;

    functions.logger.info(`🔔 TRIGGERED on ${name}. Event ID: ${eventId}, Bucket: ${bucket}, Metageneration: ${metageneration}, TimeCreated: ${timeCreated}, Updated: ${updated}`);

    // Internal check for path prefix
    if (!name || !name.startsWith("resumes_uploads/")) {
        functions.logger.info(`File ${name || 'undefined'} is not in resumes_uploads/ or name is missing, skipping.`);
        return;
    }

    // Added check for metageneration to avoid potential infinite loops on metadata updates
    if (metageneration && parseInt(metageneration.toString(), 10) > 1) {
        functions.logger.info(`Skipping processing for metadata update (metageneration: ${metageneration}) for file: ${name}`, { eventId });
        return;
    }

    const pathParts = name.split("/");
    if (pathParts.length < 3 || pathParts[0] !== "resumes_uploads" || !pathParts[1]) {
        functions.logger.error(`Could not extract UID from path or invalid path structure: ${name}. Expected format 'resumes_uploads/UID/filename.pdf'`, { eventId, pathParts });
        return;
    }
    const uid = pathParts[1];
    functions.logger.info(`Extracted UID: ${uid} from path: ${name}`, { eventId });

    const fileName = pathParts[pathParts.length -1];

    // Re-check for service initialization inside the function execution context
    if (!generativeModel || !vertexModelConfig || !gcpProjectId || !docProcessorPathConfig || !docAIClient) {
      functions.logger.error("CRITICAL: Vertex AI or Document AI services not initialized due to missing configuration. Aborting parseResumePdf for file.", {
        fileName, uid, eventId,
        hasGenModel: !!generativeModel, hasVertexModelConfig: !!vertexModelConfig,
        hasDocProcessorPathConfig: !!docProcessorPathConfig, hasGcpProjectId: !!gcpProjectId, hasDocAIClient: !!docAIClient
      });
      const errorResumeId = Date.now().toString();
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "config_error_services_not_initialized", storagePath: name, originalFileName: fileName,
            createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
      } catch (dbError: any) {
          functions.logger.error("Failed to write config_error_services_not_initialized to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId });
      }
      return;
    }

    functions.logger.info("Using Vertex AI Model:", { model: vertexModelConfig });
    functions.logger.info("Using Document AI Processor Path:", { processor: docProcessorPathConfig });

    const tempFilePath = `/tmp/${fileName.replace(/\//g, '_')}`; // Sanitize filename for /tmp

    try {
      functions.logger.info(`Attempting to download ${name} from bucket ${bucket}`, { eventId });
      // Use admin SDK storage instance for download
      await adminStorage.bucket(bucket).file(name).download({ destination: tempFilePath });
      functions.logger.info(`📄 File downloaded to ${tempFilePath}`, { name, eventId });

      const fileContentBuffer = fs.readFileSync(tempFilePath);

      let rawText = "";
      try {
          const [docAiResult] = await docAIClient.processDocument({
              name: docProcessorPathConfig,
              rawDocument: { content: fileContentBuffer, mimeType: "application/pdf" },
          });
          rawText = docAiResult.document?.text ?? "";
          functions.logger.info("📝 Document AI OCR extracted text length:", rawText.length, {name, eventId});
      } catch (docAiError: any) {
          functions.logger.error("🚨 Document AI OCR error:", { errorMessage: docAiError.message, name, eventId, errorObj: docAiError });
          functions.logger.info("Attempting fallback OCR with pdf.js", {name, eventId});
          // Fallback OCR logic (pdf.js)
          try {
            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileContentBuffer) });
            const pdfDocument = await loadingTask.promise;
            let textItems: string[] = [];
            for (let i = 1; i <= pdfDocument.numPages; i++) {
                const page = await pdfDocument.getPage(i);
                const textContent = await page.getTextContent();
                 // Ensure item.str is a string before joining
                textItems.push(textContent.items.map((item: any) => (item && typeof item.str === 'string' ? item.str : '')).join(" "));
            }
            rawText = textItems.join("\n");
            functions.logger.info(`📝 pdf.js (fallback) extracted text length: ${rawText.length}`, { name, eventId });
          } catch (pdfJsError: any) {
            functions.logger.error("🚨 Fallback pdf.js OCR error:", { errorMessage: pdfJsError.message, name, eventId });
            const errorResumeId = Date.now().toString();
            await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
                parsingError: `doc_ai_and_fallback_ocr_error: ${docAiError.message.substring(0,50)} / ${pdfJsError.message.substring(0,50)}`,
                storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
            });
            return; // Stop if both OCR methods fail
          }
      }

      if (!rawText.trim()) {
        functions.logger.warn("OCR result is empty. Writing parsingError to Firestore.", { name, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ocr_empty_result", storagePath: name, originalFileName: fileName,
            createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop if no text extracted
      }

      const textSnippet = rawText.slice(0, 15000); // Limit text for Vertex AI
      functions.logger.info(`Using text snippet for Vertex AI (length: ${textSnippet.length})`, { eventId });

       // Updated Prompt with better schema definition and example
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
        // Robustly access the text part
         if (aiResponse.response?.candidates?.[0]?.content?.parts?.[0] && 'text' in aiResponse.response.candidates[0].content.parts[0]) {
            jsonString = aiResponse.response.candidates[0].content.parts[0].text || "";
        } else {
             functions.logger.warn("Vertex AI response structure unexpected or missing text part.", { name, eventId, response: aiResponse.response });
        }
        functions.logger.info(`🎯 Vertex AI raw JSON string: "${jsonString}"`, { name, eventId, length: jsonString.length });
      } catch (vertexError: any) {
         functions.logger.error("🚨 Vertex AI processing error:", { errorMessage: vertexError.message, errorDetails: vertexError.details, code: vertexError.code, name, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `vertex_ai_error: ${vertexError.code || 'UNKNOWN'} - ${vertexError.message.substring(0,100)}`,
            storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop on Vertex AI error
      }

      if (!jsonString.trim()) {
        functions.logger.warn("Vertex AI returned empty string. Writing parsingError to Firestore.", { name, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "vertex_empty_response", storagePath: name, originalFileName: fileName,
            createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop if AI returns empty string
      }

      let extractedData;
      try {
        // Attempt to clean potential markdown fences before parsing
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
          parsingError: `vertex_json_parse_error: ${e.message.substring(0, 100)}`, rawAiOutput: jsonString.substring(0, 1000), // Store raw output for debug
          storagePath: name, originalFileName: fileName, createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop on JSON parse error
      }

      // Validate crucial fields (e.g., fullName) after parsing
      if (!extractedData.personalInfo?.fullName) {
        functions.logger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError: 'ai_output_missing_fullname'.", { name, extractedData, eventId });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname", extractedData: extractedData, // Store what was extracted
            storagePath: name, originalFileName: fileName,
            createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
        return; // Stop if essential data is missing
      }


      const resumeId = Date.now().toString(); // Using timestamp for unique ID
      const resumeDocRef = firestoreDoc(db, "users", uid, "resumes", resumeId);
      functions.logger.info(`Attempting to write to Firestore path: users/${uid}/resumes/${resumeId}`, { eventId });

      // Construct the final object to save, matching the FirestoreResumeData interface and schema
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
        summary: extractedData.summary || extractedData.objective || null, // Use summary, fallback to objective for older data
        education: (extractedData.education || []).map((edu: any) => ({
            degree: edu.degree || null,
            institution: edu.institution || edu.institute || null, // Handle both institution/institute
            graduationYear: edu.graduationYear || edu.year || null, // Handle both graduationYear/year
            details: edu.details || null, // Include details
        })).filter((edu: any) => edu.degree || edu.institution || edu.graduationYear), // Filter out empty entries
        experience: (extractedData.experience || []).map((exp: any) => ({
            jobTitle: exp.jobTitle || exp.title || null, // Handle both jobTitle/title
            company: exp.company || null,
            startDate: exp.startDate || exp.start || null, // Handle both startDate/start
            endDate: exp.endDate || exp.end || null, // Handle both endDate/end
            description: exp.description || null,
        })).filter((exp: any) => exp.jobTitle || exp.company || exp.startDate), // Filter out empty entries
        skills: (extractedData.skills || []).map((skill: any) => ({
            name: typeof skill === 'string' ? skill : (skill?.name || null) // Handle if AI returns array of strings or objects
        })).filter((s: any) => s.name), // Filter out empty/invalid skills
        languages: (extractedData.languages || []).filter((lang: any) => lang.name), // Ensure language has a name
        hobbies: extractedData.hobbies || [],
        customSections: extractedData.customSections || [], // Assuming customSections might be extracted

        // Metadata
        parsingDone: true, // Set flag on success
        parsingError: null, // Explicitly set to null on success
        rawAiOutput: jsonString.substring(0,1000), // Store snippet for debugging
        storagePath: name,
        originalFileName: fileName, // Store the original file name
        createdAt: firestoreServerTimestamp() as any, // Cast needed for admin SDK
        updatedAt: firestoreServerTimestamp() as any, // Cast needed for admin SDK
      };

      await firestoreSetDoc(resumeDocRef, finalResumeData);
      functions.logger.log(`✅ Successfully wrote resume to users/${uid}/resumes/${resumeId}`, { name, eventId, firestorePath: resumeDocRef.path });

      // Optional: Update metadata on the storage object
      try {
        await adminStorage.bucket(bucket).file(name).setMetadata({ metadata: { firebaseStorageDownloadTokens: null, resumeId: resumeId, parsingStatus: 'completed', firestorePath: resumeDocRef.path } });
        functions.logger.info("✅ Set metadata on storage object:", { name, resumeId, eventId });
      } catch (metaError: any) {
        functions.logger.error("🚨 Error setting metadata on storage object:", { name, errorMessage: metaError.message, metaErrorObj: metaError, eventId });
      }

      // Update user's latestResumeId
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
      // Attempt to write an error document to Firestore
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: `unknown_function_error: ${error.message.substring(0, 100)}`, storagePath: name, originalFileName: fileName,
            createdAt: firestoreServerTimestamp(), updatedAt: firestoreServerTimestamp(), resumeId: errorResumeId, userId: uid,
        });
      } catch (dbError: any) {
          functions.logger.error("Failed to write unhandled_error to Firestore", { dbErrorMessage: dbError.message, uid, errorResumeId, eventId });
      }
    } finally {
      // Clean up the temporary file
      if (fs.existsSync(tempFilePath)) {
          try {
              fs.unlinkSync(tempFilePath);
              functions.logger.info("🗑️ Temporary file deleted:", tempFilePath);
          } catch (unlinkError: any) {
              functions.logger.error("🚨 Error deleting temporary file:", { message: unlinkError.message, path: tempFilePath });
          }
      }
    }
  }
);


// --- suggestSummary Cloud Function (HTTPS Callable v1) ---
export const suggestSummary = functions
  .region("us-central1")
  .runWith({ memory: "512MiB" })
  .https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  if (!generativeModel) {
    functions.logger.error("Vertex AI service not initialized for suggestSummary. Missing configuration.");
    throw new functions.https.HttpsError('internal', 'AI service not available. Please try again later.');
  }

  const { jobTitle, yearsExp = 0, skills = [], lang = "ar" } = data;

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

// --- suggestSkills Cloud Function (HTTPS Callable v1) ---
export const suggestSkills = functions
  .region("us-central1")
  .runWith({ memory: "512MiB" })
  .https.onCall(async (data, context) => {
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
         // Fallback: try to extract skills if it's a comma-separated list or similar
         if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
            suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
            functions.logger.info("Fallback: Parsed skills from comma-separated string", { suggestedSkills, uid: context.auth.uid });
         }
    }
    functions.logger.info("💡 suggestSkills processed skills:", { jobTitle, skills: suggestedSkills.slice(0, max), uid: context.auth.uid });
    return { skills: suggestedSkills.slice(0, max) }; // Ensure max limit
  } catch (error: any) {
    functions.logger.error("🚨 Error in suggestSkills:", { errorMessage: error.message, jobTitle, errorObj: error, uid: context.auth.uid });
    throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
  }
});
