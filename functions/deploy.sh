#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
# Project ID is typically inferred by gcloud or can be set as an environment variable
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project)}"
if [ -z "$PROJECT_ID" ]; then
  echo "Error: Could not determine Project ID. Set it using 'gcloud config set project YOUR_PROJECT_ID' or export PROJECT_ID."
  exit 1
fi

# Default Functions service account (used by v1 and v2 HTTP/Callable)
# For v2 event-driven functions, this is the RUNTIME service account.
# This is usually PROJECT_ID@appspot.gserviceaccount.com for App Engine default service account
# or service-<PROJECT_NUMBER>@gcp-sa-cloudfunctions.iam.gserviceaccount.com for dedicated Cloud Functions SA
# Let's assume we are using the App Engine default SA as it's common for Firebase projects.
FUNCTIONS_SERVICE_ACCOUNT="${PROJECT_ID}@appspot.gserviceaccount.com"

# Get Project Number (needed for some default service accounts like Eventarc's own SA)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
EVENTARC_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com" # Eventarc's own service agent

# --- End Configuration ---

echo "--- Granting IAM Roles ---"
echo "Project ID: ${PROJECT_ID}"
echo "Functions Runtime Service Account: ${FUNCTIONS_SERVICE_ACCOUNT}"
echo "Eventarc Service Agent: ${EVENTARC_SERVICE_AGENT}"
echo "--------------------------"


echo "Granting roles/documentai.apiUser to ${FUNCTIONS_SERVICE_ACCOUNT}..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/documentai.apiUser" \
  --condition=None --quiet

echo "Granting roles/aiplatform.user to ${FUNCTIONS_SERVICE_ACCOUNT}..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/aiplatform.user" \
  --condition=None --quiet

echo "Granting roles/datastore.user (for Firestore) to ${FUNCTIONS_SERVICE_ACCOUNT}..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/datastore.user" \
  --condition=None --quiet

echo "Granting roles/storage.objectAdmin to ${FUNCTIONS_SERVICE_ACCOUNT} (for GCS read/write/metadata)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin" \
  --condition=None --quiet

# For Eventarc to invoke the Cloud Run service (v2 Function)
echo "Granting roles/run.invoker to ${FUNCTIONS_SERVICE_ACCOUNT} (allows Eventarc to invoke the function)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/run.invoker" \
  --condition=None --quiet

echo "Granting roles/eventarc.eventReceiver to ${FUNCTIONS_SERVICE_ACCOUNT} (allows function to receive Eventarc events)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/eventarc.eventReceiver" \
  --condition=None --quiet

# Eventarc agent needs to be able to publish events (implicitly handled usually)
# and impersonate the function's service account to create ID tokens if the function is not public.
# Granting the Eventarc Service Agent the "Service Account Token Creator" role on the function's runtime service account.
echo "Granting roles/iam.serviceAccountTokenCreator to ${EVENTARC_SERVICE_AGENT} on behalf of ${FUNCTIONS_SERVICE_ACCOUNT}..."
gcloud iam service-accounts add-iam-policy-binding "${FUNCTIONS_SERVICE_ACCOUNT}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${EVENTARC_SERVICE_AGENT}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --condition=None --quiet


echo "--- IAM roles granted successfully. ---"
echo ""
echo "--- Set Functions Configuration ---"
echo "Setting configuration variables..."

# Ensure these environment variables are set in your shell or CI/CD environment
# Or replace with direct values if not using env vars for path/model.
# Example: export CV_DOC_PROCESSOR_PATH="projects/your-gcp-project-id/locations/us/processors/your-processor-id"
# Example: export CV_VERTEX_MODEL="text-bison-32k"

# Using environment variables directly in the script:
# CV_DOC_PROCESSOR_PATH_VALUE should be like "projects/PROJECT_ID/locations/us/processors/PROCESSOR_ID"
# CV_VERTEX_MODEL_VALUE should be like "text-bison-32k" or the full model path

# Prefer using values from environment variables if set, otherwise prompt or use defaults
DEFAULT_DOC_PROCESSOR_PATH="projects/${PROJECT_ID}/locations/us/processors/your-processor-id-here" # Replace with actual default or prompt
DEFAULT_VERTEX_MODEL="text-bison-32k" # Or your specific model

CV_DOC_PROCESSOR_PATH_TO_SET="${CV_DOC_PROCESSOR_PATH:-$DEFAULT_DOC_PROCESSOR_PATH}"
CV_VERTEX_MODEL_TO_SET="${CV_VERTEX_MODEL:-$DEFAULT_VERTEX_MODEL}"


if [ -z "$CV_DOC_PROCESSOR_PATH" ] || [ "$CV_DOC_PROCESSOR_PATH" == "$DEFAULT_DOC_PROCESSOR_PATH" ]; then
  echo "Warning: CV_DOC_PROCESSOR_PATH environment variable is not set or is default. Using default: $CV_DOC_PROCESSOR_PATH_TO_SET"
  echo "Ensure this is correct or set the CV_DOC_PROCESSOR_PATH environment variable."
fi
if [ -z "$CV_VERTEX_MODEL" ] || [ "$CV_VERTEX_MODEL" == "$DEFAULT_VERTEX_MODEL" ]; then
  echo "Warning: CV_VERTEX_MODEL environment variable is not set or is default. Using default: $CV_VERTEX_MODEL_TO_SET"
   echo "Ensure this is correct or set the CV_VERTEX_MODEL environment variable."
fi

echo "Setting functions config: cv.doc_processor_path=${CV_DOC_PROCESSOR_PATH_TO_SET}"
echo "Setting functions config: cv.vertex_model=${CV_VERTEX_MODEL_TO_SET}"
echo "Setting functions config: cv.project_id=${PROJECT_ID}"

firebase functions:config:set \
     cv.doc_processor_path="${CV_DOC_PROCESSOR_PATH_TO_SET}" \
     cv.vertex_model="${CV_VERTEX_MODEL_TO_SET}" \
     cv.project_id="${PROJECT_ID}" --project "$PROJECT_ID"

echo "--- Functions configuration set. ---"
echo ""
echo "You can now deploy the function and storage rules:"
echo "firebase deploy --only functions,storage --project $PROJECT_ID"

# Note: Make this script executable with `chmod +x functions/deploy.sh`
# Run it with `./functions/deploy.sh`
# It's safe to run this script multiple times (IAM bindings are idempotent).
# Ensure PROJECT_ID environment variable is set or gcloud is configured.
# Optionally set CV_DOC_PROCESSOR_PATH and CV_VERTEX_MODEL for config setting.
