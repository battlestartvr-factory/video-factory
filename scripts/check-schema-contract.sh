#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_FILE="$ROOT_DIR/supabase/schema-contract.txt"
MIGRATIONS_DIR="$ROOT_DIR/supabase/migrations"

fail() {
  printf '[schema-contract] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f "$CONTRACT_FILE" ]] || fail "missing $CONTRACT_FILE"
[[ -d "$MIGRATIONS_DIR" ]] || fail "missing $MIGRATIONS_DIR"

expected="$(tr -d '\r\n[:space:]' < "$CONTRACT_FILE")"
[[ "$expected" =~ ^[0-9]{14}$ ]] || fail "schema contract must be a 14-digit migration version"

latest_file="$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort | tail -n 1)"
[[ -n "$latest_file" ]] || fail "no migration files found"
latest_version="${latest_file%%_*}"

[[ "$latest_version" == "$expected" ]] || fail "schema contract $expected does not match latest migration $latest_version ($latest_file)"

latest_path="$MIGRATIONS_DIR/$latest_file"
grep -Fq 'deployment_schema_contract' "$latest_path" || fail "latest migration must advance deployment_schema_contract"
grep -Fq "$expected" "$latest_path" || fail "latest migration must write schema contract version $expected"

printf '[schema-contract] OK: expected schema %s (%s)\n' "$expected" "$latest_file"
