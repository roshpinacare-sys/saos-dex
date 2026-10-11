// DELEGATE-PLAN — האצלת SP מדודה ואידמפוטנטית (owner-mandated 2026-10-11)
// =============================================================================
// המטרה (owner directives, IM trace 1a12af43fc4d7489: "אני רוצה להאציל SP לכלל
// החשבונות כדי לחלק את כוח העבודה וההצבעה ופוסטים בצורה נכונה" + אישור-ביצוע
// 1a12b258c9776305: "יש לך אישור להכל"): הצבת כוח-העבודה של הצי — האצלות
// אבסולוטיות מתוכננות (grids/state/delegation-plan.json), נמדדות מול השרשרת,
// דלתא-בלבד (יעד-שהושג = אפס-אופים — אידמפוטנטי לחלוטין, בטוח לריצה-כפולה
// בין-הבית-המקורי לתאום).
//
// בטיחות (כל-השכבות חייבות לעמוד; כל-כשל = יציאה-כנה בלי-נגיעה):
//   1. STASIS: stasisHalt("delegator") — מסילת delegations חייבת להיות פתוחה
//      (mode=staged + stagedLanes.allow, או full-lift active=false).
//   2. תוכנית-חתומה בלבד: הסקריפט לא ממציא כתובות או סכומים — רק מה שבקובץ
//      התוכנית (פרוטוקול SAOS-DELEGATION-PLAN/1; קובץ-זר = fail-closed).
//   3. מפתח-מאומת-מול-שרשרת: STEEM_ACTIVE_WIF חייב לגזור בדיוק את רשות-ה-active
//      החיה של ACCOUNT (אותו-משטר של community.mjs) — רק לפני-שידור-אמת.
//   4. קריאה-לפני-כתיבה: ההאצלות החיות נמדדות לפני כל שידור; דלתא בלבד.
//   5. קריאה-אחרי-כתיבה: אחרי כל שידור — ההאצלה נמדדת שוב וחייבת להתאים;
//      אי-התאמה = כישלון-כנה בקבלה (fail-closed, אין-המשך-עיוור).
//
// שימוש: node grids/delegate-plan.mjs [--execute] [--plan path]
//   ברירת-מחדל: dry-run (מדפיס את הדלתא המתוכננת מול המצב-החי; לא נוגע בכלום).

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCOUNT, rpcAny, signAndBroadcast, privToPub, wifToPriv, num } from "./mover.mjs";
import { stasisHalt } from "./brake.mjs";
import { appendEvent } from "./events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const execute = process.argv.includes("--execute");
const planIdx = process.argv.indexOf("--plan");
const planPath = planIdx >= 0 ? process.argv[planIdx + 1] : join(HERE, "state", "delegation-plan.json");
const VESTS_EPS = 0.000001;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1) שער-STASIS — מסילת delegations (fail-closed; סגירה = יציאה-כנה 0, לא כישלון) */
if (stasisHalt("delegator")) {
  console.log("delegate-plan: מסילת delegations סגורה (STASIS/lane-guards) — לא נגעתי בכלום (כנות, לא כישלון)");
  process.exit(0);
}

/* 2) התוכנית — רק מה שחתום בקובץ */
let plan;
try {
  plan = JSON.parse(readFileSync(planPath, "utf8"));
} catch (e) {
  console.error(`delegate-plan: קובץ-תוכנית לא קריא (${planPath}) — fail-closed: ${String(e?.message ?? e).slice(0, 120)}`);
  process.exit(2);
}
if (plan.protocol !== "SAOS-DELEGATION-PLAN/1") {
  console.error(`delegate-plan: פרוטוקול-תוכנית זר '${plan.protocol}' — fail-closed`);
  process.exit(2);
}
const targets = (plan.targets ?? []).filter((t) => t && typeof t.account === "string" && Number(t.vests) > 0);
if (targets.length === 0) { console.error("delegate-plan: אין יעדים בתוכנית — fail-closed"); process.exit(2); }

/* 3) המצב-החי — ההאצלות הקיימות של ACCOUNT (קריאה-לפני-כתיבה) */
const existing = await rpcAny("condenser_api.get_vesting_delegations", [ACCOUNT, "", "1000"]).catch(() => null);
if (!Array.isArray(existing)) { console.error("delegate-plan: קריאת-ההאצלות-החיות נכשלה — fail-closed"); process.exit(1); }
const cur = new Map(existing.map((d) => [d.delegatee, num(d.vesting_shares)]));

/* 4) הדלתא — רק חשבונות שסוטים מהיעד */
const ops = [];
for (const t of targets) {
  const target = Number(t.vests);
  const now = cur.get(t.account) ?? 0;
  if (Math.abs(now - target) < VESTS_EPS) {
    console.log(`delegate-plan: ${t.account} כבר ביעד (${target.toFixed(6)} VESTS) — מדלג`);
    continue;
  }
  console.log(`delegate-plan: ${t.account} — חי=${now.toFixed(6)} → יעד=${target.toFixed(6)} VESTS (${t.role ?? "?"})`);
  ops.push(["delegate_vesting_shares", { delegator: ACCOUNT, delegatee: t.account, vesting_shares: `${target.toFixed(6)} VESTS` }]);
}
console.log(`delegate-plan: דלתא = ${ops.length} האצלות מתוך ${targets.length} יעדים`);

if (!execute) {
  console.log("delegate-plan: dry-run — לא שודר כלום (הוסף --execute לשידור-אמת)");
  process.exit(0);
}
if (ops.length === 0) { console.log("delegate-plan: הצי כולו ביעד — אין מה לשדר"); process.exit(0); }

/* 5) מפתח-מאומת-מול-הרשות-החיה (רק עכשיו — לפני-שידור-אמת) */
const head = await rpcAny("condenser_api.get_accounts", [[ACCOUNT]]).catch(() => null);
const liveActive = head?.[0]?.active?.key_auths?.[0]?.[0];
if (!liveActive) { console.error("delegate-plan: לא נקראה רשות-active חיה של החשבון — fail-closed"); process.exit(1); }
const wif = process.env.STEEM_ACTIVE_WIF || "";
let keyOk = false;
try { keyOk = !!wif && privToPub(wifToPriv(wif)) === liveActive; } catch { keyOk = false; }
if (!keyOk) {
  console.error("delegate-plan: STEEM_ACTIVE_WIF חסר או שאינו גוזר את רשות-ה-active החיה — מסרב לחתום (fail-closed)");
  process.exit(1);
}

/* 6) שידור בקבוצות עד-4 + קריאה-אחרי-כתיבה פר-האצלה */
const receipt = { at: new Date().toISOString(), account: ACCOUNT, mode: "delegations", plan: plan.sealedAt, txids: [], applied: [], failed: [] };
let hardFail = false;
for (let i = 0; i < ops.length; i += 4) {
  const batch = ops.slice(i, i + 4);
  try {
    const r = await signAndBroadcast(wif, batch);
    receipt.txids.push({ txid: r.txid, block: r.block, ops: batch.map((b) => b[1].delegatee) });
    console.log(`delegate-plan: שודר txid=${r.txid} block=${r.block} (${batch.map((b) => b[1].delegatee).join(", ")})`);
    for (const [, body] of batch) {
      await sleep(2000);
      const after = await rpcAny("condenser_api.get_vesting_delegations", [ACCOUNT, body.delegatee, "1"]).catch(() => null);
      const hit = Array.isArray(after) ? after.find((d) => d.delegatee === body.delegatee) : null;
      const got = hit ? num(hit.vesting_shares) : null;
      const want = Number(body[1].vesting_shares.replace(/[A-Za-z ]+/g, ""));
      if (got !== null && Math.abs(got - want) < VESTS_EPS) {
        receipt.applied.push({ delegatee: body.delegatee, vests: body[1].vesting_shares });
        console.log(`delegate-plan: אומת בשרשרת — ${body[1].delegatee} = ${body[1].vesting_shares}`);
      } else {
        receipt.failed.push({ delegatee: body[1].delegatee, reason: `read-back mismatch (got ${got})` });
        console.error(`delegate-plan: קריאה-אחרי-כתיבה לא מאשרת עבור ${body[1].delegatee} (got ${got}) — רשום בקבלה`);
      }
    }
  } catch (e) {
    receipt.failed.push({ batch: batch.map((b) => b[1].delegatee), reason: String(e?.message ?? e).slice(0, 200) });
    console.error(`delegate-plan: שידור-קבוצה נכשל — ${String(e?.message ?? e).slice(0, 200)}; עצירה fail-closed`);
    hardFail = true;
    break;
  }
}

/* 7) קבלה — רישום-מקומי בלבד (אפס סודות, אפס חומרת-מפתח) */
try {
  appendFileSync(join(HERE, "state", "delegation-receipt.jsonl"), JSON.stringify(receipt) + "\n");
  appendEvent(join(HERE, "state", "events.jsonl"), { kind: "delegations", at: receipt.at, account: ACCOUNT, applied: receipt.applied.length, failed: receipt.failed.length, txids: receipt.txids.map((t) => t.txid), sim: false });
} catch { /* כשל-קבלה לא מפיל את התוצאה החיה */ }

console.log(`delegate-plan: הסתיים — applied=${receipt.applied.length} failed=${receipt.failed.length} txids=${receipt.txids.length}`);
process.exit(hardFail || receipt.failed.length > 0 ? 1 : 0);
