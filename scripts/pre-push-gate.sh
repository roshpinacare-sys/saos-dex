#!/usr/bin/env bash
# EXEC-CD-43 · LOCAL PUSH GATE — הבלם-האמת-על-קוד (hosted-CI מת-על-מכסת-דקות — מתועד).
# אפס-דריסה: [state]-קומיטים (קדנס-ה-snapshot של dex-state-push) זורמים-תמיד —
# הם-נתוני-מצב-חי, לא-קוד. כל-קומיט-קוד → typecheck + BMC-גרעין חייבים-לעבור.
# התקנה: bash scripts/install-pre-push-gate.sh   (נקרא-ע"י .git/hooks/pre-push)
set -u
cd "$(dirname "$0")/.."

# קריאת-קלט-ה-pre-push (local_ref local_sha remote_ref remote_sha) — שוקל-רק-main
gate_needed=false
while read -r lref lsha rref rsha; do
  [ "${rref#refs/heads/main}" = "$rref" ] && continue
  if [ "$rsha" = "0000000000000000000000000000000000000000" ]; then
    range="$lsha"
  else
    range="$rsha..$lsha"
  fi
  # אם-קיים-אפילו-קומיט-קוד-אחד (שאינו [state]) — השער-דורש-בדיקות
  if git log --format=%s "$range" 2>/dev/null | grep -qv '^\[state\]'; then
    gate_needed=true
  fi
done

if [ "$gate_needed" = "true" ]; then
  echo "[pre-push-gate] קומיט-קוד זוהה — מריץ typecheck + BMC (EXEC-CD-43)..."
  bun run typecheck || { echo "[pre-push-gate] ✖ typecheck נכשל — דחיפה-נבלמה (fail-closed)"; exit 1; }
  bun harness/bmc.ts >/dev/null 2>&1 || { echo "[pre-push-gate] ✖ BMC-אינווריאנטות נכשל — דחיפה-נבלמה"; exit 1; }
  echo "[pre-push-gate] ✓ typecheck+BMC ירוקים — הדחיפה ממשיכה"
else
  echo "[pre-push-gate] [state]-בלבד — זורם ללא-שער (נתוני-מצב-חי)"
fi
exit 0
