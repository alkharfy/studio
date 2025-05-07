#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
# Replace with your actual Project ID if needed (often inferred by gcloud)
PROJECT_ID=$(gcloud config get-value project)
if [ -z "$PROJECT_ID" ]; then
  echo "Error: Could not determine Project ID. Set it using 'gcloud config set project YOUR_PROJECT_ID'"
  exit 1
fi

# Default Functions service account (used by v1 and v2 HTTP/Callable)
# For v2 event-driven functions, this is the RUNTIME service account.
FUNCTIONS_SERVICE_ACCOUNT="${PROJECT_ID}@appspot.gserviceaccount.com"

# Get Project Number (needed for some default service accounts like Eventarc's own SA)
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
# EVENTARC_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com" # Eventarc's own service agent

# --- End Configuration ---

echo "--- Granting IAM Roles ---"
echo "Project ID: ${PROJECT_ID}"
echo "Functions Runtime Service Account: ${FUNCTIONS_SERVICE_ACCOUNT}"
# echo "Eventarc Service Agent: ${EVENTARC_SERVICE_AGENT}" # For reference
echo "--------------------------"


# Grant roles required by parseResumePdf function to the function's runtime service account
echo "Granting roles/documentai.apiUser..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/documentai.apiUser" \
  --condition=None

echo "Granting roles/aiplatform.user..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/aiplatform.user" \
  --condition=None

echo "Granting roles/datastore.user (for Firestore)..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/datastore.user" \
  --condition=None

echo "Granting roles/storage.objectAdmin..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin" \
  --condition=None

# Roles for Eventarc to invoke the Cloud Run service (v2 Function)
# The function's runtime service account needs to be invokable.
echo "Granting roles/run.invoker to ${FUNCTIONS_SERVICE_ACCOUNT} (allows Eventarc to invoke the function)..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/run.invoker" \
  --condition=None

# The function's runtime service account also needs to be able to receive events via Eventarc.
echo "Granting roles/eventarc.eventReceiver to ${FUNCTIONS_SERVICE_ACCOUNT} (allows function to receive Eventarc events)..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/eventarc.eventReceiver" \
  --condition=None

# Optional: The Eventarc Service Agent (service-<PROJECT_NUMBER>@gcp-sa-eventarc.iam.gserviceaccount.com)
# might need "Service Account Token Creator" role on the function's identity if it's not the default compute SA.
# However, granting run.invoker and eventarc.eventReceiver to the function's SA is often sufficient.

echo "--- IAM roles granted successfully. ---"
echo ""
echo "--- Set Functions Configuration ---"
echo "Setting configuration variables..."
# Ensure these environment variables are set in your shell or CI/CD environment
# Or replace with direct values if not using env vars for path/model.
# CV_DOC_PROCESSOR_PATH="projects/${PROJECT_ID}/locations/us/processors/your-processor-id"
# CV_VERTEX_MODEL="your-vertex-model-name" # e.g., text-bison@001 or text-bison-32k

# Make sure CV_DOC_PROCESSOR_PATH and CV_VERTEX_MODEL are set as environment variables
# when running this script, or replace the variables below with actual string values.
# Example: export CV_DOC_PROCESSOR_PATH="projects/your-gcp-project-id/locations/us/processors/your-processor-id"
# Example: export CV_VERTEX_MODEL="text-bison-32k"

if [ -z "$CV_DOC_PROCESSOR_PATH" ] || [ -z "$CV_VERTEX_MODEL" ]; then
  echo "Warning: CV_DOC_PROCESSOR_PATH or CV_VERTEX_MODEL environment variables are not set."
  echo "Skipping functions:config:set for these variables. Ensure they are set directly in Firebase console or via other means if needed."
else
  firebase functions:config:set \
       cv.doc_processor_path="${CV_DOC_PROCESSOR_PATH}" \
       cv.vertex_model="${CV_VERTEX_MODEL}" \
       cv.project_id="${PROJECT_ID}"
  echo "--- Configuration set for cv.doc_processor_path and cv.vertex_model. ---"
fi
# Also set gcp.project_id if your functions need it explicitly from config
firebase functions:config:set cv.project_id="${PROJECT_ID}"
echo "--- Configuration set for cv.project_id. ---"
echo ""
echo "You can now deploy the function and storage rules:"
echo "firebase deploy --only functions,storage"

# Note: Make this script executable with `chmod +x functions/deploy.sh`
# Run it with `./functions/deploy.sh`
# It's safe to run this script multiple times (idempotent).
# Ensure PROJECT_ID (and optionally CV_DOC_PROCESSOR_PATH, CV_VERTEX_MODEL for config setting)
# environment variables are set before running.
# Example: export PROJECT_ID="your-gcp-project-id"
# Example: export CV_DOC_PROCESSOR_PATH="projects/your-gcp-project-id/locations/us/processors/your-processor-id"
# Example: export CV_VERTEX_MODEL="text-bison-32k"
