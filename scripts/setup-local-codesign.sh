#!/bin/sh
set -eu

SIGN_DIR="$HOME/Library/Application Support/Webot/codesign"
KEYCHAIN="$SIGN_DIR/webot-build.keychain-db"
PASSWORD_FILE="$SIGN_DIR/webot-build.keychain-password"
CERTIFICATE="$SIGN_DIR/Webot Local Development.crt"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/webot-codesign.XXXXXX")"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$SIGN_DIR"
chmod 700 "$SIGN_DIR"

if security find-identity -v -p codesigning 2>/dev/null \
  | grep -Fq '"Webot Local Development"'; then
  printf 'Webot local development signing identity is already available\n'
  exit 0
fi

if [ -f "$PASSWORD_FILE" ] && \
  security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null \
  | grep -Fq '"Webot Local Development"'; then
  security unlock-keychain -p "$(cat "$PASSWORD_FILE")" "$KEYCHAIN"
  printf 'Webot local development signing keychain is ready: %s\n' "$KEYCHAIN"
  exit 0
fi

rm -f "$KEYCHAIN"
openssl rand -hex 24 >"$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"
PASSWORD="$(cat "$PASSWORD_FILE")"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TEMP_DIR/private-key.pem" \
  -out "$TEMP_DIR/certificate.pem" \
  -subj "/CN=Webot Local Development/O=Webot Local Development" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" >/dev/null 2>&1
openssl pkcs12 -export \
  -legacy \
  -inkey "$TEMP_DIR/private-key.pem" \
  -in "$TEMP_DIR/certificate.pem" \
  -out "$TEMP_DIR/identity.p12" \
  -passout "pass:$PASSWORD"

security create-keychain -p "$PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
security import "$TEMP_DIR/identity.p12" \
  -k "$KEYCHAIN" \
  -P "$PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security >/dev/null
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$PASSWORD" \
  "$KEYCHAIN" >/dev/null
security add-trusted-cert \
  -r trustRoot \
  -k "$KEYCHAIN" \
  "$TEMP_DIR/certificate.pem"
cp "$TEMP_DIR/certificate.pem" "$CERTIFICATE"
chmod 600 "$KEYCHAIN"
chmod 644 "$CERTIFICATE"

security find-identity -v -p codesigning "$KEYCHAIN" \
  | grep -F '"Webot Local Development"'
printf 'Webot local development signing keychain created: %s\n' "$KEYCHAIN"
