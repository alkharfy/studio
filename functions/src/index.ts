// functions/src/index.ts
import * as fs from 'fs';

import type { CloudEvent } from "firebase-functions/v2";
import { onObjectFinalized, type StorageObjectData } from "firebase-functions/v2/storage";
import { initializeApp, getApps as getAdminApps } from "firebase-admin/app";
import { getFirestore, FieldValue, setDoc as firestoreSetDoc, doc as firestoreDoc, serverTimestamp as firestoreServerTimestamp } from "firebase-admin/firestore"; // Corrected serverTimestamp import
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { VertexAI, type Content, type Part } from "@google-cloud/vertexai";
import * as functions from "firebase-functions";
import { HttpsCallableContext, CallableRequest, onCall } from "firebase-functions/v2/https";
import { logger as functionsLogger } from "firebase-functions/logger";
import type { Resume as FirestoreResumeData } from "./dbTypes"; // Import the dbTypes

// Initialize Firebase Admin SDK
if (!getAdminApps().length) {
  initializeApp();
}

// Globally initialized services
const db = getFirestore();
const adminStorage = getAdminStorage();

// Configuration for Document AI and Vertex AI
// Prefer environment variables, then fallback to Firebase functions config
const docProcessorPathConfig = process.env.CV_DOC_PROCESSOR_PATH || functions.config().cv?.doc_processor_path;
const vertexModelConfig = process.env.CV_VERTEX_MODEL || functions.config().cv?.vertex_model;
const gcpProjectId = process.env.GCLOUD_PROJECT; // Automatically available in Cloud Functions

let docaiClient: DocumentProcessorServiceClient | undefined;
let generativeModel: ReturnType<VertexAI["getGenerativeModel"]> | undefined;

if (docProcessorPathConfig && vertexModelConfig && gcpProjectId) {
  // Assuming processor is in 'us' region as per typical setup and DOC_PROCESSOR_PATH structure
  docaiClient = new DocumentProcessorServiceClient({ apiEndpoint: "us-documentai.googleapis.com" });
  const vertexAI = new VertexAI({ project: gcpProjectId, location: "us-central1" }); // Vertex AI common location
  generativeModel = vertexAI.getGenerativeModel({ model: vertexModelConfig });
  functionsLogger.info("Document AI and Vertex AI clients initialized.", { docProcessorPathConfig, vertexModelConfig });
} else {
  functionsLogger.error("Critical: Document AI processor path or Vertex AI model or GCP Project ID is not configured. Check environment variables (CV_DOC_PROCESSOR_PATH, CV_VERTEX_MODEL) or Firebase functions.config().");
}

export const parseResumePdf = onObjectFinalized(
  {
    region: "us-central1", // Deployment region for the function itself
    bucket: `${gcpProjectId}.appspot.com`, // Default bucket associated with the project
    eventFilters: { ["object.name"]: "resumes_uploads/**" }, // Trigger only for this path
    memory: "1GiB",
    timeoutSeconds: 540,
    cpu: 1,
  },
  async (event: CloudEvent<StorageObjectData>) => {
    const { bucket, name, metageneration } = event.data;

    if (!name) {
      functionsLogger.log("Object name is undefined, exiting.");
      return;
    }

    // Avoid infinite loops from metadata updates by the function itself
    if (metageneration && parseInt(metageneration as string, 10) > 1) {
      functionsLogger.log("This is a metadata update event, not a new upload. Skipping.", { name, metageneration });
      return;
    }

    functionsLogger.log("🔔 TRIGGERED on", name);

    if (!name.startsWith("resumes_uploads/")) {
      functionsLogger.log("File is not in resumes_uploads/, skipping.", { name });
      return;
    }

    const uid = name.split("/")[1];
    if (!uid) {
      functionsLogger.error("Could not extract UID from path:", name);
      return;
    }

    const fileName = name.split("/").pop()!; // Should always exist if name is valid
    const tempFilePath = `/tmp/${fileName}`;

    if (!docaiClient || !generativeModel || !docProcessorPathConfig) {
      functionsLogger.error("Document AI or Vertex AI services not initialized due to missing configuration. Aborting parseResumePdf.", { name });
      const errorResumeId = Date.now().toString();
      await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
        parsingError: "config_error_services_not_initialized",
        storagePath: name,
        originalFileName: fileName,
        createdAt: firestoreServerTimestamp(),
        updatedAt: firestoreServerTimestamp(),
      });
      return;
    }

    try {
      // 1. Download file
      await adminStorage.bucket(bucket).file(name).download({ destination: tempFilePath });
      functionsLogger.log("📄 File downloaded to", tempFilePath, { name });

      // 2. OCR via Document AI
      const fileContent = fs.readFileSync(tempFilePath);
      const [docAiResult] = await docaiClient!.processDocument({
        name: docProcessorPathConfig, // Full processor path
        rawDocument: { content: fileContent, mimeType: "application/pdf" },
      });
      const rawText = docAiResult.document?.text || "";
      functionsLogger.log("📝 OCR extracted text length:", rawText.length, { name });

      if (!rawText.trim()) {
        functionsLogger.warn("OCR result is empty. Writing parsingError to Firestore.", { name });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ocr_empty_result",
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
        });
        return; // Stop further processing
      }

      const textSnippet = rawText.slice(0, 15000); // Limit text for Vertex AI

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

      const aiResponse = await generativeModel!.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
      let jsonString = "";
      // Robustly access the text part of the response
      if (aiResponse.response && aiResponse.response.candidates && aiResponse.response.candidates.length > 0) {
          const responseContent = aiResponse.response.candidates[0].content;
          if (responseContent?.parts?.[0] && 'text' in responseContent.parts[0]) {
              jsonString = responseContent.parts[0].text || "";
          }
      }
      functionsLogger.info("🎯 Vertex AI raw JSON string:", jsonString, { name });

      if (!jsonString.trim()) {
        functionsLogger.warn("Vertex AI returned empty string. Writing parsingError to Firestore.", { name });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "vertex_empty_response",
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
        });
        return;
      }

      let extractedData;
      try {
        extractedData = JSON.parse(jsonString);
      } catch (e: any) { // Explicitly type 'e'
        functionsLogger.error("🚨 Failed to parse JSON from Vertex AI:", e.message, "Raw string:", jsonString, { name });
        const errorResumeId = Date.now().toString(); // Use a different ID for error doc
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
          parsingError: `vertex_json_parse_error: ${e.message}`,
          rawAiOutput: jsonString, // Store the problematic string for debugging
          storagePath: name,
          originalFileName: fileName,
          createdAt: firestoreServerTimestamp(),
          updatedAt: firestoreServerTimestamp(),
        });
        return; // Stop processing
      }
      functionsLogger.log("📊 Parsed JSON from Vertex AI:", extractedData, { name });

      // Validate crucial fields (e.g., fullName)
      if (!extractedData.personalInfo?.fullName) {
        functionsLogger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError to Firestore.", { name, extractedData });
        const errorResumeId = Date.now().toString();
        await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname",
            extractedData: extractedData, // Store what was extracted
            storagePath: name,
            originalFileName: fileName,
            createdAt: firestoreServerTimestamp(),
            updatedAt: firestoreServerTimestamp(),
        });
        return;
      }

      // 4. Write to Firestore
      const resumeId = Date.now().toString(); // Use a simple timestamp-based ID
      const resumeDocRef = firestoreDoc(db, "users", uid, "resumes", resumeId);

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
        education: (extractedData.education || []).map((edu: any) => ({ // Add type for edu
            degree: edu.degree || null,
            institution: edu.institution || edu.institute || null, // Handle both institution/institute
            graduationYear: edu.graduationYear || edu.year || null, // Handle both graduationYear/year
            details: edu.details || null,
        })),
        experience: (extractedData.experience || []).map((exp: any) => ({ // Add type for exp
            jobTitle: exp.jobTitle || exp.title || null, // Handle both jobTitle/title
            company: exp.company || null,
            startDate: exp.startDate || exp.start || null, // Handle both startDate/start
            endDate: exp.endDate || exp.end || null,
            description: exp.description || null,
        })),
        skills: (extractedData.skills || []).map((skill: any) => ({ // Add type for skill
            name: typeof skill === 'string' ? skill : (skill?.name || null)
        })).filter((s: any) => s.name), // Filter out empty/invalid skills
        languages: extractedData.languages || [],
        hobbies: extractedData.hobbies || [],
        customSections: extractedData.customSections || [], // Assuming customSections might be extracted
        // Metadata
        parsingDone: true,
        parsingError: null, // Explicitly set to null on success
        storagePath: name,
        originalFileName: fileName, // Store the original file name
        createdAt: firestoreServerTimestamp(),
        updatedAt: firestoreServerTimestamp(),
      };

      await firestoreSetDoc(resumeDocRef, finalResumeData as any); // Cast to any if type mismatches are complex during dev
      functionsLogger.log("✅ Successfully wrote resume to users/%s/resumes/%s", uid, resumeId, { name });

      // Set metadata on the storage object
      try {
        await adminStorage.bucket(bucket).file(name).setMetadata({ metadata: { resumeId: resumeId, parsingStatus: 'completed' } });
        functionsLogger.log("✅ Set metadata on storage object:", name, { resumeId });
      } catch (metaError: any) {
        functionsLogger.error("🚨 Error setting metadata on storage object:", metaError.message, { name, metaErrorObj: metaError });
      }

      // Update latestResumeId on the user document
      try {
        await firestoreSetDoc(firestoreDoc(db, "users", uid), { latestResumeId: resumeId, updatedAt: firestoreServerTimestamp() }, { merge: true });
        functionsLogger.log("✅ Updated latestResumeId for user:", uid, { resumeId });
      } catch (userUpdateError: any) {
         functionsLogger.error("🚨 Error updating latestResumeId for user:", userUpdateError.message, { uid, resumeId, userUpdateErrorObj: userUpdateError });
      }


    } catch (error: any) { // Explicitly type 'error'
      functionsLogger.error("🚨 Unhandled error in parseResumePdf:", error.message, { name, errorObj: error });
      // Attempt to write an error document to Firestore
      const errorResumeId = Date.now().toString();
      await firestoreSetDoc(firestoreDoc(db, "users", uid, "resumes", errorResumeId), {
        parsingError: `unknown_function_error: ${error.message}`,
        storagePath: name,
        originalFileName: fileName, // Include originalFileName here too
        createdAt: firestoreServerTimestamp(),
        updatedAt: firestoreServerTimestamp(),
      });
    } finally {
      // Clean up the temporary file
      if (fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          functionsLogger.log("🗑️ Temporary file deleted:", tempFilePath, { name });
        } catch (unlinkError: any) { // Explicitly type 'unlinkError'
          functionsLogger.error("🚨 Error deleting temporary file:", unlinkError.message, { name, unlinkErrorObj: unlinkError });
        }
      }
    }
  }
);


// --- suggestSummary Cloud Function (HTTPS Callable) ---
export const suggestSummary = onCall(
  // Options for the function, e.g., region, memory
  // { region: "us-central1", memory: "512MiB" },
  async (request: CallableRequest<{ jobTitle?: string; yearsExp?: number; skills?: string[]; lang?: string }>) => { // Removed context argument as it is not used
    const data = request.data;
  // Check for authentication using the passed context
  // request.auth will be populated if the function is called by an authenticated user
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
    const aiResponse = await generativeModel!.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const responseContent: Content | null = aiResponse.response.candidates?.[0]?.content ?? null;
    let summaryText = "";

    // Robustly get text from response part
     if (responseContent && responseContent.parts && responseContent.parts.length > 0) {
         // Find the first part that is a text part
         const textPart = responseContent.parts.find((part: Part): part is { text: string } => 'text' in part) as { text: string } | undefined;
         if (textPart) {
            summaryText = textPart.text || "";
         } else if (responseContent.parts[0] && 'text' in responseContent.parts[0]) { // Fallback for older structure or if find doesn't work as expected
            summaryText = responseContent.parts[0].text || "";
         }
     }


    functionsLogger.info("💡 suggestSummary AI response:", { jobTitle, summaryText });
    return { summary: summaryText.trim() };
  } catch (error: any) { // Explicitly type 'error'
    functionsLogger.error("🚨 Error in suggestSummary:", error.message, { jobTitle, errorObj: error });
    throw new functions.https.HttpsError('internal', 'Failed to generate summary.', error.message);
  }
});


export const suggestSkills = onCall( // Changed from functions.https.onCall to onCall
  async (request: CallableRequest<{ jobTitle?: string; max?: number; lang?: string }>) => { // Removed context, use request.auth
    const data = request.data;
  if (!request.auth) { // Check auth from request
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
    const aiResponse = await generativeModel!.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const responseContent: Content | null = aiResponse.response.candidates?.[0]?.content ?? null;
    let skillsJsonString = "";
    // Robustly get text from response part
    if (responseContent && responseContent.parts && responseContent.parts.length > 0) {
         const textPart = responseContent.parts.find((part: Part): part is { text: string } => 'text' in part) as { text: string } | undefined;
         if (textPart) {
            skillsJsonString = textPart.text || "[]"; // Default to empty array string if text is undefined
         } else if (responseContent.parts[0] && 'text' in responseContent.parts[0]) { // Fallback
            skillsJsonString = responseContent.parts[0].text || "[]";
         }
     }
    
    functionsLogger.info("💡 suggestSkills AI response:", { jobTitle, skillsJsonString });
    // Attempt to parse the string, ensure it's an array of strings
    let suggestedSkills: string[] = [];
    try {
        const parsed = JSON.parse(skillsJsonString);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            suggestedSkills = parsed;
        } else {
            // Log if the structure is not as expected but still valid JSON
            functionsLogger.warn("suggestSkills: AI response was not a valid JSON array of strings. Raw:", skillsJsonString, { jobTitle });
        }
    } catch (parseError: any) { // Explicitly type 'parseError'
        functionsLogger.error("🚨 Error parsing skills JSON from AI:", parseError.message, "Raw:", skillsJsonString, { jobTitle, parseErrorObj: parseError });
         // Fallback for non-JSON string: try to split by comma if it's a simple list
         if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
            suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
         }
    }

    return { skills: suggestedSkills.slice(0, max) }; // Ensure max limit
  } catch (error: any) { // Explicitly type 'error'
    functionsLogger.error("🚨 Error in suggestSkills:", error.message, { jobTitle, errorObj: error });
    throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
  }
});

    
