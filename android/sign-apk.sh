#!/usr/bin/env bash

# sign-apk.sh - Sign the unsigned APK with your keystore
# Usage: ./sign-apk.sh /path/to/keystore.jks alias keystore_password key_password

set -e

if [ "$#" -ne 4 ]; then
  echo "Usage: $0 <keystore> <alias> <keystore_password> <key_password>"
  exit 1
fi

KEYSTORE=$1
ALIAS=$2
KEYSTORE_PASS=$3
KEY_PASS=$4

ANDROID_BUILD_TOOLS="$ANDROID_HOME/build-tools/34.0.0"
APK_UNSIGNED="app/build/outputs/apk/release/app-release-unsigned.apk"
APK_SIGNED="app/build/outputs/apk/release/app-release-signed.apk"

if [ ! -f "$APK_UNSIGNED" ]; then
  echo "Unsigned APK not found at $APK_UNSIGNED. Build the APK first."
  exit 1
fi

if [ ! -x "$ANDROID_BUILD_TOOLS/apksigner" ]; then
  echo "apksigner not found in $ANDROID_BUILD_TOOLS. Check your ANDROID_HOME."
  exit 1
fi

$ANDROID_BUILD_TOOLS/apksigner sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$ALIAS" \
  --ks-pass pass:"$KEYSTORE_PASS" \
  --key-pass pass:"$KEY_PASS" \
  --out "$APK_SIGNED" \
  "$APK_UNSIGNED"

$ANDROID_BUILD_TOOLS/apksigner verify "$APK_SIGNED"
echo "Signed APK created at: $APK_SIGNED"
