// functions/src/index.ts

import * as logger from "firebase-functions/logger";
import type { CloudEvent } from "firebase-functions/v2";
import { onObjectFinalized, type StorageObjectData } from "firebase-functions/v2/storage";
import { initializeApp, getApps as getAdminApps, type App as AdminApp } from "firebase-admin/app";
import { getFirestore, FieldValue, setDoc, doc, serverTimestamp } from "firebase-admin/firestore";
import { getStorage as getAdminStorage } from "firebase-admin/storage";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { VertexAI } from "@google-cloud/vertexai";
import * as functions from "firebase-functions";
import * as fs from "node:fs"; // Import fs for reading file


// Ensure Firebase Admin SDK is initialized only once
if (!getAdminApps().length) {
  initializeApp();
}
const db = getFirestore(); // Initialize Firestore globally after app init

const BUCKET = process.env.GCLOUD_PROJECT + ".appspot.com";
const DOC_AI_REGION = "us"; // Or your specific region

const processorPath = functions.config().cv.doc_processor_path;
const vertexModelPath = functions.config().cv.vertex_model;


const docaiClient = new DocumentProcessorServiceClient();
const vertexAI = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: "us-central1" }); // Assuming us-central1 for Vertex
const generativeModel = vertexAI.getGenerativeModel({ model: vertexModelPath });


export const parseResumePdf = onObjectFinalized(
  {
    region: "us-central1", // Keep consistent with where function is deployed
    bucket: BUCKET,
    eventFilters: { ["object.name"]: "resumes_uploads/**" }, // Corrected key syntax
    memory: "1GiB",
    timeoutSeconds: 540,
    cpu: 1, // Added CPU from previous requests
  },
  async (event: CloudEvent<StorageObjectData>) => {
    const { bucket, name, metageneration } = event.data;

    if (!name) {
      logger.log("Object name is undefined, exiting.");
      return;
    }
    // Check for metageneration to avoid infinite loops from updates by the function itself
    if (metageneration && parseInt(metageneration, 10) > 1) {
        logger.log("This is a metadata update event, not a new upload. Skipping.");
        return;
    }

    logger.log("🔔 TRIGGERED on", name);


    if (!name.startsWith("resumes_uploads/")) {
      logger.log("File is not in resumes_uploads/, skipping.");
      return;
    }

    const uid = name.split("/")[1];
    if (!uid) {
      logger.error("Could not extract UID from path:", name);
      return;
    }
    const fileName = name.split("/").pop()!;
    const tempFilePath = `/tmp/${fileName}`;

    if (!processorPath) {
      logger.error("Document AI processor path is not configured. Set functions.config().cv.doc_processor_path");
      // Optionally, write parsingError to Firestore
      const errorResumeId = Date.now().toString();
      await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
          parsingError: "config_error_docai_path",
          storagePath: name,
          originalFileName: fileName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
      });
      return;
    }
    if (!vertexModelPath) {
        logger.error("Vertex AI model path is not configured. Set functions.config().cv.vertex_model");
        const errorResumeId = Date.now().toString();
        await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "config_error_vertex_model",
            storagePath: name,
            originalFileName: fileName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        return;
    }


    try {
      // 1. Download file
      await getAdminStorage().bucket(bucket).file(name).download({ destination: tempFilePath });
      logger.log("📄 File downloaded to", tempFilePath);

      // 2. OCR via Document AI
      const fileContent = fs.readFileSync(tempFilePath);
      const [docAiResult] = await docaiClient.processDocument({
        name: processorPath,
        rawDocument: { content: fileContent, mimeType: "application/pdf" },
      });
      const rawText = docAiResult.document?.text ?? "";
      logger.log("📝 OCR extracted text length:", rawText.length);
      if (!rawText.trim()) {
        logger.warn("OCR result is empty. Writing parsingError to Firestore.");
        const errorResumeId = Date.now().toString();
        await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ocr_empty_result",
            storagePath: name,
            originalFileName: fileName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
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

      const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
      // Assuming the response structure is { response: { candidates: [ { content: { parts: [ { text: 'json_string' } ] } } ] } }
      // Adjust based on actual Vertex AI SDK response structure.
      // The previous code used `const [{ text: jsonString }] = await ...` which might be specific to an older SDK version or model.
      // Let's try to access it more robustly.
      let jsonString = "";
      if (aiResponse.response && aiResponse.response.candidates && aiResponse.response.candidates.length > 0) {
          const firstCandidate = aiResponse.response.candidates[0];
          if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
              jsonString = firstCandidate.content.parts[0].text || "";
          }
      }

      logger.log("🎯 Vertex AI raw JSON string:", jsonString);

      if (!jsonString.trim()) {
        logger.warn("Vertex AI returned empty string. Writing parsingError to Firestore.");
         const errorResumeId = Date.now().toString();
         await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
             parsingError: "vertex_empty_response",
             storagePath: name,
             originalFileName: fileName,
             createdAt: serverTimestamp(),
             updatedAt: serverTimestamp(),
         });
        return;
      }


      let extractedData;
      try {
        extractedData = JSON.parse(jsonString);
      } catch (e: any) { // Explicitly type 'e'
        logger.error("🚨 Failed to parse JSON from Vertex AI:", e.message, "Raw string:", jsonString);
        const errorResumeId = Date.now().toString(); // Use a different ID for error doc
        await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
          parsingError: `vertex_json_parse_error: ${e.message}`,
          rawAiOutput: jsonString, // Store the problematic string for debugging
          storagePath: name,
          originalFileName: fileName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return; // Stop processing
      }

      logger.log("📊 Parsed JSON from Vertex AI:", extractedData);

      // Validate crucial fields (e.g., fullName)
      if (!extractedData.personalInfo?.fullName) {
        logger.warn("AI output missing crucial data (e.g., fullName). Writing parsingError to Firestore.");
        const errorResumeId = Date.now().toString();
        await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
            parsingError: "ai_output_missing_fullname",
            extractedData: extractedData, // Store what was extracted
            storagePath: name,
            originalFileName: fileName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        return;
      }

      // 4. Write to Firestore
      const resumeId = Date.now().toString(); // Use Firestore server timestamp for ID generation if preferred
      const resumeDocRef = doc(db, "users", uid, "resumes", resumeId);

      // Construct the final object to save, matching the FirestoreResumeData interface
      const finalResumeData = {
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
        education: (extractedData.education || []).map((edu: any) => ({ // Ensure it's an array
            degree: edu.degree || null,
            institution: edu.institution || edu.institute || null, // Handle both institution/institute
            graduationYear: edu.graduationYear || edu.year || null, // Handle both graduationYear/year
            details: edu.details || null,
        })),
        experience: (extractedData.experience || []).map((exp: any) => ({
            jobTitle: exp.jobTitle || exp.title || null, // Handle both jobTitle/title
            company: exp.company || null,
            startDate: exp.startDate || exp.start || null, // Handle both startDate/start
            endDate: exp.endDate || exp.end || null,
            description: exp.description || null,
        })),
        skills: (extractedData.skills || []).map((skill: any) => ({ // Map skills to {name: string}
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
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };


      await setDoc(resumeDocRef, finalResumeData);
      logger.log("✅ Successfully wrote resume to users/%s/resumes/%s", uid, resumeId);

    } catch (error: any) { // Explicitly type 'error'
      logger.error("🚨 Unhandled error in parseResumePdf:", error.message, { errorObj: error });
      const errorResumeId = Date.now().toString();
      await setDoc(doc(db, "users", uid, "resumes", errorResumeId), {
        parsingError: `unknown_function_error: ${error.message}`,
        storagePath: name,
        originalFileName: fileName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } finally {
        // Clean up the temporary file
        if (fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                logger.log("🗑️ Temporary file deleted:", tempFilePath);
            } catch (unlinkError: any) {
                logger.error("🚨 Error deleting temporary file:", unlinkError.message);
            }
        }
    }
  }
);


// --- suggestSummary Cloud Function ---
export const suggestSummary = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
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
        const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
        let summaryText = "";
         if (aiResponse.response && aiResponse.response.candidates && aiResponse.response.candidates.length > 0) {
             const firstCandidate = aiResponse.response.candidates[0];
             if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
                 summaryText = firstCandidate.content.parts[0].text || "";
             }
         }
        logger.info("💡 suggestSummary AI response:", { jobTitle, summaryText });
        return { summary: summaryText.trim() };
    } catch (error: any) {
        logger.error("🚨 Error in suggestSummary:", error.message, { jobTitle });
        throw new functions.https.HttpsError('internal', 'Failed to generate summary.', error.message);
    }
});


// --- suggestSkills Cloud Function ---
export const suggestSkills = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
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
        const aiResponse = await generativeModel.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
        let skillsJsonString = "";
        if (aiResponse.response && aiResponse.response.candidates && aiResponse.response.candidates.length > 0) {
             const firstCandidate = aiResponse.response.candidates[0];
             if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
                 skillsJsonString = firstCandidate.content.parts[0].text || "[]";
             }
         }

        logger.info("💡 suggestSkills AI response:", { jobTitle, skillsJsonString });
        // Attempt to parse the string, ensure it's an array of strings
        let suggestedSkills: string[] = [];
        try {
            const parsed = JSON.parse(skillsJsonString);
            if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
                suggestedSkills = parsed;
            } else {
                logger.warn("suggestSkills: AI response was not a valid JSON array of strings. Raw:", skillsJsonString);
            }
        } catch (parseError: any) {
            logger.error("🚨 Error parsing skills JSON from AI:", parseError.message, "Raw:", skillsJsonString);
             // Fallback: try to extract skills if it's a comma-separated list or similar
             if (typeof skillsJsonString === 'string' && !skillsJsonString.includes('[') && !skillsJsonString.includes('{')) {
                suggestedSkills = skillsJsonString.split(',').map(s => s.trim()).filter(Boolean);
             }
        }

        return { skills: suggestedSkills.slice(0, max) }; // Ensure max limit
    } catch (error: any) {
        logger.error("🚨 Error in suggestSkills:", error.message, { jobTitle });
        throw new functions.https.HttpsError('internal', 'Failed to suggest skills.', error.message);
    }
});
