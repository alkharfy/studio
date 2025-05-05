
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {DocumentProcessorServiceClient} from "@google-cloud/documentai";
import {VertexAI} from "@google-cloud/vertexai";
import {Storage} from "@google-cloud/storage";
import type { Timestamp } from 'firebase-admin/firestore'; // Import Timestamp for type definition

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();

// --- Configuration ---
const DOC_AI_REGION = "us"; // Explicitly define region for Doc AI client endpoint
const VERTEX_AI_REGION = "us-central1"; // Explicitly define region for Vertex AI
const GCLOUD_PROJECT = process.env.GCLOUD_PROJECT; // Get project ID from environment

// Initialize Clients (outside the function handler for reuse)
let docAIClient: DocumentProcessorServiceClient;
let vertexAI: VertexAI;
let generativeModel: ReturnType<VertexAI['getGenerativeModel']>;

try {
    // Validate project ID early
    if (!GCLOUD_PROJECT) {
        throw new Error("Google Cloud Project ID is not available in the environment (GCLOUD_PROJECT).");
    }

    // --- Initialize API Clients ---
    docAIClient = new DocumentProcessorServiceClient({ apiEndpoint: `${DOC_AI_REGION}-documentai.googleapis.com` });
    functions.logger.info(`Document AI Client initialized for region: ${DOC_AI_REGION}`);

    vertexAI = new VertexAI({ project: GCLOUD_PROJECT, location: VERTEX_AI_REGION });
    functions.logger.info(`Vertex AI Client initialized for project: ${GCLOUD_PROJECT}, location: ${VERTEX_AI_REGION}`);

    // --- Get Model Name from Config ---
    // This config is expected to be set via `firebase functions:config:set cv.vertex_model="..."`
    const vertexModelName = functions.config().cv?.vertex_model;
    if (!vertexModelName) {
        // Throw error during initialization if config is missing, prevents function cold starts with bad config
        throw new Error("Vertex AI Model Name (cv.vertex_model) is not set in Functions config.");
    }
    functions.logger.info(`Using Vertex AI Model from config: ${vertexModelName}`);

    generativeModel = vertexAI.getGenerativeModel({
        model: vertexModelName,
        // Optional: Add safetySettings or generationConfig if needed
        // generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
    });
    functions.logger.info(`Vertex AI Model (${vertexModelName}) loaded successfully.`);

} catch (initializationError: any) {
    functions.logger.error("FATAL: Failed to initialize API clients or load configuration:", initializationError);
    // If initialization fails, subsequent function invocations might fail.
    // Consider how to handle this (e.g., rely on function logs for debugging)
}


// --- Firestore Data Structure ---
// This defines the structure we aim to write to Firestore after mapping.
// It should align with the client-side `src/lib/dbTypes.ts` but uses Admin SDK types.
interface ResumeFirestoreData {
  resumeId: string; // Keep track of the doc ID within the doc itself
  userId: string; // Link to the user
  title: string; // Title for the resume (e.g., from filename or extracted)
  personalInfo?: {
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;
  objective?: string | null; // 'objective' field requested in the prompt
  education?: {
    degree?: string | null;
    institute?: string | null; // Changed 'institution' to 'institute' based on prompt request
    year?: string | null;      // Changed 'graduationYear' to 'year' based on prompt request
  }[] | null;
  experience?: {
    title?: string | null; // Changed 'jobTitle' to 'title' based on prompt request
    company?: string | null;
    start?: string | null; // Changed 'startDate' to 'start' based on prompt request
    end?: string | null;   // Changed 'endDate' to 'end' based on prompt request
    description?: string | null;
  }[] | null;
  skills?: string[] | null; // Simple string array based on prompt request
  languages?: {
      name?: string | null; // Changed to object array based on prompt request
      level?: string | null;
  }[] | null;
  hobbies?: string[] | null; // Simple string array based on prompt request
  // Removed 'customSections' as it wasn't in the latest prompt/mapping request
  // customSections?: {
  //   title?: string | null;
  //   content?: string | null;
  // }[] | null;
  parsingDone: boolean; // Flag for the frontend listener
  storagePath: string | null; // Path to the original file in GCS
  createdAt: admin.firestore.FieldValue | Timestamp; // Use FieldValue for server timestamp on create
  updatedAt: admin.firestore.FieldValue | Timestamp; // Use FieldValue for server timestamp on create/update
  // Add originalFileName if needed, though not in the latest mapping request
  // originalFileName?: string | null;
}


// --- Cloud Function Definition ---
// Uses v1 trigger with specified resources and region.
export const parseResumePdf = functions.runWith({
  cpu: 1,
  memory: "1GiB",
  timeoutSeconds: 540,
}).region("us-central1") // Match Vertex AI region
  .storage
  .object()
  .onFinalize(async (object) => { // Using v1 trigger signature
    // --- Essential Checks & Setup ---
    if (!docAIClient || !generativeModel) {
        functions.logger.error("API clients not initialized. Exiting function.");
        return; // Exit if initialization failed
    }

    const filePath = object.name;
    const contentType = object.contentType;
    const bucketName = object.bucket;
    const objectMetadata = object.metadata;

    if (!filePath) {
        functions.logger.error("File path is undefined. Exiting.");
        return;
    }
    if (!bucketName) {
        functions.logger.error("Bucket name is undefined. Exiting.");
        return;
    }

    functions.logger.log(`Processing file: ${filePath} in bucket: ${bucketName} (Content-Type: ${contentType})`);

    if (!contentType?.startsWith("application/pdf")) {
      functions.logger.warn(`File ${filePath} is not a PDF (${contentType}). Exiting.`);
      return;
    }

    // --- Get User ID (Crucial for Firestore path) ---
    let uid: string | undefined = objectMetadata?.uid; // Check metadata first
    if (uid) {
      functions.logger.log(`Found UID in metadata: ${uid}`);
    } else {
      // Fallback: Try extracting from path (e.g., resumes_uploads/USER_ID/...)
      const pathParts = filePath.split("/");
      if (pathParts.length >= 3 && pathParts[0] === "resumes_uploads") {
        uid = pathParts[1];
        functions.logger.log(`Extracted UID from path: ${uid}`);
      }
    }
    if (!uid) {
        functions.logger.error(`Could not determine UID for file ${filePath}. Missing 'uid' in custom metadata and failed to extract from path. Exiting.`);
        // Consider writing an error status to a different Firestore location if needed.
        return;
    }
     functions.logger.log(`Using UID: ${uid} for Firestore path.`);
    // --- End Get User ID ---

    // Extract filename for potential use as default title
    const fileName = filePath.split('/').pop() ?? "unknown_file.pdf";
    functions.logger.log(`Extracted FileName: ${fileName}`);

    // --- Get Document AI Processor Path from Config ---
    // Config expected to be set via `firebase functions:config:set cv.doc_processor_path="..."`
    const processorPath = functions.config().cv?.doc_processor_path;
    if (!processorPath) {
        functions.logger.error("Document AI Processor Path (cv.doc_processor_path) is not set in Functions config. Exiting.");
        // Consider updating Firestore with an error state for the user
        return;
    }
    functions.logger.log(`Using Document AI Processor Path: ${processorPath}`);

    // --- Download File from GCS ---
    const bucket = storage.bucket(bucketName);
    const remoteFile = bucket.file(filePath);
    let fileBuffer: Buffer;
    try {
        functions.logger.log(`Downloading file from GCS: gs://${bucketName}/${filePath}`);
        const [buffer] = await remoteFile.download();
        fileBuffer = buffer;
        functions.logger.log(`Successfully downloaded ${filePath} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
    } catch (downloadError: any) {
        functions.logger.error(`Failed to download file ${filePath}:`, downloadError.message || downloadError);
        functions.logger.error("Download Error Details:", downloadError);
        return; // Stop processing if download fails
    }

    // --- Process with Document AI (OCR) ---
    let rawText = "";
    try {
      const encodedImage = fileBuffer.toString("base64");
      const request = {
        name: processorPath, // Use the configured processor path
        // Skip human review for automated processing
        skipHumanReview: true,
        rawDocument: {
          content: encodedImage,
          mimeType: "application/pdf",
        },
      };
      functions.logger.log(`Sending request to Document AI Processor: ${processorPath}`);
      const [result] = await docAIClient.processDocument(request);
      functions.logger.log("Document AI processing successful.");

      if (result.document?.text) {
        rawText = result.document.text;
        functions.logger.log(`Document AI Extracted Text Length: ${rawText.length} characters.`);
        // Log only the first 500 chars for brevity and privacy
        functions.logger.debug("Extracted text sample (first 500 chars):", rawText.substring(0, 500));
      } else {
        functions.logger.warn("Document AI processed the file but found no text. Proceeding with empty text for Vertex AI.");
        // Allow proceeding, Vertex might still work if the PDF had images etc., or fail gracefully.
      }
    } catch (docAIError: any) {
      functions.logger.error("Document AI processing failed:", docAIError.message || docAIError);
      functions.logger.error("Document AI Error Details:", docAIError);
      return; // Stop processing if OCR fails
    }

    // --- Process with Vertex AI (Extraction) ---
    let extractedJson: any = {}; // Use 'any' initially, will be mapped later
    try {
      // Construct the prompt using the extracted text and requested JSON structure
       const prompt = `
            Extract the following résumé fields in valid JSON only (no code block or markdown like \`\`\`json):
            {
              "title": "string|null",
              "fullName": "string|null",
              "email": "string|null",
              "phone": "string|null",
              "address": "string|null",
              "objective": "string|null",
              "education": [{ "degree": "string|null", "institute": "string|null", "year": "string|null" }],
              "experience": [{ "title": "string|null", "company": "string|null", "start": "string|null", "end": "string|null", "description": "string|null" }],
              "skills": ["string"],
              "languages": [{ "name": "string|null", "level": "string|null" }],
              "hobbies": ["string"]
            }

            Maintain Arabic labels and values if they are present in the original résumé text.
            If a field or section is not found, represent it as 'null' or an empty array [] as appropriate in the JSON structure.

            TEXT:
            """
            ${rawText}
            """

            JSON Output:
            `;


      functions.logger.log("Sending request to Vertex AI (Gemini)...");
      // Log the prompt length for debugging potential size issues
      functions.logger.debug(`Vertex AI Prompt Length: ${prompt.length} characters`);

      const result = await generativeModel.generateContent(prompt);
      const response = result.response;

      if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
        let jsonString = response.candidates[0].content.parts[0].text || "";
        functions.logger.log("Vertex AI raw response text received.");
        // Clean potential markdown ```json ... ``` markers and whitespace
        jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();

        try {
          extractedJson = JSON.parse(jsonString);
          functions.logger.log("Successfully parsed JSON from Vertex AI response.");
          // Log keys for verification, avoid logging potentially large full JSON
          functions.logger.debug("Parsed JSON Keys:", Object.keys(extractedJson));
        } catch (parseError: any) {
          functions.logger.error("Failed to parse JSON from Vertex AI response:", parseError);
          functions.logger.error("Raw Vertex AI Text Response (trimmed):", jsonString.substring(0, 500));
          // Continue, but mapping might fail or use defaults.
          // Consider setting an error flag in Firestore.
        }
      } else {
        functions.logger.warn("Vertex AI response was empty or had no valid content part. Proceeding with empty JSON.");
         // Proceed, mapping will use defaults. Consider setting an error flag.
      }

    } catch (vertexError: any) {
      functions.logger.error("Vertex AI processing failed:", vertexError.message || vertexError);
      functions.logger.error("Vertex AI Error Details:", vertexError);
       // Continue, but mapping might fail or use defaults.
       // Consider setting an error flag in Firestore.
    }

    // --- Generate Firestore Document ID using Timestamp ---
    // Generate a unique ID based on the current time. Safer than context timestamp.
    const resumeId = admin.firestore.Timestamp.now().toMillis().toString();
    const firestorePath = `users/${uid}/resumes/${resumeId}`;
    functions.logger.log(`Generated Firestore Document ID: ${resumeId}. Path: ${firestorePath}`);
    // --- End Generate Firestore Document ID ---


    // --- Map extractedJson to the target ResumeFirestoreData structure ---
    // Use nullish coalescing (??) to provide defaults for missing fields/sections
    // This mapping aligns with the `ResumeFirestoreData` interface definition above.
     const mappedData: ResumeFirestoreData = {
        resumeId: resumeId, // Store ID within the doc
        userId: uid,
        title: extractedJson.title ?? `مستخرج من ${fileName}`, // Use extracted title or default
        personalInfo: { // Ensure personalInfo object exists, even if fields are null
            fullName: extractedJson.fullName ?? null, // Use fullName from extracted
            email: extractedJson.email ?? null, // Use email from extracted
            phone: extractedJson.phone ?? null, // Use phone from extracted
            address: extractedJson.address ?? null, // Use address from extracted
        },
        objective: extractedJson.objective ?? null, // Use objective from extracted
        // Map education array, ensuring fields match prompt request (institute, year)
        education: Array.isArray(extractedJson.education) ? extractedJson.education.map((edu: any) => ({
            degree: edu.degree ?? null,
            institute: edu.institute ?? null, // Matches prompt request
            year: edu.year ?? null,          // Matches prompt request
        })).filter(edu => edu.degree || edu.institute || edu.year) // Filter out completely empty entries
         : [], // Default to empty array if not present or not an array

        // Map experience array, ensuring fields match prompt request (title, start, end)
        experience: Array.isArray(extractedJson.experience) ? extractedJson.experience.map((exp: any) => ({
            title: exp.title ?? null,           // Matches prompt request
            company: exp.company ?? null,
            start: exp.start ?? null,         // Matches prompt request
            end: exp.end ?? null,           // Matches prompt request
            description: exp.description ?? null,
        })).filter(exp => exp.title || exp.company || exp.start || exp.end || exp.description) // Filter out completely empty entries
         : [], // Default to empty array

        // Map skills (assuming simple string array from prompt)
        skills: Array.isArray(extractedJson.skills) ? extractedJson.skills.filter((skill: any) => typeof skill === 'string') : [],

        // Map languages (assuming object array {name, level} from prompt)
        languages: Array.isArray(extractedJson.languages) ? extractedJson.languages.map((lang: any) => ({
             name: lang.name ?? null,
             level: lang.level ?? null,
        })).filter(lang => lang.name || lang.level) // Filter out completely empty entries
         : [], // Default to empty array

        // Map hobbies (assuming simple string array from prompt)
        hobbies: Array.isArray(extractedJson.hobbies) ? extractedJson.hobbies.filter((hobby: any) => typeof hobby === 'string') : [],

        // --- Metadata fields ---
        parsingDone: true, // Crucial flag for the frontend listener
        storagePath: filePath, // Store the GCS path
        createdAt: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp
        updatedAt: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp
     };
     functions.logger.log("Successfully mapped extracted JSON to Firestore schema.");
     functions.logger.debug("Mapped Firestore Data Keys:", Object.keys(mappedData));
     // --- End Mapping ---


    // --- Write Mapped Data to Firestore ---
    try {
      const resumeDocRef = db.doc(firestorePath);
      // Write the *mapped* data, not the raw extractedJson
      await resumeDocRef.set(mappedData);
      functions.logger.log(`✅ Successfully wrote mapped data to Firestore: ${firestorePath}`);

    } catch (firestoreError: any) {
      functions.logger.error(`❌ Failed to write data to Firestore (${firestorePath}):`, firestoreError.message || firestoreError);
      functions.logger.error("Firestore Write Error Details:", firestoreError);
      // Consider how to handle Firestore write failures (e.g., retry, error queue)
    }
 });

// Note: Removed the previous V2 function definition as the request provided a V1 structure.
// Ensure your Firebase project deployment targets V1 functions if using this exact code.
// If V2 is required, the trigger signature needs to be updated (e.g., using onObjectFinalized from 'firebase-functions/v2/storage').
