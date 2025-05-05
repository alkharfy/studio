
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

// Initialize Document AI Client
const docAIClient = new DocumentProcessorServiceClient({apiEndpoint: "us-documentai.googleapis.com"});

// Initialize Vertex AI Client
const vertexAI = new VertexAI({project: process.env.GCLOUD_PROJECT, location: "us-central1"});
const generativeModel = vertexAI.getGenerativeModel({
  model: "gemini-1.0-pro", // Using gemini-1.0-pro
});


// Define the structure for the data we want to store in Firestore.
// This should align with src/lib/dbTypes.ts (but uses Firestore Admin types)
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

    functions.logger.log(`Processing file: ${filePath} in bucket: ${bucketName}`);

    if (!contentType?.startsWith("application/pdf")) {
      functions.logger.warn(`File ${filePath} is not a PDF (${contentType}). Exiting.`);
      return;
    }

    const pathParts = filePath?.split("/");
    if (!pathParts || pathParts.length < 3 || pathParts[0] !== "resumes_uploads") {
      functions.logger.warn(`File ${filePath} is not in the expected 'resumes_uploads/{uid}/' directory. Exiting.`);
      return;
    }

    const uid = pathParts[1];
    const fileName = pathParts[pathParts.length - 1];
    functions.logger.log(`Extracted UID: ${uid}, FileName: ${fileName}`);

    // Use lowercase key for config access
    const processorId = functions.config().cv?.docprocessorid;
    if (!processorId) {
        functions.logger.error("Document AI Processor ID (cv.docprocessorid) is not set in Functions config. Run 'firebase functions:config:set cv.docprocessorid=YOUR_PROCESSOR_ID'.");
        // Consider updating Firestore with an error state for the user
        return;
    }
     // Ensure project ID is correctly retrieved from the environment
    const projectId = process.env.GCLOUD_PROJECT;
    if (!projectId) {
        functions.logger.error("Google Cloud Project ID is not available in the environment (GCLOUD_PROJECT).");
        return;
    }
    const processorName = `projects/${projectId}/locations/us/processors/${processorId}`;
    functions.logger.log(`Using Document AI Processor: ${processorName}`);


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

    const encodedImage = fileBuffer.toString("base64");
    const request = {
      name: processorName,
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
        functions.logger.debug("Extracted text sample:", documentText.substring(0, 500));
      } else {
        functions.logger.warn("Document AI processed the file but found no text.");
        return;
      }
    } catch (err: any) {
      functions.logger.error("Document AI processing failed:", err.message || err);
      functions.logger.error("Document AI Error Details:", err); // Log full error
      return;
    }

    // Updated prompt to match Firestore structure (using 'summary' instead of 'objective', 'institution' instead of 'institute', etc.)
     const prompt = `
        Extract the following résumé fields strictly in JSON format from the provided text. Maintain Arabic labels and values where present in the original text. If a field is not found, omit it or use null. Ensure valid JSON output.

        Fields to extract:
        - personalInfo: { fullName, jobTitle, email, phone, address }
        - summary: string (also called objective or profile)
        - education: array of { degree, institution, graduationYear, details }
        - experience: array of { jobTitle, company, startDate, endDate, description }
        - skills: array of { name: string }
        - languages: array of strings
        - hobbies: array of strings
        - customSections: array of { title, content } (for any other sections not listed above)

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
            jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();

            try {
                extractedJson = JSON.parse(jsonString);
                functions.logger.log("Successfully parsed JSON from Vertex AI:", JSON.stringify(extractedJson, null, 2));
            } catch (parseError: any) {
                functions.logger.error("Failed to parse JSON from Vertex AI response:", parseError);
                functions.logger.error("Raw Vertex AI Text Response:", jsonString);
                return;
            }
        } else {
            functions.logger.warn("Vertex AI response was empty or had no valid content part.");
            return;
        }

    } catch (err: any) {
        functions.logger.error("Vertex AI processing failed:", err.message || err);
        functions.logger.error("Vertex AI Error Details:", err); // Log full error
        return;
    }

    // Use Firestore server timestamp for ID generation
    const resumeId = admin.firestore.Timestamp.now().toMillis().toString();
    const firestorePath = `users/${uid}/resumes/${resumeId}`;
    functions.logger.log(`Attempting to write mapped data to Firestore at: ${firestorePath}`);

    // --- Map extractedJson to ResumeFirestoreData structure ---
     const mappedData: ResumeFirestoreData = {
        resumeId: resumeId, // Store ID within the doc
        userId: uid,
        title: extractedJson.title ?? `مستخرج من ${fileName}`, // Default title if not extracted
        personalInfo: {
            fullName: extractedJson.personalInfo?.fullName ?? null,
            jobTitle: extractedJson.personalInfo?.jobTitle ?? null,
            email: extractedJson.personalInfo?.email ?? null,
            phone: extractedJson.personalInfo?.phone ?? null,
            address: extractedJson.personalInfo?.address ?? null,
        },
        summary: extractedJson.summary ?? null, // Use summary field
        // Map education array, ensuring fields match
        education: Array.isArray(extractedJson.education) ? extractedJson.education.map((edu: any) => ({
            degree: edu.degree ?? null,
            institution: edu.institution ?? null, // Use institution
            graduationYear: edu.graduationYear ?? null, // Use graduationYear
            details: edu.details ?? null, // Include details
        })) : [],
         // Map experience array, ensuring fields match
        experience: Array.isArray(extractedJson.experience) ? extractedJson.experience.map((exp: any) => ({
            jobTitle: exp.jobTitle ?? null, // Use jobTitle
            company: exp.company ?? null,
            startDate: exp.startDate ?? null, // Use startDate
            endDate: exp.endDate ?? null, // Use endDate
            description: exp.description ?? null,
        })) : [],
         // Map skills array to the expected structure { name: string }
        skills: Array.isArray(extractedJson.skills) ? extractedJson.skills.map((skill: any) => ({
             // If skills are just strings, map them; otherwise, expect objects
             name: typeof skill === 'string' ? skill : (skill?.name ?? null),
        })) : [],
        // Map languages (assuming Vertex returns array of strings based on prompt)
        languages: Array.isArray(extractedJson.languages) ? extractedJson.languages : [],
        // Map hobbies (assuming Vertex returns array of strings based on prompt)
        hobbies: Array.isArray(extractedJson.hobbies) ? extractedJson.hobbies : [],
        // Map customSections
        customSections: Array.isArray(extractedJson.customSections) ? extractedJson.customSections.map((section: any) => ({
            title: section.title ?? null,
            content: section.content ?? null,
        })) : [],
        // Metadata fields
        parsingDone: true,
        originalFileName: fileName,
        storagePath: filePath,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
     };
     // --- End Mapping ---

    try {
      const resumeDocRef = db.doc(firestorePath);
      // Write the mapped data, not the raw extractedJson
      await resumeDocRef.set(mappedData);
      functions.logger.log(`Successfully wrote mapped data to Firestore: ${firestorePath}`);
      functions.logger.log(`Firestore document example created at: ${firestorePath}`); // Log example path

    } catch (err: any) {
      functions.logger.error(`Failed to write data to Firestore (${firestorePath}):`, err);
      functions.logger.error("Firestore Write Error Details:", err); // Log full error
    }
 });
