
import * as functions from "firebase-functions"; // Import functions to access config
import * as logger from "firebase-functions/logger";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { getStorage } from "firebase-admin/storage";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'; // Ensure Firestore and types are imported
import * as admin from 'firebase-admin'; // Ensure admin is imported for serverTimestamp()
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { VertexAI } from "@google-cloud/vertexai";
import { setDoc, doc } from "firebase-admin/firestore"; // Ensure setDoc and doc are imported

// Initialize Firebase Admin SDK if not already done (crucial for Firestore/Storage access)
if (admin.apps.length === 0) {
    admin.initializeApp();
}

const db = getFirestore(); // Get Firestore instance

// --- Configuration ---
// Prefer environment variables if set, otherwise use Functions config
// Corrected config keys to lowercase as used in the set command
const processorPath = process.env.CV_DOC_PROCESSOR_PATH || functions.config().cv?.doc_processor_path;
const vertexModelName = process.env.CV_VERTEX_MODEL || functions.config().cv?.vertex_model; // Use vertexModelName consistently
const gcpProject = process.env.GCLOUD_PROJECT || functions.config().cv?.project_id; // Get project ID from env or config
const docAiRegion = process.env.DOC_AI_REGION || 'us'; // Default or get from config/env
const vertexAiRegion = process.env.VERTEX_AI_REGION || 'us-central1'; // Default or get from config/env

// --- Validation ---
if (!processorPath) {
    logger.error("FATAL: Document AI Processor Path is not configured (env CV_DOC_PROCESSOR_PATH or functions.config().cv.doc_processor_path)");
    // throw new Error("Document AI Processor Path is not configured.");
}
if (!vertexModelName) {
    logger.error("FATAL: Vertex AI Model is not configured (env CV_VERTEX_MODEL or functions.config().cv.vertex_model)");
    // throw new Error("Vertex AI Model is not configured.");
}
if (!gcpProject) {
     logger.error("FATAL: GCP Project ID is not configured (env GCLOUD_PROJECT or functions.config().cv.project_id)");
    // throw new Error("GCP Project ID is not configured.");
}


// Initialize Clients (handle potential errors)
let docai: DocumentProcessorServiceClient | null = null;
let vertex: VertexAI | null = null;
let textGen: ReturnType<VertexAI['getGenerativeModel']> | null = null;

try {
    // Initialize Document AI Client with the correct regional endpoint
    docai = new DocumentProcessorServiceClient({ apiEndpoint: `${docAiRegion}-documentai.googleapis.com` });
    logger.info(`Document AI Client initialized for region: ${docAiRegion}`);
} catch (e: any) {
    logger.error("Error initializing Document AI Client:", e.message || e);
    docai = null; // Ensure it's null on failure
}

try {
    // Initialize Vertex AI Client
    vertex = new VertexAI({ project: gcpProject, location: vertexAiRegion });
    logger.info(`Vertex AI Client initialized for project: ${gcpProject}, location: ${vertexAiRegion}`);
    if (vertex && vertexModelName) {
         // Get the generative model instance
         textGen = vertex.getGenerativeModel({ model: vertexModelName }); // Pass model name string
         logger.info(`Vertex AI Model (${vertexModelName}) loaded.`);
    } else if (!vertexModelName) {
        logger.error("Vertex AI model name is missing, cannot load model.");
    }
} catch (e: any) {
    logger.error("Error initializing Vertex AI Client or Model:", e.message || e);
    vertex = null;
    textGen = null; // Ensure it's null on failure
}

export const parseResumePdf = onObjectFinalized(
    { region: vertexAiRegion, memory: "1GiB", timeoutSeconds: 540, cpu: 1 }, // Match region with Vertex AI
    async (event) => {
        // --- Essential Checks ---
        if (!docai || !textGen) {
            logger.error("FATAL: API clients not initialized. Exiting function.");
            return;
        }
         if (!processorPath) {
            logger.error("FATAL: Document AI Processor Path is not configured. Exiting function.");
            return; // Exit if critical config is missing
        }

        const { bucket, name, metadata } = event.data;

        if (!name?.startsWith("resumes_uploads/")) {
            logger.log(`Ignoring file outside 'resumes_uploads/': ${name}`);
            return; // ignore other uploads
        }

        // --- Extract UID ---
         let uid: string | undefined = metadata?.uid; // Try getting UID from custom metadata first
         if (!uid) {
              const pathParts = name.split("/");
              if (pathParts.length >= 3 && pathParts[0] === "resumes_uploads") {
                  uid = pathParts[1];
                  logger.log(`Extracted UID from path: ${uid}`);
              }
         }

         if (!uid) {
             logger.error(`Could not determine UID for file ${name}. Missing 'uid' in custom metadata or path structure. Exiting.`);
             return;
         }
         logger.log(`Processing file for UID: ${uid}`);
        // --- End Extract UID ---

        const fileName = name.split("/").pop()!;
        logger.log(`🔔 New PDF upload detected: ${name} (FileName: ${fileName})`);

        // 1. Download file to temporary location
        const tempLocalPath = `/tmp/${fileName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`; // Sanitize filename for temp path
        let fileBuffer: Buffer;
        try {
             await getStorage().bucket(bucket!).file(name!).download({ destination: tempLocalPath });
             fileBuffer = require("fs").readFileSync(tempLocalPath);
             logger.log(`Successfully downloaded ${name} to ${tempLocalPath} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
        } catch (downloadError: any) {
             logger.error(`Failed to download file ${name}:`, downloadError.message || downloadError);
             // Clean up temp file if download fails partially
             try { require("fs").unlinkSync(tempLocalPath); } catch (e) { /* ignore */ }
             return; // Stop processing if download fails
        }

        // 2. OCR via Document AI
        let text = "";
        try {
             const encodedImage = fileBuffer.toString("base64"); // Use buffer directly for content
             const request = {
                 name: processorPath,
                 skipHumanReview: true, // Optional: Set based on your needs
                 rawDocument: { content: encodedImage, mimeType: "application/pdf" },
             };
             logger.log(`Sending request to Document AI Processor: ${processorPath}`);
             const [result] = await docai.processDocument(request);
             text = result.document?.text ?? "";
             logger.log(`📝 Document AI OCR completed. Text length: ${text.length} characters.`);
             if (text.length === 0) {
                 logger.warn("Document AI extracted no text from the document.");
             }
             logger.debug("Extracted text sample (first 500 chars):", text.substring(0, 500));
         } catch (docAIError: any) {
             logger.error("Document AI processing failed:", docAIError.message || docAIError);
             logger.error("Document AI Error Details:", docAIError);
              // Clean up temp file on error
             try { require("fs").unlinkSync(tempLocalPath); } catch (e) { /* ignore */ }
             return; // Stop processing on Doc AI error
         }

        // 3. Extract structured JSON via Vertex AI
        let parsed: any = {}; // Use 'any' initially, validation happens later
        try {
            // Limit OCR text to 15k characters to stay within token budget
            const textSnippet = text.slice(0, 15000);

            const prompt = `
                Extract the following résumé fields in STRICT JSON format only, without any introductory text, code block markdown (\`\`\`json ... \`\`\`), or explanation. The output MUST be a single valid JSON object.
                If a field is not found, represent it as 'null' or an empty array [] as appropriate according to the schema.
                Maintain the original language (especially Arabic) for all extracted values.

                Schema:
                {
                  "title": "string | null",
                  "personalInfo": { "fullName": "string | null", "email": "string | null", "phone": "string | null", "address": "string | null" } | null,
                  "objective": "string | null",
                  "education": [ { "degree": "string | null", "institute": "string | null", "year": "string | null" } ] | null,
                  "experience": [ { "title": "string | null", "company": "string | null", "start": "string | null", "end": "string | null", "description": "string | null" } ] | null,
                  "skills": ["string"] | null,
                  "languages": [ { "name": "string | null", "level": "string | null" } ] | null,
                  "hobbies": ["string"] | null
                }

                Example of valid JSON output (adhere to the schema strictly):
                {
                  "title": "مهندس برمجيات",
                  "personalInfo": { "fullName": "أحمد محمد", "email": "ahmad@example.com", "phone": "+966555555555", "address": "الرياض، المملكة العربية السعودية" },
                  "objective": "باحث عن وظيفة في مجال تطوير البرمجيات...",
                  "education": [ { "degree": "بكالوريوس", "institute": "جامعة الملك سعود", "year": "2018" } ],
                  "experience": [ { "title": "مطور برامج", "company": "شركة تقنية", "start": "2018", "end": "2020", "description": "تطوير تطبيقات..." } ],
                  "skills": ["Java", "C++", "Python"],
                  "languages": [ { "name": "العربية", "level": "ممتاز" }, { "name": "الإنجليزية", "level": "جيد" } ],
                  "hobbies": ["القراءة", "السباحة"]
                }

                Text to analyse:
                \"\"\"
                ${textSnippet}
                \"\"\"

                JSON Output:
            `; // Keep text slicing for safety

            logger.log("Sending request to Vertex AI (Gemini)...");
            logger.debug(`Vertex AI Prompt Length: ${prompt.length} characters`);

             const result = await textGen.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });

             const response = result.response;
             let jsonString = "";
             if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
                 jsonString = response.candidates[0].content.parts[0].text ?? "";
                 logger.log("🎯 Vertex AI raw response received.");
                 logger.debug("Raw Vertex AI Text Response (trimmed):", jsonString.substring(0, 500)); // Log before cleaning

                 jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim(); // Clean markdown fences
                 logger.debug("Cleaned Vertex AI JSON string (trimmed):", jsonString.substring(0, 500)); // Log after cleaning

                 try {
                     parsed = JSON.parse(jsonString);
                     logger.log("Successfully parsed JSON from Vertex AI response.");
                     logger.debug("Parsed JSON Keys:", Object.keys(parsed));
                 } catch (parseError: any) {
                     logger.error("Failed to parse JSON from Vertex AI response:", parseError);
                     logger.error("Problematic JSON String:", jsonString); // Log the string that failed parsing
                     // Decide how to proceed: write empty data, retry, or fail?
                     // For now, we'll proceed with the empty 'parsed' object initialized earlier.
                 }
             } else {
                 logger.warn("Vertex AI response was empty or had no valid content part.");
             }

         } catch (vertexError: any) {
             logger.error("Vertex AI processing failed:", vertexError.message || vertexError);
             logger.error("Vertex AI Error Details:", vertexError);
             // Decide how to proceed on Vertex error. Continue with empty 'parsed' object for now.
         } finally {
              // Clean up the temporary file regardless of Vertex AI success/failure
              try {
                  require("fs").unlinkSync(tempLocalPath);
                  logger.log(`Cleaned up temporary file: ${tempLocalPath}`);
              } catch (cleanupError: any) {
                  logger.warn(`Failed to clean up temporary file ${tempLocalPath}:`, cleanupError.message || cleanupError);
              }
         }


        // 4. Write to Firestore
        // Generate a unique ID based on timestamp (as requested)
        const resumeId = Date.now().toString();
        const firestorePath = `users/${uid}/resumes/${resumeId}`;
        logger.log(`Generated Firestore Document ID: ${resumeId}. Path: ${firestorePath}`);

        // Validate at least personalInfo.fullName exists
        if (!parsed?.personalInfo?.fullName) {
            logger.warn("Vertex AI extraction failed to extract fullName. Setting parsingError flag.");
            try {
                const resumeDocRef = db.doc(firestorePath);
                await resumeDocRef.set({
                    resumeId: resumeId,
                    userId: uid,
                    parsingError: "empty_ai_output",
                    storagePath: name, // Store the GCS path
                    originalFileName: fileName, // Store original name
                    createdAt: FieldValue.serverTimestamp(), // Use FieldValue
                    updatedAt: FieldValue.serverTimestamp(), // Use FieldValue
                });
                logger.log(`Successfully wrote parsingError to Firestore: ${firestorePath}`);
            } catch (firestoreError: any) {
                logger.error(`❌ Failed to write parsingError to Firestore (${firestorePath}):`, firestoreError.message || firestoreError);
                logger.error("Firestore Write Error Details:", firestoreError);
            }
        } else {
            // Map the potentially partial 'parsed' data to the canonical Firestore structure
            // Ensure all expected top-level keys exist, defaulting to null or empty arrays
            const dataToSave = {
                resumeId: resumeId,
                userId: uid,
                title: parsed.title ?? `مستخرج من ${fileName}`, // Default title if missing
                personalInfo: { // Ensure sub-object exists
                    fullName: parsed.personalInfo?.fullName ?? null,
                    email: parsed.personalInfo?.email ?? null,
                    phone: parsed.personalInfo?.phone ?? null,
                    address: parsed.personalInfo?.address ?? null,
                     // Add jobTitle from parsed if available, or default null
                    jobTitle: parsed.personalInfo?.jobTitle ?? null,
                },
                objective: parsed.objective ?? null,
                // Ensure arrays are initialized even if null/undefined in parsed data
                 // Map institute/year from parsed to institution/graduationYear
                education: (parsed.education ?? []).map((edu: any) => ({
                     degree: edu.degree ?? null,
                     institution: edu.institute ?? edu.institution ?? null, // Accept both names
                     graduationYear: edu.year ?? edu.graduationYear ?? null, // Accept both names
                     details: edu.details ?? null,
                 })),
                 // Map title/start/end from parsed to jobTitle/startDate/endDate
                experience: (parsed.experience ?? []).map((exp: any) => ({
                     jobTitle: exp.title ?? exp.jobTitle ?? null, // Accept both names
                     company: exp.company ?? null,
                     startDate: exp.start ?? exp.startDate ?? null, // Accept both names
                     endDate: exp.end ?? exp.endDate ?? null, // Accept both names
                     description: exp.description ?? null,
                 })),
                 // Skills are now expected as string[] from the prompt
                 skills: (parsed.skills ?? []).map((skill: any) => ({
                     name: typeof skill === 'string' ? skill : skill?.name ?? null
                 })).filter((s: any) => s.name), // Convert back to object for consistency? Or keep as string array?
                 // Let's keep skills as array of objects {name: string} for consistency with form
                 // skills: (parsed.skills ?? []).filter((skill: any) => typeof skill === 'string' && skill.trim() !== ''),

                languages: (parsed.languages ?? []).map((lang: any) => ({ // Ensure structure is object {name, level}
                     name: lang.name ?? null,
                     level: lang.level ?? null,
                 })).filter((l: any) => l.name), // Filter out empty language entries
                 hobbies: (parsed.hobbies ?? []).filter((hobby: any) => typeof hobby === 'string' && hobby.trim() !== ''), // Hobbies expected as string[]
                customSections: parsed.customSections ?? [], // Add custom sections if parsed
                parsingDone: true, // Set flag to true
                storagePath: name, // Store the GCS path
                originalFileName: fileName, // Store original name
                createdAt: FieldValue.serverTimestamp(), // Use FieldValue
                updatedAt: FieldValue.serverTimestamp(), // Use FieldValue
            };


            try {
                const resumeDocRef = db.doc(firestorePath);
                await resumeDocRef.set(dataToSave);
                logger.log(`✅ Successfully wrote mapped data to Firestore: ${firestorePath}`);
            } catch (firestoreError: any) {
                logger.error(`❌ Failed to write data to Firestore (${firestorePath}):`, firestoreError.message || firestoreError);
                logger.error("Firestore Write Error Details:", firestoreError);
                // Consider deleting the uploaded file or adding retry logic if Firestore write fails
            }
        }
    }
);

// Export callable functions if they are still needed
export { suggestSummary, suggestSkills } from './callableFunctions';
