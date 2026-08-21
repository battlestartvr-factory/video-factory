#!/usr/bin/env bash
# Validate that production owner OAuth can actually refresh and read the configured
# Google Drive archive root. Never prints OAuth responses or tokens.

set -euo pipefail

fail() {
  printf '[drive-oauth] ERROR: %s\n' "$*" >&2
  exit 1
}

ok() {
  printf '[drive-oauth] OK: %s\n' "$*"
}

command -v curl >/dev/null 2>&1 || fail "curl is required"

: "${GOOGLE_DRIVE_CLIENT_ID:?GOOGLE_DRIVE_CLIENT_ID is required}"
: "${GOOGLE_DRIVE_CLIENT_SECRET:?GOOGLE_DRIVE_CLIENT_SECRET is required}"
: "${GOOGLE_DRIVE_REFRESH_TOKEN:?GOOGLE_DRIVE_REFRESH_TOKEN is required}"
: "${GOOGLE_DRIVE_SHARED_FOLDER_ID:?GOOGLE_DRIVE_SHARED_FOLDER_ID is required}"

token_body="$(mktemp)"
drive_body="$(mktemp)"
cleanup() {
  rm -f "$token_body" "$drive_body"
}
trap cleanup EXIT
chmod 600 "$token_body" "$drive_body"

token_status="$(curl -sS --max-time 20 \
  -o "$token_body" \
  -w '%{http_code}' \
  -X POST 'https://oauth2.googleapis.com/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "client_id=${GOOGLE_DRIVE_CLIENT_ID}" \
  --data-urlencode "client_secret=${GOOGLE_DRIVE_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${GOOGLE_DRIVE_REFRESH_TOKEN}" \
  --data-urlencode 'grant_type=refresh_token' \
  || true)"

[[ "$token_status" == "200" ]] || fail "owner OAuth refresh failed (HTTP ${token_status:-transport_error}); reconnect Google Drive owner credentials before production deploy"

token_compact="$(tr -d '\r\n' < "$token_body")"
access_token="$(printf '%s' "$token_compact" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[[ -n "$access_token" ]] || fail "owner OAuth refresh response did not contain an access token"
ok "owner OAuth refresh token is valid"

drive_status="$(curl -sS --max-time 20 \
  -o "$drive_body" \
  -w '%{http_code}' \
  -G "https://www.googleapis.com/drive/v3/files/${GOOGLE_DRIVE_SHARED_FOLDER_ID}" \
  -H "Authorization: Bearer ${access_token}" \
  --data-urlencode 'fields=id,name,mimeType' \
  --data-urlencode 'supportsAllDrives=true' \
  || true)"

# Do not retain the short-lived token longer than necessary.
access_token=''
token_compact=''
: > "$token_body"

[[ "$drive_status" == "200" ]] || fail "Drive archive root is not readable with owner OAuth (HTTP ${drive_status:-transport_error})"

folder_compact="$(tr -d '\r\n' < "$drive_body")"
if ! printf '%s' "$folder_compact" | grep -Fq '"id"'; then
  fail "Drive API returned an unexpected archive-root response"
fi
ok "configured Drive archive root is readable"
