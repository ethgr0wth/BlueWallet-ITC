#!/usr/bin/env bash
#
# sign-aab.sh — Sign an Android App Bundle (.aab) with your upload keystore
# Usage:
#   ./sign-aab.sh /path/to/keystore.jks <alias> <keystore_password> <key_password> [aab_path]
#
# If aab_path is not provided, defaults to:
#   app/build/outputs/bundle/release/app-release.aab

set -euo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "Usage: $0 <keystore> <alias> <keystore_password> <key_password> [aab_path]"
  exit 1
fi

KEYSTORE="$1"
ALIAS="$2"
KEYSTORE_PASS="$3"
KEY_PASS="$4"
AAB_IN="${5:-app/build/outputs/bundle/release/app-release.aab}"

# Locate jarsigner
JARSIGNER_BIN="${JARSIGNER:-$(command -v jarsigner || true)}"
if [ -z "$JARSIGNER_BIN" ]; then
  echo "Error: jarsigner not found. Ensure JDK is installed and jarsigner is on PATH."
  exit 1
fi

if [ ! -f "$KEYSTORE" ]; then
  echo "Error: Keystore not found at '$KEYSTORE'"
  exit 1
fi

if [ ! -f "$AAB_IN" ]; then
  echo "Error: .aab not found at '$AAB_IN'. Build the bundle first (./gradlew bundleRelease)."
  exit 1
fi

echo "Signing AAB:"
echo "  AAB:       $AAB_IN"
echo "  Keystore:  $KEYSTORE"
echo "  Alias:     $ALIAS"

# jarsigner signs the AAB in place
"$JARSIGNER_BIN" -verbose \
  -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore "$KEYSTORE" \
  -storepass "$KEYSTORE_PASS" \
  -keypass "$KEY_PASS" \
  "$AAB_IN" "$ALIAS"

echo "Verifying signature..."
"$JARSIGNER_BIN" -verify -verbose -certs "$AAB_IN"

echo "✅ Signed AAB ready: $AAB_IN"
echo "Upload this file to the Play Console (ensure versionCode is higher than the last upload)."
