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
# For v2 event-driven functions (like Storage), it's usually PROJECT_NUMBER-compute@developer.gserviceaccount.com
# but granting to the default SA often works or simplifies setup. Double-check in IAM if needed.
FUNCTIONS_SERVICE_ACCOUNT="${PROJECT_ID}@appspot.gserviceaccount.com"

# Get Project Number (needed for some default service accounts if used)
# PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
# EVENT_DRIVEN_FUNCTIONS_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" # Example if needed


# --- End Configuration ---

echo "--- Granting IAM Roles ---"
echo "Project ID: ${PROJECT_ID}"
echo "Functions Service Account: ${FUNCTIONS_SERVICE_ACCOUNT}"
echo "--------------------------"


# Grant roles required by parseResumePdf function to the default service account
echo "Granting roles/documentai.apiUser..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/documentai.apiUser" \
  --condition=None # Explicitly set no condition for clarity

echo "Granting roles/aiplatform.user..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/aiplatform.user" \
  --condition=None

echo "Granting roles/datastore.user (for Firestore)..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/datastore.user" # This role grants Firestore read/write access
  --condition=None

# Grant Storage Admin role to allow the function to read from the bucket
# (Object Viewer might be sufficient, but Admin is safer for potential future needs like metadata changes)
echo "Granting roles/storage.objectAdmin..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin"
  --condition=None


# --- Optional Roles (Uncomment if needed) ---
# Grant Cloud Storage Object Viewer (if function needs to read other files)
# echo "Granting roles/storage.objectViewer..."
# gcloud projects add-iam-policy-binding $PROJECT_ID \
#   --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
#   --role="roles/storage.objectViewer" \
#   --condition=None

# Grant Pub/Sub Publisher (if function needs to publish messages)
# echo "Granting roles/pubsub.publisher..."
# gcloud projects add-iam-policy-binding $PROJECT_ID \
#   --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
#   --role="roles/pubsub.publisher" \
#   --condition=None
# --- End Optional Roles ---


echo "--- IAM roles granted successfully. ---"
echo ""
echo "--- Set Functions Configuration ---"
echo "Setting configuration variables..."
firebase functions:config:set \
     cv.doc_processor_path="projects/${PROJECT_ID}/locations/us/processors/96d0b7dd6d2ee817" \
     cv.vertex_model="text-bison-32k" \
     cv.project_id="${PROJECT_ID}"
     # Note: Vertex model path is simplified to just the model ID if using standard publisher

# Example using full path if needed:
# firebase functions:config:set \
#      cv.doc_processor_path="projects/${PROJECT_ID}/locations/us/processors/96d0b7dd6d2ee817" \
#      cv.vertex_model="projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/text-bison-32k" \
#      cv.project_id="${PROJECT_ID}"


echo "--- Configuration set. ---"
echo ""
echo "You can now deploy the function and storage rules:"
echo "firebase deploy --only functions,storage" # Deploy all functions and storage

# Or deploy specific functions:
# echo "firebase deploy --only functions:parseResumePdf,functions:suggestSummary,functions:suggestSkills,storage"

# Note: Make this script executable with `chmod +x functions/deploy.sh`
# Run it with `./functions/deploy.sh`
# It's safe to run this script multiple times (idempotent).
