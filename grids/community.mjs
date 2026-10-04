// COMMUNITY (D-024) — בית-הצי ב-Steem: קהילה ייעודית על-פי-הוראת-הבעלים המתועדת
// ═══════════════════════════════════════════════════════════════════════════════
// הוראת-הבעלים (trace 1a1056131d2dfc79 / מקור 1a105372b9264961):
//   "יש לנסות לפתוח לנו קהילה יעודית בסטים או אם יש גם ברשתות האחרות"
// המנדט נרשם ב-grids/state/community-mandate.json (קומיט = קבלה). בלי מנדט —
// אין יצירה (owner-gated מבני, לא רק נוהג).
//
// הדוקטרינה (זהה ל-D-023 convert · R10 mover):
//   · מתכנן טהור חסר-מפתחות (selftest אופליין) + מבצע שער-יחיד verify-then-sign
//   · שני מקורות-מפתח כמו convert: כספת-האב או STEEM_ACTIVE_WIF — רק התאמת
//     active מלאה מול הרשויות-החיות מתירה חתימה; אף-מפתח לא נכתב לדיסק/לוג/קבלה
//   · שני נתיבי-יצירה, שניהם ממומנים-עצמית:
//       (א) claimed — claim_accounts (דלק-RC בלבד, אפס-STEEM) ← create_claimed_account
//       (ב) fee — create_account עם account_creation_fee (3 STEEM) מהנזיל-שלנו
//   · אידמפוטנטי: אם הקהילה קיימת — CREATED כנה ואפס-פעולות
//   · מפתחות-הקהילה נולדים בזיכרון-הריצה בלבד; הרשויות מועברות מיד ל-headcorner
//     (account_auths ב-threshold 1) — אפס-מפתחות-יתום, כספת-קיימת בלבד
//   · read-back אחרי כל-אופ · fail-closed בכל-שלב · קבלה כנה גם על HOLD
//
// שימוש: node grids/community.mjs            → תוכנית-חיה מול השרשרת (חסר-מפתחות)
//        node grids/community.mjs --execute  → הביצוע (שער-החתימה היחיד)

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import { appendEvent } from "./events.mjs";
import {
  ACCOUNT, RC_MIN, num, rpcAny, signAndBroadcast,
  deriveActiveWif, privToPub, privToWif, wifToPriv,
} from "./mover.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "state");
const PLAN_PATH = join(STATE_DIR, "community-plan.json");
const MANDATE_PATH = join(STATE_DIR, "community-mandate.json");
const EVENTS_LOG = join(STATE_DIR, "events.jsonl");

export const COMMUNITY_POLICY = {
  NAME_DEFAULT: "hive-197711",
  TITLE_DEFAULT: "SAOS · רשת בונים ריבונית",
  ABOUT_DEFAULT: "בית-הצי הריבוני: עבודה ממודדת בגלוי — מדידה קודמת לטענה, קבלה או זה לא קרה, דוחות-כישלון שווים-כמו-דוחות-הצלחה.",
  NAME_RE: /^[a-z][a-z0-9-]{2,15}$/,
  FEE_BUFFER_STEEM: 0.1,   // רזרבת-דלק מעל עמלת-היצירה
  CLAIM_RC_FLOOR: 0.9,     // ניסיון-claim רק בדלק-RC ≥ 90% מהתקרה (התאוששות-בטוחה)
  NAME_SERVICE: "roshpinacare-sys", // בעלות-מוסרית — הקהילה בניהול headcorner והצי
};

/* ── מתכנן טהור — אפס IO, בדיקות-אופליין מלאות ──────────────────────────── */
export function planCommunity({
  name, title, about, mandate = null,
  liquidSteem = 0, accountFee = 3, pendingClaimed = 0,
  rcCurrent = 0, rcMax = 0, nameFree = true, alreadyExists = false,
  policy = COMMUNITY_POLICY, nowIso = null,
} = {}) {
  const gates = [];
  let path = null;

  if (!mandate || mandate.spec !== "SAOS-COMMUNITY-MANDATE/1") {
    gates.push("no owner mandate (community-mandate.json absent/bad spec) — creation is owner-gated (fail-closed)");
  } else if (mandate.name && name && mandate.name !== name) {
    gates.push(`mandate-name-mismatch: mandate ${mandate.name} != requested ${name}`);
  } else if (alreadyExists) {
    return {
      ok: false, verdict: "CREATED", path: "already-exists", at: nowIso ?? null,
      account: ACCOUNT, name, title, gates: [], note: "the community already exists — idempotent honest hold",
    };
  } else if (!policy.NAME_RE.test(name)) {
    gates.push(`bad account name "${name}" — chain rule fail-closed`);
  } else if (!nameFree) {
    gates.push(`name ${name} already taken on-chain — pick the next free hive-XXXXXX (honest hold)`);
  } else if (pendingClaimed >= 1) {
    path = "claimed";
  } else if (rcMax > 0 && rcCurrent >= policy.CLAIM_RC_FLOOR * rcMax && rcCurrent >= RC_MIN) {
    path = "claim";
  }
  if (!path) {
    const need = accountFee + policy.FEE_BUFFER_STEEM;
    if (liquidSteem >= need) {
      path = "fee";
    } else {
      // הערת-RC נרשמת רק כשהיא באמת סיבה-חוסמת — לא כשנתיב-העמלה פתוח
      if (rcMax > 0 && rcCurrent < policy.CLAIM_RC_FLOOR * rcMax) {
        gates.push(`RC ${rcCurrent} below ${Math.round(policy.CLAIM_RC_FLOOR * 100)}% of ceiling ${rcMax} — claim deferred to regen (honest)`);
      }
      gates.push(`liquid ${liquidSteem.toFixed(3)} STEEM < fee ${accountFee.toFixed(3)} + buffer ${policy.FEE_BUFFER_STEEM} = ${need.toFixed(3)} — waiting RC-regen or the SBD-payout (self-funded, never operator money)`);
    }
  }

  const ok = gates.length === 0 && !!path;
  return {
    ok,
    verdict: ok ? "READY" : "HOLD",
    path,
    at: nowIso ?? null,
    account: ACCOUNT,
    name,
    title,
    liquidSteem: Math.round((liquidSteem ?? 0) * 1000) / 1000,
    accountFee,
    pendingClaimed,
    rcCurrent,
    rcMax,
    gates,
  };
}

/* ── צורת-רשויות: הקהילה נשלטת-מיד על-ידי headcorner (account_auth) + מפתח-נולד ── */
export function communityAuth(pub) {
  return { weight_threshold: 1, account_auths: [[ACCOUNT, 1]], key_auths: [[pub, 1]] };
}
const newKey = () => {
  const priv = crypto.randomBytes(32);
  return { priv, pub: privToPub(priv) };
};

/* ── read-back helpers ───────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readAccount(name) {
  return (await rpcAny("condenser_api.get_accounts", [[name]]))?.[0] ?? null;
}
async function isFlaggedCommunity(name) {
  const acc = await readAccount(name);
  if (!acc) return false;
  try { return JSON.parse(acc.json_metadata || "{}").community === name; } catch { return false; }
}

async function liveState(policy = COMMUNITY_POLICY) {
  const [props, head, rc] = await Promise.all([
    rpcAny("condenser_api.get_chain_properties", []),
    readAccount(ACCOUNT),
    rpcAny("rc_api.find_rc_accounts", { accounts: [ACCOUNT] }).catch(() => null),
  ]);
  if (!props || !head) throw new Error("chain state unreadable (fail-closed)");
  const existing = await readAccount(policy.NAME_DEFAULT);
  return {
    accountFee: num(props.account_creation_fee),
    liquidSteem: num(head.balance),
    pendingClaimed: Number(head.pending_claimed_accounts ?? 0),
    rcCurrent: Number(rc?.rc_accounts?.[0]?.rc_manabar?.current_mana ?? 0),
    rcMax: Number(rc?.rc_accounts?.[0]?.max_rc ?? 0),
    nameFree: !existing,
    alreadyExists: await isFlaggedCommunity(policy.NAME_DEFAULT),
  };
}

function persistPlan(plan, evidence) {
  writeFileSync(PLAN_PATH, JSON.stringify({ ...plan, evidence }, null, 1) + "\n");
}

async function main() {
  const execute = process.argv.includes("--execute");
  const policy = { ...COMMUNITY_POLICY };
  if (process.env.COMMUNITY_NAME) policy.NAME_DEFAULT = process.env.COMMUNITY_NAME;
  const mandate = existsSync(MANDATE_PATH) ? JSON.parse(readFileSync(MANDATE_PATH, "utf8")) : null;
  const name = mandate?.name || policy.NAME_DEFAULT;
  const title = mandate?.title || policy.TITLE_DEFAULT;
  const about = mandate?.about || policy.ABOUT_DEFAULT;
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  let plan, evidence = { mode: execute ? "execute" : "plan", at: nowIso, txids: [] };
  try {
    const live = await liveState(policy);
    plan = planCommunity({
      name, title, about, mandate,
      liquidSteem: live.liquidSteem, accountFee: live.accountFee,
      pendingClaimed: live.pendingClaimed, rcCurrent: live.rcCurrent, rcMax: live.rcMax,
      nameFree: live.nameFree, alreadyExists: live.alreadyExists,
      policy, nowIso,
    });
    evidence.live = live;

    if (!execute) {
      evidence.note = "keyless plan only — execution requires the single signing gate (--execute) + mandate";
      persistPlan(plan, evidence);
      appendEvent(EVENTS_LOG, { type: "community.planned", source: "community", sim: false, payload: { verdict: plan.verdict, path: plan.path, name } });
      console.log(`community: ${plan.verdict}${plan.path ? ` (${plan.path})` : ""} · ${name}`);
      for (const g of plan.gates) console.log(`  hold: ${g}`);
      return;
    }

    if (plan.verdict === "CREATED") {
      evidence.note = plan.note;
      persistPlan(plan, evidence);
      console.log(`community: already exists — ${name} (zero ops, honest)`);
      return;
    }
    if (!plan.ok) {
      evidence.note = `honest hold — ${plan.gates.join(" | ")}`;
      persistPlan(plan, evidence);
      appendEvent(EVENTS_LOG, { type: "community.hold", source: "community", sim: false, payload: { gates: plan.gates } });
      console.log(`community: HOLD — ${plan.gates.join(" | ")}`);
      return;
    }

    /* שער-החתימה — אותם-שערי-הגנה של convert/mover, fail-closed. */
    const srcPath = ["/tmp/keystation/live-agent/keys/hed-soldiers-source.txt", "/home/z/git-audit/steem/agent/keys/hed-soldiers-source.txt"].find((p) => existsSync(p)) || null;
    const head = await readAccount(ACCOUNT);
    if (!head) throw new Error("head account absent from live chain (fail-closed)");
    const liveActive = head.active?.key_auths?.[0]?.[0];
    let liveWif = null, keySource = null;
    if (srcPath) {
      const { candidates, privFor } = deriveActiveWif(readFileSync(srcPath, "utf8"));
      for (const pw of candidates) {
        if (privToPub(privFor("active", pw)) === liveActive) { liveWif = privToWif(privFor("active", pw)); keySource = "master-vault"; break; }
      }
    }
    if (!liveWif && process.env.STEEM_ACTIVE_WIF) {
      try {
        if (privToPub(wifToPriv(process.env.STEEM_ACTIVE_WIF)) === liveActive) { liveWif = process.env.STEEM_ACTIVE_WIF; keySource = "ci-secret (verified-against-live-authority)"; }
      } catch { /* WIF פגום — נשאר fail-closed למטה */ }
    }
    if (!liveWif) throw new Error("no key source derives the LIVE active authority (master vault absent + no valid STEEM_ACTIVE_WIF) — refusing to sign (fail-closed)");
    evidence.keySource = keySource; // הוכחת-מקור-מכובדת בלי לחשוף את המפתח

    const rc = await rpcAny("rc_api.find_rc_accounts", { accounts: [ACCOUNT] }).catch(() => null);
    const rcNow = Number(rc?.rc_accounts?.[0]?.rc_manabar?.current_mana ?? 0);
    if (rcNow < RC_MIN) throw new Error(`RC fuel below floor: ${rcNow} < ${RC_MIN} (fail-closed)`);

    /* (א) נתיב-claim: דלק-RC בלבד — אפס-STEEM */
    if (plan.path === "claim") {
      const r = await signAndBroadcast(liveWif, [["claim_accounts", { fee: "0.000 STEEM", creator: ACCOUNT, number_of_accounts: 1, extensions: [] }]]);
      evidence.txids.push({ op: "claim_accounts", txid: r.txid, block: r.block });
      let claimed = 0;
      for (let i = 0; i < 4; i++) {
        await sleep(2000);
        const acc = await readAccount(ACCOUNT);
        claimed = Number(acc?.pending_claimed_accounts ?? 0);
        if (claimed >= 1) break;
      }
      if (claimed < 1) throw new Error("claim broadcast accepted but no account credit visible — fail-closed");
      evidence.claimed = claimed;
      plan.path = "claimed";
    }

    /* יצירה: מפתחות נולדים בזיכרון-בלבד; הרשויות עוברות מיד ל-headcorner */
    const keys = { owner: newKey(), active: newKey(), posting: newKey(), memo: newKey() };
    const createOp = plan.path === "claimed"
      ? ["create_claimed_account", { creator: ACCOUNT, new_account_name: name, owner: communityAuth(keys.owner.pub), active: communityAuth(keys.active.pub), posting: communityAuth(keys.posting.pub), memo_key: keys.memo.pub, json_metadata: "", extensions: [] }]
      : ["create_account", { fee: `${plan.accountFee.toFixed(3)} STEEM`, creator: ACCOUNT, new_account_name: name, owner: communityAuth(keys.owner.pub), active: communityAuth(keys.active.pub), posting: communityAuth(keys.posting.pub), memo_key: keys.memo.pub, json_metadata: "" }];
    const rc2 = await signAndBroadcast(liveWif, [createOp]);
    evidence.txids.push({ op: createOp[0], name, txid: rc2.txid, block: rc2.block });

    let born = null;
    for (let i = 0; i < 4; i++) {
      await sleep(2000);
      born = await readAccount(name);
      if (born) break;
    }
    if (!born) throw new Error("create broadcast accepted but account not visible — fail-closed");

    /* הדגל: json_metadata = {community, community_title, ...} — זהה-צורה ל-condenser */
    const flag = JSON.stringify({ community: name, community_title: title, community_description: about, community_creator: ACCOUNT, created_at: nowIso });
    const ru = await signAndBroadcast(liveWif, [["account_update", { account: name, owner: communityAuth(keys.owner.pub), active: communityAuth(keys.active.pub), posting: communityAuth(keys.posting.pub), memo_key: keys.memo.pub, json_metadata: flag }]]);
    evidence.txids.push({ op: "account_update", name, txid: ru.txid, block: ru.block });

    let flagged = false, headAuthOk = false;
    for (let i = 0; i < 4; i++) {
      await sleep(2000);
      flagged = await isFlaggedCommunity(name);
      const acc = await readAccount(name);
      headAuthOk = !!acc?.owner?.account_auths?.some(([a]) => a === ACCOUNT)
        && !!acc?.active?.account_auths?.some(([a]) => a === ACCOUNT)
        && !!acc?.posting?.account_auths?.some(([a]) => a === ACCOUNT);
      if (flagged && headAuthOk) break;
    }
    if (!flagged) throw new Error("community flag not visible after update — fail-closed");
    if (!headAuthOk) throw new Error("headcorner authority not visible after update — fail-closed");

    plan.verdict = "CREATED";
    plan.gates = [];
    plan.note = "community born: created, flagged, controlled by headcorner — zero orphan keys, zero operator money";
    evidence.note = plan.note;
    persistPlan(plan, evidence);
    appendEvent(EVENTS_LOG, { type: "community.created", source: "community", sim: false, payload: { name, title, txids: evidence.txids.map((t) => t.txid) } });
    console.log(`community: CREATED — ${name} · "${title}" · txids ${evidence.txids.map((t) => t.txid).join(",")}`);
  } catch (err) {
    plan = plan ?? { verdict: "HOLD", name, at: nowIso, gates: [] };
    evidence.note = `fail-closed: ${err?.message ?? String(err)}`;
    persistPlan(plan, evidence);
    appendEvent(EVENTS_LOG, { type: "community.error", source: "community", sim: false, payload: { error: evidence.note } });
    console.error(`community: FAIL-CLOSED — ${evidence.note}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("community.mjs")) {
  await main();
}
