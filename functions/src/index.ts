
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

// Initialize Clients (will be fully configured inside the function using config)
const docAIClient = new DocumentProcessorServiceClient({apiEndpoint: "us-documentai.googleapis.com"}); // Keep region hint
const vertexAI = new VertexAI({project: process.env.GCLOUD_PROJECT, location: "us-central1"}); // Keep region hint

// Define the structure for the data we want to store in Firestore.
// This should align with src/lib/dbTypes.ts (but uses Firestore Admin types)
// Note: The prompt below will reference these fields.
interface ResumeFirestoreData {
  resumeId: string;
  userId: string;
  title: string;
  personalInfo?: {
    fullName?: string | null;
    jobTitle?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;
  summary?: string | null; // Renamed from objective for consistency
  education?: {
    degree?: string | null;
    institution?: string | null; // Renamed from institute
    graduationYear?: string | null; // Renamed from year
    details?: string | null; // Added details field
  }[] | null;
  experience?: {
    jobTitle?: string | null; // Renamed from title
    company?: string | null;
    startDate?: string | null; // Renamed from start
    endDate?: string | null; // Renamed from end
    description?: string | null;
  }[] | null;
  skills?: { name?: string | null; }[] | null; // Changed to array of objects
  languages?: string[] | null; // Changed to simple string array
  hobbies?: string[] | null;
  customSections?: {
    title?: string | null;
    content?: string | null;
   }[] | null; // Added customSections
  parsingDone: boolean;
  originalFileName: string | null;
  storagePath: string | null;
  createdAt: Timestamp | FirebaseFirestore.FieldValue; // Use FieldValue for server timestamp
  updatedAt: Timestamp | FirebaseFirestore.FieldValue; // Use FieldValue for server timestamp
}


// Cloud Function definition with updated resources and region
export const parseResumePdf = functions.runWith({
  cpu: 1,
  memory: "1GiB",
  timeoutSeconds: 540,
}).region("us-central1") // Explicitly set region
  .storage
  .object()
  .onFinalize(async (object) => { // Removed context as it's not explicitly needed for timestamp ID
    const filePath = object.name;
    const contentType = object.contentType;
    const bucketName = object.bucket;
    const objectMetadata = object.metadata; // Get metadata for custom user ID

    functions.logger.log(`Processing file: ${filePath} in bucket: ${bucketName}`);

    if (!contentType?.startsWith("application/pdf")) {
      functions.logger.warn(`File ${filePath} is not a PDF (${contentType}). Exiting.`);
      return;
    }

    // --- Get User ID ---
    const uidFromMetadata = objectMetadata?.uid; // Assuming 'uid' key is set during upload
    if (uidFromMetadata) {
      functions.logger.log(`Found UID in metadata: ${uidFromMetadata}`);
    } else {
         // Fallback - try extracting from path (less reliable)
        const pathParts = filePath?.split("/");
        let uidFromPath: string | undefined;
        if (pathParts && pathParts.length >= 3 && pathParts[0] === "resumes_uploads") {
          uidFromPath = pathParts[1];
          functions.logger.log(`Extracted UID from path: ${uidFromPath}`);
        }
        if(!uidFromPath) {
            functions.logger.error(`Could not determine UID for file ${filePath}. Missing 'uid' in custom metadata and failed to extract from path. Exiting.`);
            return;
        }
         uidFromMetadata = uidFromPath; // Use the path UID if metadata is missing
    }
    const uid = uidFromMetadata; // Use the determined UID
    functions.logger.log(`Using UID: ${uid}`);
    // --- End Get User ID ---

    // Extract filename
    const fileName = filePath?.split('/').pop() ?? "unknown_file.pdf";
    functions.logger.log(`Using FileName: ${fileName}`);

    // --- Get Configuration Values ---
    const docProcessorPath = functions.config().cv?.doc_processor_path; // Use the new config key
    const vertexModelName = functions.config().cv?.vertex_model; // Use the new config key

    if (!docProcessorPath) {
        functions.logger.error("Document AI Processor Path (cv.doc_processor_path) is not set in Functions config. Run 'firebase functions:config:set cv.doc_processor_path=\"YOUR_PROCESSOR_PATH\"'.");
        // Consider updating Firestore with an error state for the user
        return;
    }
     if (!vertexModelName) {
        functions.logger.error("Vertex AI Model Name (cv.vertex_model) is not set in Functions config. Run 'firebase functions:config:set cv.vertex_model=\"YOUR_MODEL_PATH\"'.");
        // Consider updating Firestore with an error state for the user
        return;
    }

     // Ensure project ID is correctly retrieved from the environment
    const projectId = process.env.GCLOUD_PROJECT;
    if (!projectId) {
        functions.logger.error("Google Cloud Project ID is not available in the environment (GCLOUD_PROJECT).");
        return;
    }

    // Use the configured processor path directly
    const processorName = docProcessorPath;
    functions.logger.log(`Using Document AI Processor: ${processorName}`);
     functions.logger.log(`Using Vertex AI Model: ${vertexModelName}`);


    // --- Download File ---
    const bucket = storage.bucket(bucketName);
    const remoteFile = bucket.file(filePath);
    let fileBuffer: Buffer;
    try {
        const [buffer] = await remoteFile.download();
        fileBuffer = buffer;
        functions.logger.log(`Successfully downloaded ${filePath} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
    } catch (err: any) {
        functions.logger.error(`Failed to download file ${filePath}:`, err);
        return;
    }

    // --- Process with Document AI ---
    const encodedImage = fileBuffer.toString("base64");
    const request = {
      name: processorName, // Use the configured processor path
      rawDocument: {
        content: encodedImage,
        mimeType: "application/pdf",
      },
       skipHumanReview: true,
    };

    let documentText = "";
    try {
      functions.logger.log("Sending request to Document AI...");
      const [result] = await docAIClient.processDocument(request);
       functions.logger.log("Document AI processing successful.");
      if (result.document?.text) {
        documentText = result.document.text;
        functions.logger.log(`Extracted text length: ${documentText.length} characters.`);
        // Log only the first 500 chars for brevity and privacy
        functions.logger.debug("Extracted text sample (first 500 chars):", documentText.substring(0, 500));
      } else {
        functions.logger.warn("Document AI processed the file but found no text.");
        // Decide if to proceed with empty text or exit
        // Proceeding allows creating a basic Firestore doc, exiting might be better?
        // Let's exit for now, as no text means no useful extraction.
        return;
      }
    } catch (err: any) {
      functions.logger.error("Document AI processing failed:", err.message || err);
      functions.logger.error("Document AI Error Details:", err); // Log full error
      return;
    }

    // --- Process with Vertex AI ---
    // Initialize the specific model using the configured name
    const generativeModel = vertexAI.getGenerativeModel({
        model: vertexModelName, // Use the configured model name
    });

     const prompt = `
        Extract information from the following résumé text. Return a valid JSON object *exactly* matching this TypeScript type structure:

        type OutputStructure = {
          personalInfo: {
            fullName: string | null;
            jobTitle: string | null;
            email: string | null;
            phone: string | null;
            address: string | null;
          } | null;
          summary: string | null; // Also known as objective or profile
          education: {
            degree: string | null;
            institution: string | null;
            graduationYear: string | null;
            details: string | null; // e.g., thesis title, honors
          }[] | null;
          experience: {
            jobTitle: string | null;
            company: string | null;
            startDate: string | null; // e.g., "Jan 2020", "2020"
            endDate: string | null; // e.g., "Dec 2022", "Present"
            description: string | null; // Key responsibilities/achievements
          }[] | null;
          skills: { name: string }[] | null; // Array of skill objects
          languages: string[] | null; // Array of language names
          hobbies: string[] | null; // Array of hobby names
          customSections: {
            title: string | null; // Title of any other section found
            content: string | null; // Content of that section
          }[] | null;
        };

        Maintain Arabic labels and values if they are present in the original résumé text.
        If a field or section is not found in the text, represent it as 'null' or omit the key-value pair where appropriate (e.g., omit 'address' if not found, use null for 'summary' if not found, use empty array [] for 'experience' if none found).
        Ensure the final output is ONLY the JSON object, without any introductory text or markdown formatting like \`\`\`json.

        Résumé Text:
        \`\`\`
        ${documentText}
        \`\`\`

        JSON Output:
        `;

    functions.logger.log("Sending request to Vertex AI (Gemini)...");
    let extractedJson: any = {}; // Use 'any' for initial dynamic structure
    try {
        const result = await generativeModel.generateContent(prompt);
        const response = result.response;

        if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
            let jsonString = response.candidates[0].content.parts[0].text || "";
            functions.logger.log("Vertex AI raw response text received.");
            // Attempt to clean potential markdown ```json ... ``` markers
            jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();

            try {
                extractedJson = JSON.parse(jsonString);
                functions.logger.log("Successfully parsed JSON from Vertex AI.");
                // Log the structure for verification, avoid logging potentially large full JSON
                functions.logger.debug("Parsed JSON Keys:", Object.keys(extractedJson));
            } catch (parseError: any) {
                functions.logger.error("Failed to parse JSON from Vertex AI response:", parseError);
                functions.logger.error("Raw Vertex AI Text Response (trimmed):", jsonString.substring(0, 500)); // Log sample of raw text
                // Decide how to handle parsing error - maybe create a doc with raw text?
                // For now, let's exit.
                return;
            }
        } else {
            functions.logger.warn("Vertex AI response was empty or had no valid content part.");
             // Handle empty response - maybe create doc with just metadata?
             // For now, let's exit.
            return;
        }

    } catch (err: any) {
        functions.logger.error("Vertex AI processing failed:", err.message || err);
        functions.logger.error("Vertex AI Error Details:", err); // Log full error
        return;
    }

    // --- Generate Firestore Document ID using Timestamp ---
    // Generate a unique ID based on the current time. Safer than context timestamp.
    const resumeId = admin.firestore.Timestamp.now().toMillis().toString();
    const firestorePath = `users/${uid}/resumes/${resumeId}`;
    functions.logger.log(`Attempting to write mapped data to Firestore at: ${firestorePath}`);
    // --- End Generate Firestore Document ID ---


    // --- Map extractedJson to ResumeFirestoreData structure ---
    // Use nullish coalescing (??) to provide defaults for missing fields/sections
     const mappedData: ResumeFirestoreData = {
        resumeId: resumeId, // Store ID within the doc
        userId: uid,
        title: extractedJson.title ?? `مستخرج من ${fileName}`, // Use extracted title or default
        personalInfo: { // Ensure personalInfo object exists, even if fields are null
            fullName: extractedJson.personalInfo?.fullName ?? null,
            jobTitle: extractedJson.personalInfo?.jobTitle ?? null,
            email: extractedJson.personalInfo?.email ?? null,
            phone: extractedJson.personalInfo?.phone ?? null,
            address: extractedJson.personalInfo?.address ?? null,
        },
        summary: extractedJson.summary ?? null, // Use summary field (matches prompt)
        // Map education array, ensuring fields match and handling potential null/undefined array
        education: Array.isArray(extractedJson.education) ? extractedJson.education.map((edu: any) => ({
            degree: edu.degree ?? null,
            institution: edu.institution ?? null, // Use institution
            graduationYear: edu.graduationYear ?? null, // Use graduationYear
            details: edu.details ?? null, // Include details
        })) : [], // Default to empty array if not present or not an array
         // Map experience array, ensuring fields match and handling potential null/undefined array
        experience: Array.isArray(extractedJson.experience) ? extractedJson.experience.map((exp: any) => ({
            jobTitle: exp.jobTitle ?? null, // Use jobTitle
            company: exp.company ?? null,
            startDate: exp.startDate ?? null, // Use startDate
            endDate: exp.endDate ?? null, // Use endDate
            description: exp.description ?? null,
        })) : [], // Default to empty array
         // Map skills array to the expected structure { name: string }
        skills: Array.isArray(extractedJson.skills) ? extractedJson.skills.map((skill: any) => ({
             // If skills are just strings in the JSON, map them; otherwise, expect objects {name: ...}
             name: typeof skill === 'string' ? skill : (skill?.name ?? null),
        })).filter(skill => skill.name) // Filter out any skills that ended up null
         : [], // Default to empty array
        // Map languages (assuming Vertex returns array of strings based on prompt)
        languages: Array.isArray(extractedJson.languages) ? extractedJson.languages.filter(lang => typeof lang === 'string') : [], // Ensure only strings
        // Map hobbies (assuming Vertex returns array of strings based on prompt)
        hobbies: Array.isArray(extractedJson.hobbies) ? extractedJson.hobbies.filter(hobby => typeof hobby === 'string') : [], // Ensure only strings
        // Map customSections
        customSections: Array.isArray(extractedJson.customSections) ? extractedJson.customSections.map((section: any) => ({
            title: section.title ?? null,
            content: section.content ?? null,
        })).filter(section => section.title || section.content) // Filter out empty sections
         : [], // Default to empty array
        // Metadata fields
        parsingDone: true, // Crucial flag for the frontend listener
        originalFileName: fileName,
        storagePath: filePath,
        createdAt: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp
        updatedAt: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp
     };
     // --- End Mapping ---

    // --- Write to Firestore ---
    try {
      const resumeDocRef = db.doc(firestorePath);
      // Write the *mapped* data, not the raw extractedJson
      await resumeDocRef.set(mappedData);
      functions.logger.log(`✅ Successfully wrote mapped data to Firestore: ${firestorePath}`);
      functions.logger.log(`Firestore document example created at: ${firestorePath}`); // Log example path for verification

    } catch (err: any) {
      functions.logger.error(`❌ Failed to write data to Firestore (${firestorePath}):`, err);
      functions.logger.error("Firestore Write Error Details:", err); // Log full error
    }
 });

    
