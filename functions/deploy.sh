#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
# Replace with your actual Project ID
PROJECT_ID="arabic-cv-architect"
# Replace with the service account email for your Cloud Functions
# Default format: <PROJECT_ID>@appspot.gserviceaccount.com
# Or find it in the Google Cloud Console -> IAM & Admin -> Service Accounts
# Or find it in the Cloud Function details page in the Console
FUNCTIONS_SERVICE_ACCOUNT="${PROJECT_ID}@appspot.gserviceaccount.com"
# --- End Configuration ---

echo "Granting IAM roles to service account: ${FUNCTIONS_SERVICE_ACCOUNT} in project: ${PROJECT_ID}"

# Grant Document AI User role
echo "Granting roles/documentai.apiUser..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/documentai.apiUser" \
  --condition=None # Explicitly set no condition for clarity

# Grant Vertex AI User role
echo "Granting roles/aiplatform.user..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/aiplatform.user" \
  --condition=None

# Grant Firestore User role (for writing data)
echo "Granting roles/datastore.user..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${FUNCTIONS_SERVICE_ACCOUNT}" \
  --role="roles/datastore.user" # This role grants Firestore read/write access
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


echo "IAM roles granted successfully."
echo "You can now deploy your function using: firebase deploy --only functions:parseResumePdf,storage"

# Note: Make this script executable with `chmod +x functions/deploy.sh`
# Run it with `./functions/deploy.sh`
