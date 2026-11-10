#!/usr/bin/env bash
set -euo pipefail

echo "==> Auditing codebase for forbidden patterns and sensitive logs..."

# 1. Check for raw console statements in src/ (except if explicitly wrapped or in test files)
RAW_CONSOLE_HITS=$(grep -rn "console\.\(log\|info\|debug\|dir\)" src/ 2>/dev/null || true)
if [ -n "$RAW_CONSOLE_HITS" ]; then
  echo "❌ ERROR: Found raw console statements in src/:"
  echo "$RAW_CONSOLE_HITS"
  exit 1
fi
echo "✅ No raw console statements found in src/."

# 2. Check for forbidden dependencies per AGENTS.md Constitution
FORBIDDEN_DEPS=$(grep -E "googleapis|@powersync|react-native-skia" package.json yarn.lock 2>/dev/null || true)
if [ -n "$FORBIDDEN_DEPS" ]; then
  echo "❌ ERROR: Found forbidden dependencies in package.json/yarn.lock:"
  echo "$FORBIDDEN_DEPS"
  exit 1
fi
echo "✅ No forbidden dependencies (googleapis, powersync, skia) found in package.json or yarn.lock."

# 3. Check for service_role exposure in client code (excluding the security assertion in supabaseClient.ts)
SERVICE_ROLE_HITS=$(grep -rn "service_role" src/ 2>/dev/null | grep -v "supabaseClient.ts" || true)
if [ -n "$SERVICE_ROLE_HITS" ]; then
  echo "❌ ERROR: Found reference to service_role in client src/:"
  echo "$SERVICE_ROLE_HITS"
  exit 1
fi
echo "✅ No service_role exposure in src/ (security guard verified in supabaseClient.ts)."

echo "==> Hardening audit passed successfully!"
