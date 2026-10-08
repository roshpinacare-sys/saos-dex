/**
 * anchor-continuity.ts — INSTRUMENT #21 · רציפות-העיגון ושרשרת-הביקורת (EXEC-CD-37)
 * ═══════════════════════════════════════════════════════════════════════════════
 * הענקים בונים Transparency Logs (כמו Certificate Transparency) — אבל הערך האמיתי
 * הוא **מאמתים אותם רציפות**, לא רק כותבים אותם. שתי-שרשראות-אמת חיות פה:
 *
 *   A. שרשרת-הביקורת הפנימית (state/signing-audit.jsonl): כל-רשומה חתומה-
 *      hash-chained (sha256 מעל stableStringify(body)-ללא-hash). המכשיר הולך
 *      מהג'נזיס עד-הראש: prevHash[i] === hash[i-1] · seq[i] === seq[i-1]+1 ·
 *      hash[i] === recomputed(i). שרשרת-שבורה = חשד-מניפולציה (או-באג) — FAIL.
 *
 *   B. רציפות-העיגון הציבורית (state/anchors.json): לכל-שרשרת-עם-txid — קריאה-
 *      חוזרת מה-RPC **הציבורי** (לא מאצלנו): Hive get_transaction · TRON
 *      gettransactionbyid → חילוץ-stateRoot-המוטבע → השוואה מול blockHeader
 *      ב-DB המקומי **באותו-גובה** (הקשר chain↔DB↔stateRoot, בלי-לסמוך על-אף-
 *      מקור-יחיד).
 *
 * יציאה: 0=PASS · 1=FAIL. ארטיפקט: audit-package/proof-pack/anchor-continuity.json
 * ריצה: bun harness/anchor-continuity.ts [--quiet]
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname; // saos-dex/
const AUDIT = path.join(ROOT, "state/signing-audit.jsonl");
const ANCHORS = path.join(ROOT, "state/anchors.json");
const LAST = path.join(ROOT, "state/last-anchor.json");
const DB = path.join(ROOT, "db/dex.db");
const ARTIFACT = path.join(ROOT, "audit-package/proof-pack/anchor-continuity.json");
const QUIET = process.argv.includes("--quiet");

/* ── העתק נאמן של stableStringify מ-relay-eth.ts (החותם — אסור לייבא מהמקור:
 *    מאמת צריך להיות עצמאי; שינוי-שם שם צריך להיתפס פה כהפרת-שרשרת) ── */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/* ── A. שרשרת-הביקורת ─────────────────────────────────────────────────────────── */
function verifyAuditChain(): { entries: number; chainOk: boolean; seqOk: boolean; hashOk: boolean; firstBad?: number; detail: string } {
  const lines = fs.readFileSync(AUDIT, "utf8").split("\n").filter((l) => l.trim());
  let prevHash = "";
  let prevSeq = 0;
  let chainOk = true, seqOk = true, hashOk = true;
  let firstBad: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]) as Record<string, unknown> & { hash?: string; prevHash?: string; seq?: number };
    // תיקון-מכשיר (EXEC-CD-37, נתפס-חי): רשומת-הג'נזיס נושאת prevHash=64-אפסים
    // (לא מחרוזת-ריקה) — אומת-מול-appendAudit בrelay-eth. ההנחה-השגויה דגלה
    // את-הראש-בשווא; השרשרת עצמה שלמה.
    const GENESIS = "0".repeat(64);
    const expectedPrev = i === 0 ? GENESIS : (JSON.parse(lines[i - 1]) as { hash: string }).hash;
    if ((ev.prevHash ?? "") !== expectedPrev) { chainOk = false; if (firstBad === undefined) firstBad = i; }
    if (i > 0 && (ev.seq as number) !== prevSeq + 1) { seqOk = false; if (firstBad === undefined) firstBad = i; }
    const body = { ...ev } as Record<string, unknown>;
    const claimedHash = body.hash as string;
    delete body.hash;
    const recomputed = createHash("sha256").update(stableStringify(body)).digest("hex");
    if (recomputed !== claimedHash) { hashOk = false; if (firstBad === undefined) firstBad = i; }
    prevHash = claimedHash; prevSeq = ev.seq as number;
  }
  return {
    entries: lines.length, chainOk, seqOk, hashOk, firstBad,
    detail: `entries=${lines.length} · prevHash-שרשור=${chainOk ? "ok" : "BROKEN"} · seq-מונוטוני=${seqOk ? "ok" : "BROKEN"} · hash-מחושב-מחדש=${hashOk ? "ok" : "BROKEN"}`,
  };
}

/* ── B. עיגונים — קריאה-חוזרת מציבורי + קשר-DB ─────────────────────────────────── */
interface AnchorRow { chain: string; txid: string; fetched: boolean; embeddedRoot: string | null; embeddedHeight: number | null; dbRoot: string | null; dbRootMatch: boolean | null; detail: string }

function embeddedFromHive(txid: string): { root: string | null; height: number | null; detail: string } {
  const endpoints = ["https://api.hive.blog", "https://api.deathwing.me"];
  for (const ep of endpoints) {
    try {
      const r = Bun.spawnSync(["curl", "-s", "-m", "12", "-X", "POST", ep, "-H", "content-type: application/json",
        "-d", JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_transaction", params: [txid], id: 1 })]);
      if (r.exitCode !== 0) continue;
      const j = JSON.parse(r.stdout.toString()) as { result?: { operations?: Array<[string, { json?: string }]> } };
      const op = j.result?.operations?.find((o) => o[0] === "custom_json");
      if (!op) return { root: null, height: null, detail: `${ep}: אין-custom_json ב-tx` };
      const inner = JSON.parse(op[1].json ?? "{}") as { stateRoot?: string; height?: number; protocol?: string };
      return { root: inner.stateRoot ?? null, height: inner.height ?? null, detail: `${ep} · protocol=${inner.protocol ?? "?"}` };
    } catch { /* next endpoint */ }
  }
  return { root: null, height: null, detail: "כל-ה-RPC-הציבוריים כשלו (fetch)" };
}

function embeddedFromTron(txid: string): { root: string | null; height: number | null; detail: string } {
  // F-10b/F-11 מורשת: trongrid עונה plain-JSON (לא json.result) וה-data הוא raw_data.data
  try {
    const r = Bun.spawnSync(["curl", "-s", "-m", "12", "-X", "POST", "https://api.trongrid.io/wallet/gettransactionbyid",
      "-H", "content-type: application/json", "-d", JSON.stringify({ value: txid, visible: true })]);
    if (r.exitCode !== 0) return { root: null, height: null, detail: `trongrid exit=${r.exitCode}` };
    const j = JSON.parse(r.stdout.toString()) as { ret?: Array<{ contractRet?: string }>; raw_data?: { contract?: Array<{ type?: string; parameter?: { value?: { data?: string } } }>; block_height?: number } };
    const ret = j.ret?.[0]?.contractRet;
    const dataHex = j.raw_data?.contract?.[0]?.parameter?.value?.data;
    if (!dataHex) return { root: null, height: null, detail: `trongrid: ret=${ret ?? "?"} אין-data` };
    const text = Buffer.from(dataHex, "hex").toString("utf8");
    const m = text.match(/[0-9a-f]{64}/i);
    const inner = (() => { try { return JSON.parse(text) as { stateRoot?: string; height?: number }; } catch { return { stateRoot: m?.[0] ?? null, height: null }; } })();
    return { root: inner.stateRoot ?? null, height: inner.height ?? j.raw_data?.block_height ?? null, detail: `trongrid · contractRet=${ret}` };
  } catch (e) {
    return { root: null, height: null, detail: `trongrid exception: ${String(e).slice(0, 80)}` };
  }
}

function dbRootAt(height: number | null): string | null {
  if (!height || height <= 0) return null;
  try {
    const db = new Database(DB, { readonly: true });
    const hdr = db.query("SELECT stateRoot FROM blockHeader WHERE height = ?").get(height) as { stateRoot?: string } | undefined;
    db.close();
    return hdr?.stateRoot ?? null;
  } catch { return null; }
}

async function main(): Promise<void> {
  if (!QUIET) console.log(`\n════ INSTRUMENT #21 · ANCHOR-CONTINUITY & HASH-CHAIN ════`);
  const audit = fs.existsSync(AUDIT) ? verifyAuditChain() : { entries: 0, chainOk: false, seqOk: false, hashOk: false, detail: "signing-audit.jsonl נעדר" };
  if (!QUIET) console.log(`A. שרשרת-הביקורת: ${audit.entries} רשומות · ${audit.detail}`);

  const rows: AnchorRow[] = [];
  const reg = JSON.parse(fs.readFileSync(ANCHORS, "utf8")) as { chains: Record<string, { lastTxid?: string | null; lastAnchoredTxid?: string | null; lastHeight?: number | null; anchored?: number; verified?: number; mismatches?: number }> };
  const last = JSON.parse(fs.readFileSync(LAST, "utf8")) as { chain: string; txid: string; height: number; stateRoot: string };
  const targets: Array<{ chain: string; txid: string; height: number | null }> = [];
  for (const [chain, c] of Object.entries(reg.chains)) {
    const txid = c.lastAnchoredTxid ?? c.lastTxid;
    if (txid && (c.anchored ?? 0) > 0) targets.push({ chain, txid, height: c.lastHeight ?? null });
  }
  if (!targets.some((t) => t.txid === last.txid)) targets.push({ chain: last.chain, txid: last.txid, height: last.height });

  for (const t of targets) {
    const emb = t.chain === "tron" ? embeddedFromTron(t.txid) : t.chain === "hive" ? embeddedFromHive(t.txid) : { root: null, height: null, detail: `${t.chain}: אין-קורא-ציבורי-מוגדר (quiet-disabled מתועד)` };
    const dbR = dbRootAt(emb.height ?? t.height);
    const match = emb.root && dbR ? emb.root === dbR : null;
    rows.push({ chain: t.chain, txid: t.txid, fetched: emb.root !== null, embeddedRoot: emb.root, embeddedHeight: emb.height, dbRoot: dbR, dbRootMatch: match, detail: emb.detail });
    if (!QUIET) console.log(`B. ${t.chain.padEnd(6)} ${t.txid.slice(0, 18)}… · מוטבע=${emb.root?.slice(0, 16) ?? "—"} · DB@h=${dbR?.slice(0, 16) ?? "—"} · ${match === true ? "✓ MATCH" : match === false ? "✗ MISMATCH" : "— לא-הכריע"}`);
  }

  const verifiedRows = rows.filter((r) => r.dbRootMatch === true).length;
  const mismatched = rows.filter((r) => r.dbRootMatch === false).length;
  const fetchedOk = rows.filter((r) => r.fetched).length;
  const verdict = audit.chainOk && audit.seqOk && audit.hashOk && mismatched === 0 && fetchedOk > 0 ? "PASS" : "FAIL";
  const outcome = {
    instrument: "anchor-continuity.ts", ts: new Date().toISOString(), verdict,
    audit, anchors: rows, summary: { fetchedOk, verifiedRows, mismatched, targets: rows.length },
  };
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify(outcome, null, 2) + "\n");
  if (!QUIET) console.log(`${verdict === "PASS" ? "✅" : "❌"} ANCHOR-CONTINUITY verdict=${verdict} · audit=${audit.entries}רשומות-${audit.chainOk ? "תקין" : "שבור"} · עיגונים=${verifiedRows}/${rows.length} מאומתים`);
  process.exit(verdict === "PASS" ? 0 : 1);
}
main().catch((e) => { console.error("anchor-continuity crash:", e); process.exit(1); });
