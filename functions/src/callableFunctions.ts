
import * as functions from "firebase-functions";
import * as logger from "firebase-functions/logger";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'; // Ensure Firestore and types are imported
import * as admin from 'firebase-admin'; // Ensure admin is imported for serverTimestamp()
import { VertexAI, GenerateContentResponse } from "@google-cloud/vertexai"; // Keep VertexAI import

// Initialize Firebase Admin SDK if not already done
if (admin.apps.length === 0) {
    admin.initializeApp();
}

// --- Configuration (callable functions also need config) ---
const vertexModelName = process.env.CV_VERTEX_MODEL || functions.config().cv?.vertex_model; // Consistent config key
const gcpProject = process.env.GCLOUD_PROJECT || functions.config().cv?.project_id; // Consistent config key
const vertexAiRegion = process.env.VERTEX_AI_REGION || 'us-central1';

// --- Validation ---
if (!vertexModelName) {
    logger.error("FATAL (Callable): Vertex AI Model is not configured.");
}
if (!gcpProject) {
     logger.error("FATAL (Callable): GCP Project ID is not configured.");
}

// Initialize Clients (handle potential errors)
let vertexAI_callable: VertexAI | null = null;
let generativeModel_callable: ReturnType<VertexAI['getGenerativeModel']> | null = null;

try {
    vertexAI_callable = new VertexAI({ project: gcpProject, location: vertexAiRegion });
    logger.info(`(Callable) Vertex AI Client initialized for project: ${gcpProject}, location: ${vertexAiRegion}`);
    if (vertexAI_callable && vertexModelName) {
         generativeModel_callable = vertexAI_callable.getGenerativeModel({
             model: vertexModelName,
              // Optional: Add safetySettings or generationConfig if needed for callable functions
             // generationConfig: { maxOutputTokens: 256, temperature: 0.7 }, // Example for summaries/skills
         });
         logger.info(`(Callable) Vertex AI Model (${vertexModelName}) loaded successfully.`);
    } else if (!vertexModelName) {
        logger.error("(Callable) Vertex AI model name is missing, cannot load model.");
    }
} catch (e: any) {
    logger.error("(Callable) Error initializing Vertex AI Client or Model:", e.message || e);
    vertexAI_callable = null;
    generativeModel_callable = null;
}


// --- suggestSummary Cloud Function ---
export const suggestSummary = functions.region(vertexAiRegion) // Match Vertex AI region
    .runWith({ memory: "512MiB" }) // Use runWith for options in v1 callable
    .https.onCall(async (data, context) => {
    logger.info("suggestSummary function invoked.", { data, auth: context.auth?.uid });

    // --- Authentication Check (Optional but recommended) ---
    // if (!context.auth) {
    //     logger.warn("suggestSummary called without authentication.");
    //     throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    // }

    // --- Input Validation ---
    const { jobTitle, yearsExp = 0, skills = [], lang = "ar" } = data;

    if (!jobTitle || typeof jobTitle !== "string") {
        logger.error("Invalid input: Missing or invalid 'jobTitle'.", { jobTitle });
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
    }
    if (typeof yearsExp !== 'number' || yearsExp < 0) {
         logger.error("Invalid input: Invalid 'yearsExp'.", { yearsExp });
        throw new functions.https.HttpsError('invalid-argument', '"yearsExp" must be a non-negative number.');
    }
    if (!Array.isArray(skills) || !skills.every(s => typeof s === 'string')) {
         logger.error("Invalid input: Invalid 'skills'.", { skills });
        throw new functions.https.HttpsError('invalid-argument', '"skills" must be an array of strings.');
    }
    if (typeof lang !== 'string' || lang.length !== 2) {
         logger.error("Invalid input: Invalid 'lang'.", { lang });
        throw new functions.https.HttpsError('invalid-argument', '"lang" must be a valid two-letter language code.');
    }

    logger.log(`Generating summary for: Job Title='${jobTitle}', Years Exp=${yearsExp}, Skills='${skills.join(", ")}', Lang='${lang}'`);

    // --- AI Call ---
    if (!generativeModel_callable) {
        logger.error("Vertex AI model not initialized for callable. Cannot generate summary.");
        throw new functions.https.HttpsError('internal', 'AI model is not available.');
    }

    const prompt = `
      Write a concise, engaging professional summary (~70–90 words, 2–3 sentences) in ${lang}
      for someone with the job title "${jobTitle}", ${yearsExp} years experience and skills: ${skills.join(", ")}.
      Emphasise impact and soft skills. Provide only the summary text as the response.`;

    try {
        logger.log("Sending summary generation request to Vertex AI...");
        logger.debug(`Summary Prompt: ${prompt}`);

        const result = await generativeModel_callable.generateContent(prompt);
        const response : GenerateContentResponse = result.response; // Add type annotation

        logger.info("Received response from Vertex AI for summary.", { status: response?.usageMetadata?.totalTokenCount ? 'OK' : 'Empty/Error' });

        if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
            const summaryText = response.candidates[0].content.parts[0].text?.trim() ?? "";
            logger.log("Successfully generated summary from Vertex AI.");
            logger.debug(`Generated Summary (trimmed): ${summaryText.substring(0, 100)}...`);
            return { summary: summaryText };
        } else {
            logger.warn("Vertex AI response for summary generation was empty or invalid.", { response });
            throw new functions.https.HttpsError('internal', 'Failed to generate summary from AI: Empty or invalid response.');
        }
    } catch (error: any) {
        logger.error("Error generating summary with Vertex AI:", error);
         // Log specific details if available
         if (error.details) logger.error("Vertex AI Error Details:", error.details);
        throw new functions.https.HttpsError('internal', `Failed to generate summary due to an AI error: ${error.message || 'Unknown error'}`);
    }
});


// --- suggestSkills Cloud Function ---
export const suggestSkills = functions.region(vertexAiRegion) // Match Vertex AI region
    .runWith({ memory: "512MiB" })
    .https.onCall(async (data, context) => {
    logger.info("suggestSkills function invoked.", { data, auth: context.auth?.uid });
    // --- Authentication Check (Optional) ---
    // if (!context.auth) {
    //     logger.warn("suggestSkills called without authentication.");
    //     throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    // }

    // --- Input Validation ---
    const { jobTitle, max = 8, lang = "ar" } = data;

    if (!jobTitle || typeof jobTitle !== "string") {
        logger.error("Invalid input: Missing or invalid 'jobTitle'.", { jobTitle });
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a valid "jobTitle" argument.');
    }
     if (typeof max !== 'number' || max <= 0 || max > 20) { // Added max validation
         logger.error("Invalid input: Invalid 'max'.", { max });
        throw new functions.https.HttpsError('invalid-argument', '"max" must be a positive number less than or equal to 20.');
    }
     if (typeof lang !== 'string' || lang.length !== 2) {
         logger.error("Invalid input: Invalid 'lang'.", { lang });
        throw new functions.https.HttpsError('invalid-argument', '"lang" must be a valid two-letter language code.');
    }

    logger.log(`Suggesting ${max} skills for: Job Title='${jobTitle}', Lang='${lang}'`);

    // --- AI Call ---
    if (!generativeModel_callable) {
        logger.error("Vertex AI model not initialized for callable. Cannot suggest skills.");
        throw new functions.https.HttpsError('internal', 'AI model is not available.');
    }

    const prompt = `
        Suggest ${max} relevant technical and soft skills in ${lang} for the job title "${jobTitle}".
        Return the skills as a simple JSON array of strings, like ["Skill 1", "Skill 2"].
        Provide only the JSON array as the response.
        JSON Output:
    `;

    try {
        logger.log("Sending skill suggestion request to Vertex AI...");
        logger.debug(`Skill Suggestion Prompt: ${prompt}`);

        const result = await generativeModel_callable.generateContent(prompt);
        const response : GenerateContentResponse = result.response; // Add type annotation
        logger.info("Received response from Vertex AI for skills.", { status: response?.usageMetadata?.totalTokenCount ? 'OK' : 'Empty/Error' });


        if (response.candidates && response.candidates.length > 0 && response.candidates[0].content?.parts?.length > 0) {
            let jsonString = response.candidates[0].content.parts[0].text || "";
            logger.log("Vertex AI raw response text received for skills.");
            logger.debug("Raw Vertex AI Text Response for skills (trimmed):", jsonString.substring(0, 500)); // Log before cleaning
            jsonString = jsonString.replace(/^```json\s*|```$/g, "").trim();
            logger.debug("Cleaned Vertex AI JSON string for skills (trimmed):", jsonString.substring(0, 500)); // Log after cleaning


             try {
                 const suggestedSkills = JSON.parse(jsonString);
                 if (!Array.isArray(suggestedSkills) || !suggestedSkills.every(s => typeof s === 'string')) {
                     logger.error("AI response is not a valid JSON array of strings.", { jsonString });
                     throw new Error("AI response is not a valid JSON array of strings.");
                 }
                 functions.logger.log("Successfully parsed suggested skills from Vertex AI.");
                 functions.logger.debug(`Suggested Skills (${suggestedSkills.length}): ${suggestedSkills.join(', ')}`);
                 return { skills: suggestedSkills }; // Return { skills: [...] }
             } catch (parseError: any) {
                 logger.error("Failed to parse skills JSON from Vertex AI response:", parseError);
                 logger.error("Problematic JSON String for skills:", jsonString); // Log the string that failed parsing
                 throw new functions.https.HttpsError('internal', 'Failed to parse suggested skills from AI response.');
             }
        } else {
            logger.warn("Vertex AI response for skill suggestion was empty or invalid.", { response });
            throw new functions.https.HttpsError('internal', 'Failed to get skill suggestions from AI: Empty or invalid response.');
        }
    } catch (error: any) {
        logger.error("Error suggesting skills with Vertex AI:", error);
         // Log specific details if available
        if (error.details) logger.error("Vertex AI Error Details:", error.details);
        throw new functions.https.HttpsError('internal', `Failed to suggest skills due to an AI error: ${error.message || 'Unknown error'}`);
    }
});
