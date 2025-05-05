
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {DocumentProcessorServiceClient} from "@google-cloud/documentai";
import {VertexAI} from "@google-cloud/vertexai";
import {Storage} from "@google-cloud/storage";

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();
const storage = new Storage();

// Initialize Document AI Client
// Note: The region should match your processor's region ('us' in your case)
const docAIClient = new DocumentProcessorServiceClient({apiEndpoint: "us-documentai.googleapis.com"});

// Initialize Vertex AI Client
const vertexAI = new VertexAI({project: process.env.GCLOUD_PROJECT, location: "us-central1"});
// Specify the model name (ensure this model is available and suitable)
const generativeModel = vertexAI.getGenerativeModel({
  model: "gemini-1.0-pro", // Using gemini-1.0-pro as text-bison-32k might be legacy
});

// Cloud Function definition with updated resources and region
export const parseResumePdf = functions.runWith({
  cpu: 1,
  memory: "1GiB",
  timeoutSeconds: 540,
}).region("us-central1") // Explicitly set region if needed, defaults to us-central1
  .storage
  .object()
  .onFinalize(async (object) => {
    const filePath = object.name; // File path in the bucket
    const contentType = object.contentType; // File contentType
    const bucketName = object.bucket;

    // Log basic info
    functions.logger.log(`Processing file: ${filePath} in bucket: ${bucketName}`);

    // Exit if this is triggered on a file that is not a PDF
    if (!contentType?.startsWith("application/pdf")) {
      functions.logger.warn(`File ${filePath} is not a PDF (${contentType}). Exiting.`);
      return;
    }

    // Exit if the file is not in the expected directory structure
    const pathParts = filePath?.split("/");
    if (!pathParts || pathParts.length < 3 || pathParts[0] !== "resumes_uploads") {
      functions.logger.warn(`File ${filePath} is not in the expected 'resumes_uploads/{uid}/' directory. Exiting.`);
      return;
    }

    const uid = pathParts[1];
    const fileName = pathParts[pathParts.length - 1];
    functions.logger.log(`Extracted UID: ${uid}, FileName: ${fileName}`);

    // Read processor ID from config
    const processorId = functions.config().cv?.docprocessorid; // Ensure key is lowercase
    if (!processorId) {
        functions.logger.error("Document AI Processor ID (cv.docprocessorid) is not set in Functions config. Run 'firebase functions:config:set cv.docprocessorid=YOUR_PROCESSOR_ID'.");
        // Optionally, update Firestore with an error state for the user
        return;
    }
    const processorName = `projects/${process.env.GCLOUD_PROJECT}/locations/us/processors/${processorId}`;
    functions.logger.log(`Using Document AI Processor: ${processorName}`);


    // Download the file from Cloud Storage
    const bucket = storage.bucket(bucketName);
    const remoteFile = bucket.file(filePath);
    let fileBuffer: Buffer;
    try {
        const [buffer] = await remoteFile.download();
        fileBuffer = buffer;
        functions.logger.log(`Successfully downloaded ${filePath} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);
    } catch (err: any) {
        functions.logger.error(`Failed to download file ${filePath}:`, err);
        return; // Exit if download fails
    }

    // Prepare Document AI request
    const encodedImage = fileBuffer.toString("base64");
    const request = {
      name: processorName,
      rawDocument: {
        content: encodedImage,
        mimeType: "application/pdf",
      },
      // Optional: Specify process options if needed
      // processOptions: {
      //    ocrConfig: { enableNativePdfParsing: true } // Example
      // }
       // Skip human review for automated processing
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
        // Log first 500 chars for verification
        functions.logger.debug("Extracted text sample:", documentText.substring(0, 500));
      } else {
        functions.logger.warn("Document AI processed the file but found no text.");
        // Optionally, update Firestore with a parsing status
        return; // Exit if no text extracted
      }
    } catch (err: any) {
      functions.logger.error("Document AI processing failed:", err.message || err);
      functions.logger.error("Document AI Error Code:", err.code);
       // Optionally, update Firestore with an error state for the user
      return; // Exit on Document AI error
    }

    // Prepare prompt for Vertex AI (Gemini)
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
    let extractedJson: any = {};
    try {
        const result = await generativeModel.generateContent(prompt);
        const response = result.response;

        if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
            let jsonString = response.candidates[0].content.parts[0].text || "";
            functions.logger.log("Vertex AI raw response text received.");
            // Clean the response: remove markdown backticks and potentially leading/trailing text
            jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();

            try {
                extractedJson = JSON.parse(jsonString);
                 functions.logger.log("Successfully parsed JSON from Vertex AI:", JSON.stringify(extractedJson, null, 2)); // Log the parsed JSON
            } catch (parseError: any) {
                functions.logger.error("Failed to parse JSON from Vertex AI response:", parseError);
                functions.logger.error("Raw Vertex AI Text Response:", jsonString);
                // Optionally, update Firestore with an error state
                return; // Exit if JSON parsing fails
            }
        } else {
            functions.logger.warn("Vertex AI response was empty or had no valid content part.");
            // Optionally, update Firestore indicating extraction failed
            return; // Exit if no valid response
        }

    } catch (err: any) {
        functions.logger.error("Vertex AI processing failed:", err.message || err);
         functions.logger.error("Vertex AI Error Details:", err);
        // Optionally, update Firestore with an error state for the user
        return; // Exit on Vertex AI error
    }

    // Write the extracted JSON to Firestore
    const resumeId = Date.now().toString(); // Use timestamp for a simple unique ID for this context
    const firestorePath = `users/${uid}/resumes/${resumeId}`;
    functions.logger.log(`Attempting to write extracted data to Firestore at: ${firestorePath}`);

    try {
      const resumeDocRef = db.doc(firestorePath);
      await resumeDocRef.set({
          resumeId: resumeId, // Store ID within the doc
          userId: uid,
          title: `مستخرج من ${fileName}`, // Default title
          ...extractedJson, // Spread the extracted JSON fields
          parsingDone: true, // Flag indicating completion
          originalFileName: fileName, // Store original file name
          storagePath: filePath, // Store the storage path
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }); // Use merge: true to potentially update existing fields if needed, or setDoc directly

      functions.logger.log(`Successfully wrote data to Firestore: ${firestorePath}`);
    } catch (err: any) {
      functions.logger.error(`Failed to write data to Firestore (${firestorePath}):`, err);
      // Consider how to handle Firestore write errors (e.g., retry, notify user)
    }
 });
