
import * as logger from "firebase-functions/logger";
import { onObjectFinalized, StorageObjectData } from "firebase-functions/v2/storage";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";



import { DocumentProcessorServiceClient } from '@google-cloud/documentai';


const DOC_PROCESSOR = "projects/720520492823/locations/us/processors/96d0b7dd6d2ee817";
const BUCKET        = process.env.GCLOUD_PROJECT + ".appspot.com";

initializeApp();
export const parseResumePdf = onObjectFinalized(
  {
    bucket: BUCKET,
    eventFilters: { "object.name": "resumes_uploads/**" },
     region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540 }, async (event) => {

    const { bucket, name } = event.data;
    if (!name) return;
    logger.log("🔔 TRIGGERED on", name);

    const uid = name.split("/")[1] || "unknown";
    const fileName = name.split("/").pop()!;
    const tmp = `/tmp/${fileName}`;

    const docai = new DocumentProcessorServiceClient();
    await getStorage().bucket(bucket!).file(name).download({ destination: tmp });

    const [result] = await docai.processDocument({
      name: DOC_PROCESSOR,
      rawDocument: { content: require("fs").readFileSync(tmp), mimeType: "application/pdf" },
    });
    const text = result.document?.text ?? "";
    const prompt = `You are an expert CV parser … (same prompt المحسَّن) …`;
    
    const resumeId = Date.now().toString();    
    const db = getFirestore();
    await db.collection('users').doc(uid).collection('resumes').doc(resumeId).set({
      parsingDone: true,
      storagePath: name,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.log("✅ Written to users/%s/resumes/%s", uid, resumeId);
  });