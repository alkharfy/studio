
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
let vertexModelName: string; // Store model name for reuse

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
    vertexModelName = functions.config().cv?.vertex_model; // Assign to outer scope variable
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
    // Rely on function logs for debugging
}


// --- Firestore Data Structure ---
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
  summary?: string | null;
  education?: {
    degree?: string | null;
    institution?: string | null;
    graduationYear?: string | null;
    details?: string | null;
  }[] | null;
  experience?: {
    jobTitle?: string | null;
    company?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    description?: string | null;
  }[] | null;
  skills?: { name?: string | null }[] | null;
  languages?: { name?: string | null; level?: string | null }[] | null;
  hobbies?: string[] | null;
  customSections?: {
    title?: string | null;
    content?: string | null;
  }[] | null;
  parsingDone: boolean;
  storagePath: string | null;
  originalFileName?: string | null;
  createdAt: admin.firestore.FieldValue | Timestamp;
  updatedAt: admin.firestore.FieldValue | Timestamp;
}


// --- parseResumePdf Cloud Function ---
export const parseResumePdf = functions.runWith({
  cpu: 1,
  memory: "1GiB",
  timeoutSeconds: 540,
}).region(DOC_AI_REGION) // Match Doc AI region
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
    let uid: string | undefined = objectMetadata?.uid;
    if (uid) {
      functions.logger.log(`Found UID in metadata: ${uid}`);
    } else {
      const pathParts = filePath.split("/");
      if (pathParts.length >= 3 && pathParts[0] === "resumes_uploads") {
        uid = pathParts[1];
        functions.logger.log(`Extracted UID from path: ${uid}`);
      }
    }
    if (!uid) {
        functions.logger.error(`Could not determine UID for file ${filePath}. Missing 'uid' in custom metadata or path. Exiting.`);
        return;
    }
     functions.logger.log(`Using UID: ${uid} for Firestore path.`);
    // --- End Get User ID ---

    const fileName = filePath.split('/').pop() ?? "unknown_file.pdf";
    functions.logger.log(`Extracted FileName: ${fileName}`);

    // --- Get Document AI Processor Path from Config ---
    const processorPath = functions.config().cv?.doc_processor_path;
    if (!processorPath) {
        functions.logger.error("FATAL: Document AI Processor Path (cv.doc_processor_path) is not set in Functions config. Exiting.");
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
        return;
    }

    // --- Process with Document AI (OCR) ---
    let rawText = "";
    try {
      const encodedImage = fileBuffer.toString("base64");
      const request = {
        name: processorPath,
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
        functions.logger.debug("Extracted text sample (first 500 chars):", rawText.substring(0, 500));
      } else {
        functions.logger.warn("Document AI processed the file but found no text.");
      }
    } catch (docAIError: any) {
      functions.logger.error("Document AI processing failed:", docAIError.message || docAIError);
      functions.logger.error("Document AI Error Details:", docAIError);
      return;
    }

    // --- Process with Vertex AI (Extraction) ---
    let extractedJson: any = {};
    try {
       const prompt = `
            Extract the following résumé fields in valid JSON only (no code block or markdown like \`\`\`json):
            {
              "title": "string|null",
              "fullName": "string|null",
              "jobTitle": "string|null",
              "email": "string|null",
              "phone": "string|null",
              "address": "string|null",
              "summary": "string|null",
              "education": [{ "degree": "string|null", "institution": "string|null", "graduationYear": "string|null", "details": "string|null" }],
              "experience": [{ "jobTitle": "string|null", "company": "string|null", "startDate": "string|null", "endDate": "string|null", "description": "string|null" }],
              "skills": [{ "name": "string|null" }],
              "languages": [{ "name": "string|null", "level": "string|null" }],
              "hobbies": ["string"],
              "customSections": [{"title": "string|null", "content": "string|null"}]
            }

            Maintain Arabic labels and values if they are present in the original résumé text.
            If a field or section is not found, represent it as 'null' or an empty array [] as appropriate in the JSON structure.
            Ensure the final output is a single valid JSON object.

            TEXT:
            """
            ${rawText}
            """

            JSON Output:
            `;


      functions.logger.log("Sending request to Vertex AI (Gemini)...");
      functions.logger.debug(`Vertex AI Prompt Length: ${prompt.length} characters`);

      const result = await generativeModel.generateContent(prompt);
      const response = result.response;

      if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
        let jsonString = response.candidates[0].content.parts[0].text || "";
        functions.logger.log("Vertex AI raw response text received.");
        jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();

        try {
          extractedJson = JSON.parse(jsonString);
          functions.logger.log("Successfully parsed JSON from Vertex AI response.");
          functions.logger.debug("Parsed JSON Keys:", Object.keys(extractedJson));
        } catch (parseError: any) {
          functions.logger.error("Failed to parse JSON from Vertex AI response:", parseError);
          functions.logger.error("Raw Vertex AI Text Response (trimmed):", jsonString.substring(0, 500));
        }
      } else {
        functions.logger.warn("Vertex AI response was empty or had no valid content part.");
      }

    } catch (vertexError: any) {
      functions.logger.error("Vertex AI processing failed:", vertexError.message || vertexError);
      functions.logger.error("Vertex AI Error Details:", vertexError);
    }

    // --- Generate Firestore Document ID using Timestamp ---
    const resumeId = admin.firestore.Timestamp.now().toMillis().toString();
    const firestorePath = `users/${uid}/resumes/${resumeId}`;
    functions.logger.log(`Generated Firestore Document ID: ${resumeId}. Path: ${firestorePath}`);
    // --- End Generate Firestore Document ID ---


    // --- Map extractedJson to the target ResumeFirestoreData structure ---
     const mappedData: ResumeFirestoreData = {
        resumeId: resumeId,
        userId: uid,
        title: extractedJson.title ?? `مستخرج من ${fileName}`,
        personalInfo: {
            fullName: extractedJson.fullName ?? null,
            jobTitle: extractedJson.jobTitle ?? null,
            email: extractedJson.email ?? null,
            phone: extractedJson.phone ?? null,
            address: extractedJson.address ?? null,
        },
        summary: extractedJson.summary ?? null,
        education: Array.isArray(extractedJson.education) ? extractedJson.education.map((edu: any) => ({
            degree: edu.degree ?? null,
            institution: edu.institution ?? null,
            graduationYear: edu.graduationYear ?? null,
            details: edu.details ?? null,
        })).filter(edu => edu.degree || edu.institution || edu.graduationYear)
         : [],
        experience: Array.isArray(extractedJson.experience) ? extractedJson.experience.map((exp: any) => ({
            jobTitle: exp.jobTitle ?? null,
            company: exp.company ?? null,
            startDate: exp.startDate ?? null,
            endDate: exp.endDate ?? null,
            description: exp.description ?? null,
        })).filter(exp => exp.jobTitle || exp.company || exp.startDate || exp.endDate || exp.description)
         : [],
        skills: Array.isArray(extractedJson.skills) ? extractedJson.skills.map((skill: any) => ({
             name: skill.name ?? null,
        })).filter(skill => skill.name)
         : [],
        languages: Array.isArray(extractedJson.languages) ? extractedJson.languages.map((lang: any) => ({
             name: lang.name ?? null,
             level: lang.level ?? null,
        })).filter(lang => lang.name || lang.level)
         : [],
        hobbies: Array.isArray(extractedJson.hobbies) ? extractedJson.hobbies.filter((hobby: any) => typeof hobby === 'string') : [],
        customSections: Array.isArray(extractedJson.customSections) ? extractedJson.customSections.map((section: any) => ({
             title: section.title ?? null,
             content: section.content ?? null,
        })).filter(section => section.title || section.content)
         : [],
        parsingDone: true,
        storagePath: filePath,
        originalFileName: fileName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
     };
     functions.logger.log("Successfully mapped extracted JSON to Firestore schema.");
     functions.logger.debug("Mapped Firestore Data Keys:", Object.keys(mappedData));
     // --- End Mapping ---


    // --- Write Mapped Data to Firestore ---
    try {
      const resumeDocRef = db.doc(firestorePath);
      await resumeDocRef.set(mappedData);
      functions.logger.log(`✅ Successfully wrote mapped data to Firestore: ${firestorePath}`);

    } catch (firestoreError: any) {
      functions.logger.error(`❌ Failed to write data to Firestore (${firestorePath}):`, firestoreError.message || firestoreError);
      functions.logger.error("Firestore Write Error Details:", firestoreError);
    }
 });


// --- suggestSummary Cloud Function ---
export const suggestSummary = functions.runWith({
    region: VERTEX_AI_REGION, // Match Vertex AI region
    memory: "512MiB",
}).https.onCall(async (data, context) => {
    // --- Authentication Check ---
    // if (!context.auth) {
    //     throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    // }

    // --- Input Validation ---
    const { jobTitle, yearsExp = 0, skills = [], lang = "ar" } = data;

    if (!jobTitle || typeof jobTitle !== "string") {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
    }
    if (typeof yearsExp !== 'number' || yearsExp < 0) {
        throw new functions.https.HttpsError('invalid-argument', '"yearsExp" must be a non-negative number.');
    }
    if (!Array.isArray(skills) || !skills.every(s => typeof s === 'string')) {
        throw new functions.https.HttpsError('invalid-argument', '"skills" must be an array of strings.');
    }
    if (typeof lang !== 'string' || lang.length !== 2) {
        throw new functions.https.HttpsError('invalid-argument', '"lang" must be a valid two-letter language code.');
    }

    functions.logger.log(`Generating summary for: Job Title='${jobTitle}', Years Exp=${yearsExp}, Skills='${skills.join(", ")}', Lang='${lang}'`);

    // --- AI Call ---
    if (!generativeModel) {
        functions.logger.error("Vertex AI model not initialized. Cannot generate summary.");
        throw new functions.https.HttpsError('internal', 'AI model is not available.');
    }

    const prompt = `
      Write a concise, engaging professional summary (~70–90 words, 2–3 sentences) in ${lang}
      for someone with the job title "${jobTitle}", ${yearsExp} years experience and skills: ${skills.join(", ")}.
      Emphasise impact and soft skills. Provide only the summary text as the response.`;

    try {
        functions.logger.log("Sending summary generation request to Vertex AI...");
        functions.logger.debug(`Summary Prompt: ${prompt}`);

        const result = await generativeModel.generateContent(prompt);
        const response = result.response;

        if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
            const summaryText = response.candidates[0].content.parts[0].text?.trim() ?? "";
            functions.logger.log("Successfully generated summary from Vertex AI.");
            functions.logger.debug(`Generated Summary: ${summaryText}`);
            return { summary: summaryText };
        } else {
            functions.logger.warn("Vertex AI response for summary generation was empty or invalid.");
            throw new functions.https.HttpsError('internal', 'Failed to generate summary from AI.');
        }
    } catch (error: any) {
        functions.logger.error("Error generating summary with Vertex AI:", error);
        throw new functions.https.HttpsError('internal', 'Failed to generate summary due to an AI error.');
    }
});


// --- suggestSkills Cloud Function ---
export const suggestSkills = functions.runWith({
    region: VERTEX_AI_REGION, // Match Vertex AI region
    memory: "512MiB",
}).https.onCall(async (data, context) => {
    // --- Authentication Check ---
    // if (!context.auth) {
    //     throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    // }

    // --- Input Validation ---
    const { jobTitle, max = 8, lang = "ar" } = data;

    if (!jobTitle || typeof jobTitle !== "string") {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
    }
     if (typeof max !== 'number' || max <= 0 || max > 20) { // Added max validation
        throw new functions.https.HttpsError('invalid-argument', '"max" must be a positive number less than or equal to 20.');
    }
     if (typeof lang !== 'string' || lang.length !== 2) {
        throw new functions.https.HttpsError('invalid-argument', '"lang" must be a valid two-letter language code.');
    }

    functions.logger.log(`Suggesting ${max} skills for: Job Title='${jobTitle}', Lang='${lang}'`);

    // --- AI Call ---
    if (!generativeModel) {
        functions.logger.error("Vertex AI model not initialized. Cannot suggest skills.");
        throw new functions.https.HttpsError('internal', 'AI model is not available.');
    }

    const prompt = `
        Suggest ${max} relevant technical and soft skills in ${lang} for the job title "${jobTitle}".
        Return the skills as a simple JSON array of strings, like ["Skill 1", "Skill 2"].
        Provide only the JSON array as the response.
        JSON Output:
    `;

    try {
        functions.logger.log("Sending skill suggestion request to Vertex AI...");
        functions.logger.debug(`Skill Suggestion Prompt: ${prompt}`);

        const result = await generativeModel.generateContent(prompt);
        const response = result.response;

        if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
            let jsonString = response.candidates[0].content.parts[0].text || "";
            functions.logger.log("Vertex AI raw response text received for skills.");
            jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();

             try {
                 const suggestedSkills = JSON.parse(jsonString);
                 if (!Array.isArray(suggestedSkills) || !suggestedSkills.every(s => typeof s === 'string')) {
                     throw new Error("AI response is not a valid JSON array of strings.");
                 }
                 functions.logger.log("Successfully parsed suggested skills from Vertex AI.");
                 functions.logger.debug(`Suggested Skills: ${suggestedSkills.join(', ')}`);
                 return { skills: suggestedSkills }; // Return { skills: [...] }
             } catch (parseError: any) {
                 functions.logger.error("Failed to parse skills JSON from Vertex AI response:", parseError);
                 functions.logger.error("Raw Vertex AI Text Response for skills (trimmed):", jsonString.substring(0, 500));
                 throw new functions.https.HttpsError('internal', 'Failed to parse suggested skills from AI response.');
             }
        } else {
            functions.logger.warn("Vertex AI response for skill suggestion was empty or invalid.");
            throw new functions.https.HttpsError('internal', 'Failed to get skill suggestions from AI.');
        }
    } catch (error: any) {
        functions.logger.error("Error suggesting skills with Vertex AI:", error);
        throw new functions.https.HttpsError('internal', 'Failed to suggest skills due to an AI error.');
    }
});


