#!/usr/bin/env bash
# generate-upload-keystore.sh — create a new upload keystore (JKS), export its cert, and print SHA-256
# Usage: ./generate-upload-keystore.sh [aab-key.jks] [alias] ["CN=Elara Upload,O=Interchained,L=,ST=,C=US"]
set -euo pipefail
KEYSTORE="${1:-aab-key.jks}"
ALIAS="${2:-elara}"
DNAME="${3:-CN=Elara Upload,O=Interchained,L=,ST=,C=US}"

echo ">>> Generating keystore: $KEYSTORE (alias: $ALIAS)"
keytool -genkeypair -v -storetype JKS -keystore "$KEYSTORE" -alias "$ALIAS"   -keyalg RSA -keysize 4096 -validity 9125 -sigalg SHA256withRSA -dname "$DNAME"

echo ">>> Exporting upload key certificate to upload-key-cert.pem"
keytool -exportcert -rfc -keystore "$KEYSTORE" -alias "$ALIAS" -file upload-key-cert.pem

echo ">>> Keystore fingerprint (compare to Play Console Upload key certificate SHA-256):"
keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" | awk -F': ' '/SHA-256/{print $2; exit}'
echo "Done."

