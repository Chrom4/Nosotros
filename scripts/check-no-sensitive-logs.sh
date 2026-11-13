#!/usr/bin/env bash
set -euo pipefail

echo "==> Auditing codebase for forbidden patterns and sensitive logs..."

# 1. Raw console statements in src/ (all levels — use src/utils/logger.ts instead).
#    The logger sink itself is the only allowed console usage.
RAW_CONSOLE_HITS=$(grep -rnE "console\.(log|info|debug|dir|warn|error)|console\[" src/ 2>/dev/null | grep -v "src/utils/logger.ts" || true)
if [ -n "$RAW_CONSOLE_HITS" ]; then
  echo "❌ ERROR: Found raw console statements in src/:"
  echo "$RAW_CONSOLE_HITS"
  exit 1
fi
echo "✅ No raw console statements found in src/ (logger sink excluded)."

# 2. Forbidden dependencies per AGENTS.md Constitution
FORBIDDEN_DEPS=$(grep -E "googleapis|@powersync|react-native-skia" package.json yarn.lock 2>/dev/null || true)
if [ -n "$FORBIDDEN_DEPS" ]; then
  echo "❌ ERROR: Found forbidden dependencies in package.json/yarn.lock:"
  echo "$FORBIDDEN_DEPS"
  exit 1
fi
echo "✅ No forbidden dependencies (googleapis, powersync, skia) found in package.json or yarn.lock."

# 3. service_role exposure in client code (excluding the security assertion in supabaseClient.ts)
SERVICE_ROLE_HITS=$(grep -rn "service_role" src/ 2>/dev/null | grep -vE "supabaseClient.ts|utils/logger.ts" || true)
if [ -n "$SERVICE_ROLE_HITS" ]; then
  echo "❌ ERROR: Found reference to service_role in client src/:"
  echo "$SERVICE_ROLE_HITS"
  exit 1
fi
echo "✅ No service_role exposure in src/ (security guard verified in supabaseClient.ts)."

# 4. Logger calls that still pass obvious sensitive payload keys as object literals
#    (defense-in-depth; sanitizeContext also redacts at runtime)
SENSITIVE_LOGGER_HITS=$(grep -rnE "logger\.(debug|info|warn|error)\([^)]*\{[^}]*(access_token|refresh_token|passphrase|amount_cents|service_role|authorization)[^}]*\}" src/ 2>/dev/null || true)
if [ -n "$SENSITIVE_LOGGER_HITS" ]; then
  echo "❌ ERROR: Found logger calls with sensitive payload keys:"
  echo "$SENSITIVE_LOGGER_HITS"
  exit 1
fi
echo "✅ No obvious sensitive keys in logger call sites."

echo "==> Hardening audit passed successfully!"
