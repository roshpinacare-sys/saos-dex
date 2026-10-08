#!/usr/bin/env bash
# EXEC-CD-43 — מתקין-את-שער-ה-push-המקומי (idempotent, אפס-דריסה-מחוץ-לhooks-שלנו)
set -euo pipefail
cd "$(dirname "$0")/.."
HOOK=".git/hooks/pre-push"
if [ -f "$HOOK" ] && ! grep -q "pre-push-gate.sh" "$HOOK" 2>/dev/null; then
  echo "✖ קיים-pre-push-hook-אחר — לא דורך. מיזוג-ידני-נדרש."; exit 1
fi
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# EXEC-CD-43 local gate — delegates to tracked script (survives re-clone via installer)
exec bash "$(git rev-parse --show-toplevel)/scripts/pre-push-gate.sh"
EOF
chmod +x "$HOOK" scripts/pre-push-gate.sh
echo "✓ pre-push gate installed → scripts/pre-push-gate.sh (typecheck+BMC על-קוד · [state]-זורם)"
