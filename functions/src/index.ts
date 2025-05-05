
import * as logger from "firebase-functions/logger";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { getStorage } from "firebase-admin/storage";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'; // Ensure Firestore and types are imported
import * as admin from 'firebase-admin'; // Ensure admin is imported for serverTimestamp()
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { VertexAI } from "@google-cloud/vertexai";
import { functions } from 'firebase'; // Import functions to access config

// Initialize Firebase Admin SDK if not already done (crucial for Firestore/Storage access)
if (admin.apps.length === 0) {
    admin.initializeApp();
}

const db = getFirestore(); // Get Firestore instance

// --- Configuration ---
// Prefer environment variables if set, otherwise use Functions config
const processorPath = process.env.CV_DOCPROCESSORPATH || functions.config().cv?.doc_processor_path;
const vertexModel = process.env.CV_VERTEXMODEL || functions.config().cv?.vertex_model;
const gcpProject = process.env.GCLOUD_PROJECT || functions.config().cv?.project_id; // Get project ID
const docAiRegion = process.env.DOC_AI_REGION || 'us'; // Default or get from config/env
const vertexAiRegion = process.env.VERTEX_AI_REGION || 'us-central1'; // Default or get from config/env

// --- Validation ---
if (!processorPath) {
    logger.error("FATAL: Document AI Processor Path is not configured (env CV_DOCPROCESSORPATH or functions.config().cv.doc_processor_path)");
    // Optional: Throw an error to prevent function execution if critical config is missing
    // throw new Error("Document AI Processor Path is not configured.");
}
if (!vertexModel) {
    logger.error("FATAL: Vertex AI Model is not configured (env CV_VERTEXMODEL or functions.config().cv.vertex_model)");
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
    docai = new DocumentProcessorServiceClient({ apiEndpoint: `${docAiRegion}-documentai.googleapis.com` });
    logger.info(`Document AI Client initialized for region: ${docAiRegion}`);
} catch (e: any) {
    logger.error("Error initializing Document AI Client:", e.message || e);
    docai = null; // Ensure it's null on failure
}

try {
    vertex = new VertexAI({ project: gcpProject, location: vertexAiRegion });
    logger.info(`Vertex AI Client initialized for project: ${gcpProject}, location: ${vertexAiRegion}`);
    if (vertex && vertexModel) {
         textGen = vertex.getGenerativeModel({ model: vertexModel });
         logger.info(`Vertex AI Model (${vertexModel}) loaded.`);
    } else if (!vertexModel) {
        logger.error("Vertex AI model name is missing, cannot load model.");
    }
} catch (e: any) {
    logger.error("Error initializing Vertex AI Client or Model:", e.message || e);
    vertex = null;
    textGen = null; // Ensure it's null on failure
}


// Define the structure expected from Vertex AI and for Firestore
interface ExtractedResumeData {
    title?: string | null;
    personalInfo?: {
        fullName?: string | null;
        email?: string | null;
        phone?: string | null;
        address?: string | null;
    } | null;
    objective?: string | null;
    education?: {
        degree?: string | null;
        institute?: string | null; // Matches prompt 'institute'
        year?: string | null;      // Matches prompt 'year'
    }[] | null;
    experience?: {
        title?: string | null;      // Matches prompt 'title'
        company?: string | null;
        start?: string | null;      // Matches prompt 'start'
        end?: string | null;        // Matches prompt 'end'
        description?: string | null;
    }[] | null;
    skills?: string[] | null;
    languages?: {
        name?: string | null;
        level?: string | null;
    }[] | null;
    hobbies?: string[] | null;
}

interface ResumeFirestoreData extends ExtractedResumeData {
    resumeId: string; // Added resumeId
    userId: string;   // Added userId
    parsingDone: boolean;
    storagePath: string;
    originalFileName: string; // Added original file name
    createdAt: FieldValue | Timestamp; // Use FieldValue for serverTimestamp
    updatedAt: FieldValue | Timestamp;
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


        // 1. Download file
        const file = getStorage().bucket(bucket!).file(name!);
        let fileBuffer: Buffer;
        try {
             const [buffer] = await file.download();
             fileBuffer = buffer;
             logger.log(`Successfully downloaded ${name} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
        } catch (downloadError: any) {
             logger.error(`Failed to download file ${name}:`, downloadError.message || downloadError);
             return; // Stop processing if download fails
        }


        // 2. OCR via Document AI
        let text = "";
        try {
             const encodedImage = fileBuffer.toString("base64");
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
             return; // Stop processing on Doc AI error
         }

        // 3. Extract structured JSON via Vertex AI
        let parsed: ExtractedResumeData = {}; // Initialize as empty object
        try {
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

                Text to analyse:
                """
                ${text.slice(0, 30000)}
                """

                JSON Output:
            `; // Keep text slicing for safety

            logger.log("Sending request to Vertex AI (Gemini)...");
            logger.debug(`Vertex AI Prompt Length: ${prompt.length} characters`);

             const result = await textGen.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });

             // Access the text response correctly based on the Vertex AI SDK version
             const response = result.response;
             let jsonString = "";
             if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
                 jsonString = response.candidates[0].content.parts[0].text ?? "";
                 logger.log("🎯 Vertex AI raw response received.");
                 logger.debug("Raw Vertex AI Text Response (trimmed):", jsonString.substring(0, 500)); // Log before cleaning
                 // Clean potential markdown fences
                 jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();
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
         }


        // 4. Write to Firestore
        const resumeId = Date.now().toString(); // Use timestamp for unique ID
        const firestorePath = `users/${uid}/resumes/${resumeId}`;
        logger.log(`Generated Firestore Document ID: ${resumeId}. Path: ${firestorePath}`);

        // Map the potentially partial 'parsed' data to the full Firestore structure
        const dataToSave: ResumeFirestoreData = {
            resumeId: resumeId,
            userId: uid,
            title: parsed.title ?? `مستخرج من ${fileName}`, // Default title if missing
            personalInfo: {
                fullName: parsed.personalInfo?.fullName ?? null,
                email: parsed.personalInfo?.email ?? null,
                phone: parsed.personalInfo?.phone ?? null,
                address: parsed.personalInfo?.address ?? null,
            },
            objective: parsed.objective ?? null,
            // Ensure arrays are initialized even if null/undefined in parsed data
            education: (parsed.education ?? []).map(edu => ({
                 degree: edu.degree ?? null,
                 institute: edu.institute ?? null,
                 year: edu.year ?? null,
             })),
            experience: (parsed.experience ?? []).map(exp => ({
                 title: exp.title ?? null,
                 company: exp.company ?? null,
                 start: exp.start ?? null,
                 end: exp.end ?? null,
                 description: exp.description ?? null,
             })),
            skills: parsed.skills ?? [],
            languages: (parsed.languages ?? []).map(lang => ({
                 name: lang.name ?? null,
                 level: lang.level ?? null,
             })),
            hobbies: parsed.hobbies ?? [],
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

        // Optional: Clean up the temporary file
        try {
            require("fs").unlinkSync(tmpPath);
            logger.log(`Cleaned up temporary file: ${tmpPath}`);
        } catch (cleanupError: any) {
            logger.warn(`Failed to clean up temporary file ${tmpPath}:`, cleanupError.message || cleanupError);
        }
    }
);

// --- suggestSummary Cloud Function (Keep or remove if not needed alongside the main parsing logic) ---
// Assuming suggestSummary and suggestSkills are still needed as separate callable functions:
export { suggestSummary, suggestSkills } from './callableFunctions'; // Move callable functions to a separate file
// If they are NOT needed anymore, remove the line above and the callableFunctions.ts file.

