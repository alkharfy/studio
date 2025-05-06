
import * as functions from "firebase-functions"; // Import functions to access config
import * as logger from "firebase-functions/logger";
import { onObjectFinalized, type CloudEvent } from "firebase-functions/v2/storage";
import type { StorageObjectData } from "firebase-functions/v2/storage"; // Import StorageObjectData
import { getStorage } from "firebase-admin/storage";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'; // Ensure Firestore and types are imported
import * as admin from 'firebase-admin'; // Ensure admin is imported for serverTimestamp()
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { VertexAI } from "@google-cloud/vertexai";
// Ensure setDoc and doc are imported if still needed, though the user's prompt for parseResumePdf uses getFirestore() directly.
import { setDoc, doc } from 'firebase-admin/firestore'; // Make sure setDoc and doc are imported

// Initialize Firebase Admin SDK if not already done (crucial for Firestore/Storage access)
if (admin.apps.length === 0) {
    admin.initializeApp();
}

const db = getFirestore(); // Get Firestore instance

// --- Configuration ---
// Prefer environment variables if set, otherwise use Functions config
const processorPath = process.env.CV_DOC_PROCESSOR_PATH || functions.config().cv?.doc_processor_path;
const vertexModelName = process.env.CV_VERTEX_MODEL || functions.config().cv?.vertex_model;
const gcpProject = process.env.GCLOUD_PROJECT || functions.config().cv?.project_id;
const docAiRegion = process.env.DOC_AI_REGION || 'us';
const vertexAiRegion = process.env.VERTEX_AI_REGION || 'us-central1';

// --- BUCKET constant derived from project ID ---
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || (gcpProject ? `${gcpProject}.appspot.com` : undefined);

if (!BUCKET) {
    logger.error("FATAL: Firebase Storage Bucket is not configured (env FIREBASE_STORAGE_BUCKET or GCLOUD_PROJECT missing for default).");
    // Consider throwing an error if BUCKET is essential and cannot be determined.
} else {
    logger.info(`Targeting bucket: ${BUCKET}`);
}


// --- Validation ---
if (!processorPath) {
    logger.error("FATAL: Document AI Processor Path is not configured (env CV_DOC_PROCESSOR_PATH or functions.config().cv.doc_processor_path)");
    // It's crucial to stop execution if configuration is missing.
    // throw new Error("Document AI Processor Path is not configured.");
} else {
    logger.info(`Using Document AI Processor: ${processorPath}`);
}
if (!vertexModelName) {
    logger.error("FATAL: Vertex AI Model is not configured (env CV_VERTEX_MODEL or functions.config().cv.vertex_model)");
    // throw new Error("Vertex AI Model is not configured.");
} else {
    logger.info(`Using Vertex AI Model: ${vertexModelName}`);
}
if (!gcpProject) {
     logger.error("FATAL: GCP Project ID is not configured (env GCLOUD_PROJECT or functions.config().cv.project_id)");
     // throw new Error("GCP Project ID is not configured.");
} else {
    logger.info(`Using GCP Project: ${gcpProject}`);
}


// Initialize Clients (handle potential errors)
let docai: DocumentProcessorServiceClient | null = null;
let vertex: VertexAI | null = null;
let textGen: ReturnType<VertexAI['getGenerativeModel']> | null = null;

try {
    // Explicitly set the endpoint region for Document AI client
    docai = new DocumentProcessorServiceClient({ apiEndpoint: `${docAiRegion}-documentai.googleapis.com` });
    logger.info(`Document AI Client initialized for region: ${docAiRegion}`);
} catch (e: any) {
    logger.error("Error initializing Document AI Client:", e.message || e);
    docai = null;
}

try {
    // Explicitly set project and location for Vertex AI client
    vertex = new VertexAI({ project: gcpProject, location: vertexAiRegion });
    logger.info(`Vertex AI Client initialized for project: ${gcpProject}, location: ${vertexAiRegion}`);
    if (vertex && vertexModelName) {
         textGen = vertex.getGenerativeModel({ model: vertexModelName });
         logger.info(`Vertex AI Model (${vertexModelName}) loaded.`);
    } else if (!vertexModelName) {
        logger.error("Vertex AI model name is missing, cannot load model.");
    }
} catch (e: any) {
    logger.error("Error initializing Vertex AI Client or Model:", e.message || e);
    vertex = null;
    textGen = null;
}


// --- parseResumePdf Cloud Function (Updated for Debugging Trigger) ---
export const parseResumePdf = onObjectFinalized(
    {
        region: "us-central1", // Keep region consistent or use vertexAiRegion if preferred
        // Explicitly use the derived bucket name
        bucket: BUCKET, // Ensure BUCKET is correctly derived above
        // Explicitly filter for the desired path prefix
        eventFilters: { "object.name": "resumes_uploads/**" },
        memory: "1GiB",
        timeoutSeconds: 540,
        cpu: 1, // Keep CPU setting if needed
    },
    async (event: CloudEvent<StorageObjectData>) => {
        // Add log at the very beginning to confirm trigger
        logger.log("🔔 TRIGGERED on", event.data.name);
        console.log("🔔 TRIGGERED on", event.data.name); // Added console.log as well for visibility

        // --- Essential Checks ---
        if (!docai || !textGen) {
            logger.error("FATAL: API clients not initialized. Exiting function.");
            return;
        }
        if (!processorPath) {
            logger.error("FATAL: Document AI Processor Path is not configured. Exiting function.");
            return;
        }
        if (!vertexModelName) {
            logger.error("FATAL: Vertex AI Model Name is not configured. Exiting function.");
            return;
        }

        const { bucket, name, metadata } = event.data; // event.data contains the object details

        // Double check the path prefix (although eventFilters should handle this)
        if (!name?.startsWith("resumes_uploads/")) {
            logger.warn(`Ignoring file outside 'resumes_uploads/' despite filter: ${name}`);
            return;
        }

        // --- Extract UID ---
        let uid: string | undefined;
        const pathParts = name.split("/"); // e.g., ["resumes_uploads", "user123", "my_cv.pdf"]
        if (pathParts.length >= 3 && pathParts[0] === "resumes_uploads") {
            uid = pathParts[1];
            logger.log(`Extracted UID from path: ${uid}`);
        } else {
             // Fallback to metadata if path structure is different (though unlikely with filter)
             uid = metadata?.uid;
             if (uid) {
                 logger.log(`Extracted UID from metadata: ${uid}`);
             }
        }

        if (!uid) {
            logger.error(`Could not determine UID for file ${name}. Path structure incorrect or 'uid' missing in metadata. Exiting.`);
            return;
        }
        logger.log(`Processing file for UID: ${uid}`);
        // --- End Extract UID ---

        const fileName = name.split("/").pop()!;
        logger.log(`Processing file name: ${fileName}`);

        // 1. Download file to temporary location
        const tempLocalPath = `/tmp/${fileName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
        let fileBuffer: Buffer;
        try {
             // Use the bucket name from the event
             await getStorage().bucket(bucket).file(name).download({ destination: tempLocalPath });
             fileBuffer = require("fs").readFileSync(tempLocalPath);
             logger.log(`Successfully downloaded ${name} to ${tempLocalPath} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
        } catch (downloadError: any) {
             logger.error(`Failed to download file ${name}:`, downloadError.message || downloadError);
             try { require("fs").unlinkSync(tempLocalPath); } catch (e) { /* ignore cleanup error */ }
             return; // Stop execution if download fails
        }

        // 2. OCR via Document AI
        let text = "";
        try {
            const encodedImage = fileBuffer.toString("base64");
            const request = {
                 name: processorPath, // Use the configured processor path
                 skipHumanReview: true,
                 rawDocument: { content: encodedImage, mimeType: "application/pdf" },
             };
            logger.log(`Sending request to Document AI Processor: ${processorPath}`);
            const [result] = await docai.processDocument(request); // docai client should be initialized
            text = result.document?.text ?? "";
            logger.log(`📝 Document AI OCR completed. Text length: ${text.length} characters.`);
            if (text.length === 0) {
                 logger.warn("Document AI extracted no text from the document.");
                 // Consider setting parsingError here if empty text is an error state
            }
             logger.debug("Extracted text sample (first 500 chars):", text.substring(0, 500));
        } catch (docAIError: any) {
            logger.error("Document AI processing failed:", docAIError.message || docAIError);
            logger.error("Document AI Error Details:", docAIError);
             // Set parsingError in Firestore
             try {
                 const resumeId = Date.now().toString();
                 const firestorePath = `users/${uid}/resumes/${resumeId}`;
                 await setDoc(doc(db, firestorePath), {
                     resumeId: resumeId,
                     userId: uid,
                     parsingError: "doc_ai_error",
                     storagePath: name,
                     originalFileName: fileName,
                     createdAt: FieldValue.serverTimestamp(),
                     updatedAt: FieldValue.serverTimestamp(),
                     parsingDone: false,
                 });
                 logger.log(`Successfully wrote doc_ai_error to Firestore: ${firestorePath}`);
             } catch (firestoreError: any) {
                 logger.error(`❌ Failed to write doc_ai_error to Firestore (${uid}):`, firestoreError.message || firestoreError);
             }
             // Clean up temp file and exit
             try { require("fs").unlinkSync(tempLocalPath); } catch (e) { /* ignore */ }
            return;
        }

        // 3. Extract structured JSON via Vertex AI
        let parsed: any = {};
        try {
            // Limit OCR text to 15k characters
            const textSnippet = text.slice(0, 15000);

            /* ----------  Vertex-AI Prompt (Updated from previous request) ---------- */
            const prompt = `
You are an expert Arabic/English résumé parser.
Return **ONLY** minified JSON that exactly matches this TypeScript type – no comments, no extra keys, no Markdown:

type Resume = {
  title: string,
  personalInfo: {
    fullName: string, email: string,
    phone: string, address: string
  },
  objective: string,
  education: { degree: string, institute: string, year: string }[],
  experience: { title: string, company: string, start: string, end: string, description: string }[],
  skills: string[],
  languages: { name: string, level: string }[],
  hobbies: string[]
}

–––––––––––––––––––––––––––––––––
★  Arabic OUTPUT REQUIRED  ★
–––––––––––––––––––––––––––––––––

👉 **Example you MUST follow**
INPUT snippet

September 2018 – July 2023 Bachelor of petroleum engineering
Suez University Grade: Excellent with honor
EXPECTED JSON fragment
\`\`\`json
"education":[
  {"degree":"بكالوريوس هندسة بترول","institute":"جامعة السويس","year":"2018–2023"}
]
\`\`\`

👉 Another snippet
July 2022 Production Operations Trainee
Oasis Petroleum Company
Analyzed daily production department workflows …
EXPECTED JSON fragment
\`\`\`json
"experience":[
  {"title":"متدرب عمليات الإنتاج","company":"Oasis Petroleum Company", "start":"07/2022","end":"","description":"حللت سير عمل قسم الإنتاج اليومي …"}
]
\`\`\`

If a field is truly missing, output an empty string "" or empty array [].

TEXT TO ANALYSE (Arabic + English may be mixed – keep Arabic in output):
"""
${textSnippet} /* <= first 15 000 chars passed from Cloud Function */
"""

JSON Output:
/* ---------- End Prompt ---------- */
            `;
            logger.log("Sending request to Vertex AI (Gemini)...");
            logger.debug(`Vertex AI Prompt Length: ${prompt.length} characters`);

            // Ensure textGen (model client) is initialized
            if (!textGen) {
                 throw new Error("Vertex AI model client (textGen) is not initialized.");
            }

            const result = await textGen.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });

            const response = result.response;
            let jsonString = "";
            if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
                 jsonString = response.candidates[0].content.parts[0].text ?? "";
                 logger.log("🎯 Vertex AI raw response received.");
                 logger.debug("Raw Vertex AI Text Response (trimmed):", jsonString.substring(0, 500));

                 // Clean potential markdown fences
                 jsonString = jsonString.replace(/^```json\s*|```\s*$/g, "").trim();
                 logger.debug("Cleaned Vertex AI JSON string (trimmed):", jsonString.substring(0, 500));

                 try {
                     parsed = JSON.parse(jsonString);
                     logger.log("Successfully parsed JSON from Vertex AI response.");
                      logger.debug("Parsed JSON Keys:", Object.keys(parsed));
                 } catch (parseError: any) {
                     logger.error("Failed to parse JSON from Vertex AI response:", parseError);
                     logger.error("Problematic JSON String:", jsonString);
                     // Flag the parsing error, don't stop execution yet, will handle in step 4
                     parsed = { parsingError: "invalid_json_output", problematicJson: jsonString };
                 }
            } else {
                 logger.warn("Vertex AI response was empty or had no valid content part.");
                  // Flag the parsing error
                 parsed = { parsingError: "empty_ai_response" };
            }
        } catch (vertexError: any) {
            logger.error("Vertex AI processing failed:", vertexError.message || vertexError);
            logger.error("Vertex AI Error Details:", vertexError);
            // Flag the parsing error
             parsed = { parsingError: "vertex_ai_error" };
        } finally {
            // Clean up the temporary file regardless of AI success/failure
            try {
                require("fs").unlinkSync(tempLocalPath);
                logger.log(`Cleaned up temporary file: ${tempLocalPath}`);
            } catch (cleanupError: any) {
                logger.warn(`Failed to clean up temporary file ${tempLocalPath}:`, cleanupError.message || cleanupError);
            }
        }

        // 4. Write to Firestore
        const resumeId = Date.now().toString(); // Use timestamp as ID for simplicity
        const firestorePath = `users/${uid}/resumes/${resumeId}`;
         logger.log(`Generated Firestore Document ID: ${resumeId}. Path: ${firestorePath}`);

        // Validate AI output before saving
        if (parsed.parsingError || !parsed?.personalInfo?.fullName) {
             const errorReason = parsed.parsingError || "missing_fullname";
             logger.warn(`AI extraction failed or missing fullName (Reason: ${errorReason}). Setting parsingError flag in Firestore.`);
             try {
                const resumeDocRef = doc(db, firestorePath);
                await setDoc(resumeDocRef, {
                    resumeId: resumeId,
                    userId: uid,
                    parsingError: errorReason,
                    storagePath: name,
                    originalFileName: fileName,
                     // Include problematic JSON if available for debugging
                     ...(parsed.problematicJson && { problematicJson: parsed.problematicJson.substring(0, 1000) }), // Limit length
                    createdAt: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp(),
                    parsingDone: false, // Explicitly set parsingDone to false on error
                });
                logger.log(`Successfully wrote parsingError (${errorReason}) to Firestore: ${firestorePath}`);
             } catch (firestoreError: any) {
                 logger.error(`❌ Failed to write parsingError to Firestore (${firestorePath}):`, firestoreError.message || firestoreError);
                 logger.error("Firestore Write Error Details:", firestoreError);
             }
        } else {
            // Map the validated 'parsed' data to the canonical Firestore structure
            // This structure should match the `Resume` interface in dbTypes.ts
            const dataToSave = {
                resumeId: resumeId,
                userId: uid,
                title: parsed.title ?? `مستخرج من ${fileName}`, // Default title if missing
                personalInfo: {
                    fullName: parsed.personalInfo?.fullName ?? null, // Use null if missing
                    email: parsed.personalInfo?.email ?? null,
                    phone: parsed.personalInfo?.phone ?? null,
                    address: parsed.personalInfo?.address ?? null,
                    jobTitle: parsed.personalInfo?.jobTitle ?? null, // Keep if present, or null
                },
                objective: parsed.objective ?? null, // Use 'objective' field from AI output
                // Map education array, defaulting fields to null if missing
                education: (parsed.education ?? []).map((edu: any) => ({
                     degree: edu.degree ?? null,
                     institution: edu.institute ?? edu.institution ?? null, // Handle potential variations
                     graduationYear: edu.year ?? edu.graduationYear ?? null, // Handle potential variations
                     details: edu.details ?? null, // Keep details if present
                 })).filter((edu: any) => edu.degree || edu.institution || edu.graduationYear), // Filter out empty entries
                 // Map experience array
                 experience: (parsed.experience ?? []).map((exp: any) => ({
                     jobTitle: exp.title ?? exp.jobTitle ?? null, // Handle potential variations
                     company: exp.company ?? null,
                     startDate: exp.start ?? exp.startDate ?? null, // Handle potential variations
                     endDate: exp.end ?? exp.endDate ?? null, // Handle potential variations
                     description: exp.description ?? null,
                 })).filter((exp: any) => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description), // Filter empty
                 // Map skills (assuming AI returns string[], map to {name: string})
                  skills: (parsed.skills ?? []).filter((skill: any) => typeof skill === 'string' && skill.trim() !== '').map((name: string) => ({ name })),
                 // Map languages (assuming AI returns {name, level}[])
                 languages: (parsed.languages ?? []).map((lang: any) => ({
                     name: lang.name ?? null,
                     level: lang.level ?? null,
                 })).filter((l: any) => l.name), // Filter out entries without a name
                 // Map hobbies (assuming AI returns string[])
                 hobbies: (parsed.hobbies ?? []).filter((hobby: any) => typeof hobby === 'string' && hobby.trim() !== ''),
                 // Default customSections if not present in AI output
                 customSections: parsed.customSections ?? [], // Keep if present, otherwise empty array
                 // Metadata
                 parsingDone: true, // Set flag to true on successful parse and validation
                 parsingError: null, // Explicitly null on success
                 storagePath: name, // Store the path to the uploaded file
                 originalFileName: fileName, // Store the original file name
                 createdAt: FieldValue.serverTimestamp(), // Use server timestamp for creation
                 updatedAt: FieldValue.serverTimestamp(), // Use server timestamp for update
            };

            try {
                const resumeDocRef = doc(db, firestorePath); // Reference the document path
                await setDoc(resumeDocRef, dataToSave); // Write the mapped data
                logger.log(`✅ Successfully wrote mapped data to Firestore: ${firestorePath}`);
            } catch (firestoreError: any) {
                logger.error(`❌ Failed to write mapped data to Firestore (${firestorePath}):`, firestoreError.message || firestoreError);
                 logger.error("Firestore Write Error Details:", firestoreError);
                 // Note: We might want to update the doc with a firestore_write_error flag here
            }
        }
    }
);

// Export callable functions if they are still needed
export { suggestSummary, suggestSkills } from './callableFunctions';
