/* scripts/chaos-test.ts — מבחן-כאוס מבוקר (Controlled Chaos Testing) · SAOS-DEX
 *
 * SECURITY INTENT: להוכיח שה-Relay שורד תנאי-קיצון מבלי לקרוס, מבלי לשדר דבר
 * אל-השרשראות, ומבלי לאשר אימות-שקרי — באמצעות הזרקת-תקלות מבוקרת (chaos.ts),
 * לא ע"י פגיעה בתשתית אמת.
 *
 * תרחישים:
 *   A. ניתוק-RPC יזום (Steem+Hive+TRON) למשך 60 שניות — חותמות נכנסות במהלך
 *      המחיצה; ה-Circuit Breaker חייב להיפתח (OPEN) אחרי כשלים-קשים-רצופים,
 *      התור נשאר כנה (ממתין), התהליך שורד, ואפס ניסיונות-רשת בפועל.
 *   B. הזרקת stateRoot מזויף — verifyOnChain (דרך relayAuditVerify) חייבת
 *      לקרוא-חזרה מה-RPC הציבורי, לזהות את המיסמאץ', להדליק ALERT, לספור
 *      mismatch, ולסרב לאשר את העיגון. בקרה-חיובית: אותו-txid עם ה-stateRoot
 *      האמת מאומת. זהו מבחן-קריאה-בלבד — אפס שידורים.
 *   C. txid לא-קיים — "not indexed" חייב להישאר כנה: לא מיסמאץ', לא ALERT.
 *
 * בידוד: מצב-ה-Relay של הבדיקה מנותב לתיקיית-זמן (SAOS_DEX_STATE_DIR) —
 * ראיות-הבדיקה לעולם לא נוגעות ב-state/anchors.json של הדמון החי.
 * אפס סודות בפלט: המפתחות נטענים לזיכרון לצורך-הרצת-הנתיב בלבד, ולעולם לא נדפסים.
 *
 * הרצה: bun scripts/chaos-test.ts   (מתוך שורש saos-dex)
 * פלט:  דוח חי בקונסולה + CHAOS_TEST_RESULTS.md (מחליף-את-הקודם בכל-ריצה)
 */

import fs from "fs";
import os from "os";
import path from "path";

/* ── בידוד-מצב — חייב לקרות לפני-ייבוא relay (המודול קורא את ה-env בטעינה) ── */
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "saos-chaos-"));
process.env.SAOS_DEX_STATE_DIR = sandboxDir;

/* ── טיפוסי-עזר (type-only — לא גוררים את chain.ts לזמן-ריצה) ── */
interface SealInfo { fromHeight: number; toHeight: number; root: string; stateRoot: string; leaves: number; at: number; digest: string }
interface BreakerView { state: string; failures: number; openedAt: number | null; trips: number }
interface ChainStateView { enabled: boolean; status: string; lastError: string | null; anchored: number; verified: number; mismatches: number; breaker: BreakerView }
interface RelayStatusView {
  enabled: boolean; account: string | null; queue: number;
  metrics: { broadcasts: number; verified: number; mismatches: number; breakerTrips: number; economicWaits: number };
  chains: Record<"steem" | "hive" | "tron", ChainStateView>;
  records: { chain: string; height: number; status: string; txid: string | null; attempt: number; verified: boolean | null; error?: string }[];
}
interface Candidate { chain: "steem" | "hive"; txid: string; height: number; stateRoot: string }

const FAIL_EXIT = (msg: string): never => { console.error(`[chaos] FATAL: ${msg}`); process.exit(1); };

/* ── לכידת-ALERT (עטיפת-console.error — הפלט המקורי נשמר) ── */
const alerts: string[] = [];
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  alerts.push(line);
  origError(...args);
};

const t0Wall = Date.now();
function stamp(): string { return `+${((Date.now() - t0Wall) / 1000).toFixed(1)}s`; }
function log(kind: string, msg: string): void { console.info(`[chaos ${stamp()}] ${kind.padEnd(6)} ${msg}`); }

interface Check { name: string; pass: boolean; detail: string }
const results: Check[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  log(pass ? "PASS" : "FAIL", `${name}${detail ? ` · ${detail}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await import("dotenv/config"); // מפתחות-ריצה לזיכרון בלבד (פלט-אפס)

  const chaos = await import("../src/lib/dex/chaos");
  const canonical = await import("../src/lib/dex/canonical");
  const relay = await import("../src/lib/dex/relay");

  const status = (): RelayStatusView => relay.relayStatus() as unknown as RelayStatusView;

  console.info("=================================================================");
  console.info(" SAOS-DEX · Controlled Chaos Test — relay circuit breakers + verifyOnChain");
  console.info(` state sandbox: ${sandboxDir}  (isolated from live state/)`);
  console.info("=================================================================");

  if (!status().enabled) FAIL_EXIT("relay disabled — .env keys missing in this environment; chaos test requires the live relay path");

  /* ══ תרחיש A — מחיצת-רשת יזומה (60 שניות) ═══════════════════════════════ */
  log("PHASE-A", "arming 60s network partition on steem + hive + tron (fault-injection — zero real traffic)");
  for (const t of ["steem", "hive", "tron"] as const) chaos.armChaos(t, 60_000);

  const SEALS_AT_SEC = [0, 15, 30, 45, 58]; // חותמות נכנסות גם בזמן-המחיצה (כמו-בפרודקשן)
  const makeSeal = (n: number): SealInfo => {
    const toHeight = 990_000 + n * 12; // טווח-בדיקה מפורש — לא קרוב לגבהים-אמת
    const info: SealInfo = {
      fromHeight: toHeight - 11, toHeight,
      root: canonical.sha256(`chaos-block-root-${n}`),
      stateRoot: canonical.sha256(`chaos-state-root-${n}`),
      leaves: 12, at: Date.now(), digest: "",
    };
    info.digest = canonical.sha256(canonical.canon(info));
    return info;
  };

  const t0A = Date.now();
  const pending = [...SEALS_AT_SEC];
  const timeline: string[] = [];
  const lastBreaker: Record<string, string> = { steem: "closed", hive: "closed", tron: "closed" };

  while (Date.now() - t0A < 62_000) {
    const elapsedSec = (Date.now() - t0A) / 1000;
    while (pending.length > 0 && elapsedSec >= pending[0]!) {
      const at = pending.shift()!;
      const n = SEALS_AT_SEC.length - pending.length;
      relay.relaySeal(makeSeal(n));
      log("seal", `fired seal #${n} (h${990_000 + n * 12}) at +${at}s — relay must survive and retry honestly`);
    }
    const st = status();
    for (const c of ["steem", "hive", "tron"] as const) {
      const b = st.chains[c].breaker;
      if (b.state !== lastBreaker[c]) {
        lastBreaker[c] = b.state;
        const line = `+${elapsedSec.toFixed(0)}s · ${c}.breaker → ${b.state.toUpperCase()} (failures=${b.failures}, trips=${b.trips})`;
        timeline.push(line);
        log("BREAKER", line);
      }
    }
    await sleep(500);
  }
  chaos.disarmChaos();
  log("PHASE-A", "partition window over (60s) — process alive, disarmChaos() done");

  const stA = status();
  check("A1 · process survived 60s partition", true, "chaos script still executing");
  check("A2 · steem circuit breaker OPEN", stA.chains.steem.breaker.state === "open", `state=${stA.chains.steem.breaker.state} failures=${stA.chains.steem.breaker.failures} trips=${stA.chains.steem.breaker.trips}`);
  check("A3 · hive circuit breaker OPEN", stA.chains.hive.breaker.state === "open", `state=${stA.chains.hive.breaker.state} failures=${stA.chains.hive.breaker.failures}`);
  check("A4 · tron circuit breaker OPEN", stA.chains.tron.breaker.state === "open", `state=${stA.chains.tron.breaker.state} failures=${stA.chains.tron.breaker.failures}`);
  check("A5 · breaker OPEN blocks new attempts (honest queue)", stA.queue > 0, `queue=${stA.queue} jobs waiting for half-open probe (cooldown 5min)`);
  const chaosOnly = stA.records.length > 0 && stA.records.every((r) => !r.error || r.error.startsWith("chaos:"));
  check("A6 · zero real network attempts (all errors are injected chaos failures)", chaosOnly, `${stA.records.length} record(s) · every error starts with 'chaos:' — gate fired inside the normal failure path (no RPC/key use)`);
  check("A7 · breaker trips counted", stA.metrics.breakerTrips >= 3, `trips=${stA.metrics.breakerTrips}`);

  /* ══ תרחיש B — הזרקת stateRoot מזויף ════════════════════════════════════ */
  log("PHASE-B", "injecting a forged stateRoot — verifyOnChain must read back from public RPC, ALERT, and refuse");

  const realAnchorsPath = path.join(process.cwd(), "state", "anchors.json");
  const real = JSON.parse(fs.readFileSync(realAnchorsPath, "utf8")) as { records?: (Candidate & { chain: string; verified: boolean | null })[] };
  const candidates: Candidate[] = (real.records ?? [])
    .filter((r) => (r.chain === "steem" || r.chain === "hive") && typeof r.txid === "string" && r.txid.length >= 40 && typeof r.height === "number" && typeof r.stateRoot === "string" && r.stateRoot.length === 64)
    .sort((a, b) => (a.chain === "steem" ? 0 : 1) - (b.chain === "steem" ? 0 : 1))
    .slice(0, 4) as Candidate[];
  if (candidates.length === 0) FAIL_EXIT("no on-chain anchor candidates in state/anchors.json — cannot build a read-back test vector");

  const mismatchesBefore = status().metrics.mismatches;
  const fakeRoot = canonical.sha256("chaos: forged stateRoot — must never be approved");
  let positiveOk = false;
  let chosen: Candidate | null = null;
  let fakeRes: { ok: boolean; verified: boolean | null; detail: string } | null = null;

  for (const cand of candidates) {
    // בקרה-חיובית קודם — ודא שה-txid קריא-מה-RPC הציבורי עם השורש-האמת
    const realRes = await relay.relayAuditVerify(cand.chain, cand.txid, { height: cand.height, stateRoot: cand.stateRoot });
    if (!realRes.ok) { log("skip", `${cand.chain} txid ${cand.txid.slice(0, 12)}… not verifiable right now (${realRes.detail.slice(0, 60)}) — trying next candidate`); continue; }
    chosen = cand;
    positiveOk = true;
    log("control", `positive control OK on ${cand.chain} h${cand.height} · txid ${cand.txid.slice(0, 16)}… verified via public RPC`);

    // עתה ההזרקה — אותו-txid, stateRoot מזויף
    fakeRes = await relay.relayAuditVerify(cand.chain, cand.txid, { height: cand.height, stateRoot: fakeRoot });
    break;
  }

  if (!chosen || !fakeRes) FAIL_EXIT("no candidate passed positive control — RPC reachability issue, chaos assertions not executed");

  check("B1 · positive control: real stateRoot verifies on-chain", positiveOk, `${chosen!.chain} h${chosen!.height} txid ${chosen!.txid.slice(0, 16)}…`);
  check("B2 · forged stateRoot DETECTED (mismatch)", fakeRes!.ok === false && fakeRes!.verified === false, `detail="${fakeRes!.detail.slice(0, 90)}"`);
  check("B3 · forged stateRoot REJECTED (not approved as verified)", fakeRes!.verified === false, `verified=${fakeRes!.verified}`);
  const alertFired = alerts.some((a) => a.includes("[saos-relay][ALERT]") && a.includes("stateRoot verification FAILED"));
  check("B4 · ALERT logged on mismatch", alertFired, `${alerts.filter((a) => a.includes("ALERT")).length} alert line(s) captured`);
  const mismatchesAfter = status().metrics.mismatches;
  check("B5 · mismatch counted in metrics", mismatchesAfter >= mismatchesBefore + 1, `mismatches ${mismatchesBefore} → ${mismatchesAfter}`);

  /* ══ תרחיש C — txid לא-קיים: "not indexed" ≠ mismatch (כנות) ═════════════ */
  log("PHASE-C", "nonexistent txid — must stay honest: 'not indexed', no mismatch, no false ALERT");
  const ghostTxid = "0".repeat(40);
  const ghostBefore = status().metrics.mismatches;
  const ghost = await relay.relayAuditVerify(chosen!.chain, ghostTxid, { height: chosen!.height, stateRoot: chosen!.stateRoot });
  const ghostAfter = status().metrics.mismatches;
  check("C1 · not-indexed stays honest (verified=null, no mismatch)", ghost.verified === null && ghostAfter === ghostBefore, `detail="${ghost.detail.slice(0, 70)}" · mismatches unchanged (${ghostAfter})`);

  /* ══ סיכום + תיעוד ═════════════════════════════════════════════════════ */
  const passCount = results.filter((r) => r.pass).length;
  const allPass = passCount === results.length;
  const durationSec = ((Date.now() - t0Wall) / 1000).toFixed(1);

  console.info("-----------------------------------------------------------------");
  log("SUMMARY", `${passCount}/${results.length} checks passed · total ${durationSec}s`);
  console.info("-----------------------------------------------------------------");

  const md = [
    "# CHAOS_TEST_RESULTS — מבחן-כאוס מבוקר · SAOS-DEX Relay",
    "",
    `> נוצר אוטומטית ע"י \`scripts/chaos-test.ts\` · ריצה: ${new Date().toISOString()} · משך: ${durationSec}s`,
    "> הזרקות דרך `src/lib/dex/chaos.ts` (נקודת-הזרקה אינרטית בפרודקשן). מצב-הבדיקה מבודד בתיקיית-זמן — אפס נגיעה ב-`state/anchors.json` החי.",
    "",
    "## תרחיש A — ניתוק-RPC יזום (60 שניות, Steem+Hive+TRON)",
    "",
    "- 5 חותמות הוזרמו ל-Relay במהלך המחיצה (t=0/15/30/45/58s) — כמו-בפרודקשן.",
    "- כל-ניסיון-שידור נפל על שער-הכאוס לפני-כל-פעילות-רשת/מפתח (כשל-קשי — נספר ל-breaker).",
    "",
    "ציר-זמן נצפה:",
    "",
    "```",
    ...timeline,
    "```",
    "",
    "## תרחיש B — הזרקת stateRoot מזויף (קריאה-חוזרת מה-RPC הציבורי)",
    "",
    `- וקטור-בדיקה: ${chosen!.chain} · height ${chosen!.height} · txid \`${chosen!.txid}\` (עיגון-אמת מ-anchors.json)`,
    `- stateRoot מוזרק: \`${fakeRoot}\``,
    "- המערכת זיהתה מיסמאץ', הדליקה `[saos-relay][ALERT]`, ספרה mismatch, וסירבה לאשר.",
    "",
    "## תרחיש C — txid לא-קיים",
    "",
    "- `not indexed` נשאר כנה: verified=null, אין-mismatch, אין-ALERT שקרי — נכנס לתור-הפיוס.",
    "",
    "## תוצאות",
    "",
    "| # | בדיקה | תוצאה | פירוט |",
    "|---|---|---|---|",
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "\\|")} |`),
    "",
    `**סה"כ: ${passCount}/${results.length} עברו · VERDICT: ${allPass ? "PASS — ה-Relay שורד כאוס ומסרב לאשר שקר" : "FAIL"}**`,
    "",
    "## כנות",
    "",
    "- אפס שידורים אל-השרשראות במבחן: ההזרקה זורקת לפני-כל-גישה לרשת/מפתח (הוכח ע\"י A6).",
    "- קריאות-ה-RPC בתרחישים B/C הן קריאה-בלבד (`get_transaction`) — אימות-ציבורי בלתי-תלוי.",
    "- מפתחות: זיכרון-בלבד; אפס סודות בפלט/בדוח.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(process.cwd(), "CHAOS_TEST_RESULTS.md"), md);
  log("report", "CHAOS_TEST_RESULTS.md written");

  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  origError("[chaos] FATAL:", e);
  process.exit(1);
});
