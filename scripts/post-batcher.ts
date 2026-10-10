/**
 * post-batcher.ts — T-35 · פס-הייצור של חבילות-הפרסום · "הספרים-מדברים-על-השרשרת" ═
 * מקור: פרומפט-המערכת T-35 (פעולה-1) — מימוש **נטיבי-TS**: אין compaction.py
 * (לא-קיים-במערכת) — הדחיסה הקנונית ממומשת-כאן כ-`compactCanon()` (טהור, דטרמיניסטי).
 *
 * מה: מיפוי ספרי-המדדים-החיים (db/*.json + קבלות-האם) → payload-תוכן-טרנזקציוני
 *     מקומט → עלי-מרקל → שורש-שושלת (src/lib/saos/merkle.ts — RFC-6962-style,
 *     אותה-ספרייה-שהוכיחה-את-עצמה-מול-CVE-2012-2459) → חבילת-אצווה מתויגת
 *     **BROADCAST-READY** בבופר-האצווה (state/broadcast-pending/).
 * גבולות-הצ'רטר: **staging-בלבד — אפס-שידור-אוטומטי** (פרסום-בפועל נשאר
 *     מוחזק-להכרעת-קדנס/בעלים) · אפס-סודות (הספרים נתוני-שוק/מדד-פומביים) ·
 *     אפס-endpoints-לא-מורשים · ספירת-ספרים **כנה** (מה-שקיים-בדיסק — לא-11-מומצא).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { buildMerkleTree } from "../../src/lib/saos/merkle";

const DEX = process.cwd();
const MOTHER = path.join(DEX, "..");
const OUT_PKG = path.join(DEX, "state", "broadcast-pending");
const OUT_RECEIPT = path.join(MOTHER, "receipts", "post-batcher-latest.json");
const MAX_BATCH_BYTES = 32 * 1024;

/* ── T-36 · לולאת-אימות-השושלת מול-עותקי-האחות — החלטת-המפעיל (שאלה-2 שלאחר-T-35):
 *    לפני-אחסון-שורש-מרקל חדש — חוצה-מול-השכבה-הנציחה של-העותק-האחות (origin/main
 *    בשני-הערוצים-המטוקנים). כלל-הרצף: הקבלה-הקודמת-שפורסמה חייבת-להיות זהה-בין
 *    מקומי-למרוחק; אי-התאמה = **fail-closed** (אחסון-נעצר, קבלה-קנונית-לא-נדרסת).
 *    רשת-לא-נגישה ≠ אי-התאמה — מסומן remote-unreachable-honest ולא-חוסם. ── */
const LOCAL_RECEIPT = path.join(MOTHER, "receipts", "post-batcher-latest.json");
const HELD_RECEIPT = path.join(MOTHER, "receipts", "post-batcher-lineage-held.json");
const REMOTE_RECEIPT_PATH = "receipts/post-batcher-latest.json";
const FETCH_TIMEOUT_MS = 45000;
// T-37: יומן-שמירת-השושלת (audit כנה של-כל-חוצה) + רשימת-שורשים-משורשרת לחציית-אחים
const GUARD_LOG = path.join(MOTHER, "receipts", "lineage-guard.jsonl");
const BOOKS_LINEAGE = path.join(MOTHER, "receipts", "books-lineage.json");
const GUARD_TAIL = 1000; // תקרת-שורות — נגד-נפיחות-מפתחות
const CHAIN_TAIL = 64;

function appendGuard(row: Record<string, unknown>): void {
  try {
    // T-64: תיקון-פגם-כתיבה — JSON.stringify(row).slice(0,240) חתך-את-המחרוזת-באמצע-אובייקט
    // → כל-שורה-פגומה-לנצח (נתפס-ע"י-סריקת-תקינות-הקבלות-בcensus). מעתה: חיתוך-שדה-הפעולה-בלבד,
    // הJSON-שלם-תמיד; השורות-ההיסטוריות-הפגומות-שוחזרו-בסימון-כן (verdict=truncated-repair-T-64).
    const safe = { ...row, action: String(row.action ?? "").slice(0, 80) };
    fs.appendFileSync(GUARD_LOG, JSON.stringify(safe) + "\n");
    const lines = fs.readFileSync(GUARD_LOG, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length > GUARD_TAIL) fs.writeFileSync(GUARD_LOG, lines.slice(-GUARD_TAIL).join("\n") + "\n");
  } catch { /* כנות */ }
}

function writeBooksLineage(root: string, verify: LineageVerify): void {
  try {
    let chain: Array<Record<string, unknown>> = [];
    try { chain = (JSON.parse(fs.readFileSync(BOOKS_LINEAGE, "utf8")) as { chain?: Array<Record<string, unknown>> }).chain ?? []; } catch { /* ארכיון-ראשון */ }
    chain.push({ at: verify.checkedAt, root, prevRoot: verify.prevRoot, verdict: verify.verdict });
    if (chain.length > CHAIN_TAIL) chain = chain.slice(-CHAIN_TAIL);
    fs.writeFileSync(BOOKS_LINEAGE, JSON.stringify({ schema: "saos.books-lineage/1", at: new Date().toISOString(), head: root, chain }, null, 1) + "\n");
  } catch { /* כנות */ }
}

/** חיטוי-דליפות: אף-פלט-git (עשוי-להכיל-URL-מטוקן) לא-יודפס-מעולם */
function scrub(s: string): string {
  return String(s)
    .replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@")
    .replace(/https:\/\/[^@\s]*:[^@\s]*@/g, "https://***@")
    .slice(0, 160);
}

function gitMother(args: string[], timeoutMs: number): string {
  return execFileSync("git", ["-C", MOTHER, ...args], {
    timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

interface LineageVerify {
  verdict: "CONTINUITY-PROVEN" | "CONTINUITY-ADOPTED-FROM-SIBLING" | "first-archive-no-sibling-yet" | "remote-unreachable-honest" | "MISMATCH-FAIL-CLOSED";
  prevRoot: string | null;
  prevRootMatchesLocal: boolean | null;
  prevRootMatchesRemote: boolean | null;
  remoteReceiptAt: string | null;
  checkedAt: string;
  channel: string;
}

function verifyLineage(): { verify: LineageVerify; localPrev: string | null; mismatch: boolean } {
  const checkedAt = new Date().toISOString();
  let localPrev: string | null = null;
  try { localPrev = (JSON.parse(fs.readFileSync(LOCAL_RECEIPT, "utf8")) as { lineageRoot?: string }).lineageRoot ?? null; } catch { /* עדיין-אין-קבלה-מקומית */ }
  let remotePrev: string | null = null;
  let remoteAt: string | null = null;
  let fetched = false;
  try {
    gitMother(["fetch", "-q", "origin", "main"], FETCH_TIMEOUT_MS);
    fetched = true;
  } catch (e) {
    console.error(`[post-batcher] lineage: sibling fetch unreachable-honest (${scrub((e as Error)?.message ?? e)})`);
  }
  if (fetched) {
    try {
      const j = JSON.parse(gitMother(["show", `origin/main:${REMOTE_RECEIPT_PATH}`], 10000)) as { lineageRoot?: string; at?: string };
      remotePrev = j.lineageRoot ?? null;
      remoteAt = j.at ?? null;
    } catch { /* אין-קבלה-על-origin/main — ארכיון-ראשון */ }
  }
  if (!fetched) return {
    verify: { verdict: "remote-unreachable-honest", prevRoot: localPrev, prevRootMatchesLocal: null, prevRootMatchesRemote: null, remoteReceiptAt: null, checkedAt, channel: "origin/main (tokened — credential never printed)" },
    localPrev, mismatch: false,
  };
  if (remotePrev == null) return {
    verify: { verdict: "first-archive-no-sibling-yet", prevRoot: localPrev, prevRootMatchesLocal: null, prevRootMatchesRemote: null, remoteReceiptAt: null, checkedAt, channel: "origin/main (tokened — credential never printed)" },
    localPrev, mismatch: false,
  };
  if (localPrev != null && remotePrev !== localPrev) return {
    verify: { verdict: "MISMATCH-FAIL-CLOSED", prevRoot: localPrev, prevRootMatchesLocal: true, prevRootMatchesRemote: false, remoteReceiptAt: remoteAt, checkedAt, channel: "origin/main (tokened — credential never printed)" },
    localPrev, mismatch: true,
  };
  if (localPrev == null) return {
    verify: { verdict: "CONTINUITY-ADOPTED-FROM-SIBLING", prevRoot: remotePrev, prevRootMatchesLocal: null, prevRootMatchesRemote: true, remoteReceiptAt: remoteAt, checkedAt, channel: "origin/main (tokened — credential never printed)" },
    localPrev, mismatch: false,
  };
  return {
    verify: { verdict: "CONTINUITY-PROVEN", prevRoot: localPrev, prevRootMatchesLocal: true, prevRootMatchesRemote: true, remoteReceiptAt: remoteAt, checkedAt, channel: "origin/main (tokened — credential never printed)" },
    localPrev, mismatch: false,
  };
}

/* ── ספרי-המדדים הקנוניים — כל-ספר עם-מחלץ-תחום (≤2KB פר-ספר) ── */
interface Book { name: string; file: string; pick: (j: Record<string, unknown>) => Record<string, unknown> }
const BOOKS: Book[] = [
  { name: "book-gas", file: "db/book-gas.json", pick: (j) => ({ collectedMu: j.collectedMu ?? null, recycledMu: j.recycledMu ?? null, byKind: j.byKind ?? null }) },
  { name: "grid-ledger", file: "db/grid-ledger.json", pick: (j) => ({ version: j.version ?? null, lastOrders: (j.orders as unknown[])?.slice?.(-6) ?? null }) },
  { name: "grid-public", file: "db/grid-public.json", pick: (j) => ({ ok: j.ok ?? null, publishedAt: j.publishedAt ?? null, engine: j.engine ?? null, account: j.account ?? null, chain: j.chain ?? null }) },
  { name: "klines", file: "db/klines.json", pick: (j) => { const pairs = (j.pairs ?? {}) as Record<string, unknown[]>; const out: Record<string, unknown> = {}; for (const k of Object.keys(pairs).sort().slice(0, 3)) out[k] = pairs[k]?.slice?.(-3) ?? null; return { savedAt: j.savedAt ?? null, pairs: out }; } },
  { name: "maker-stats", file: "db/maker-stats.json", pick: (j) => { const recs = (j.recs ?? {}) as Record<string, Record<string, unknown>>; const out: Record<string, unknown> = {}; for (const k of Object.keys(recs).sort()) out[k] = { fills: recs[k]?.fills ?? null, volMu: recs[k]?.volMu ?? null }; return { makers: out }; } },
  { name: "rail-lifetime", file: "db/rail-lifetime.json", pick: (j) => ({ usds: j.usds ?? null, wsteem: j.wsteem ?? null, energy: j.energy ?? null, saos: j.saos ?? null }) },
  { name: "dex-credits", file: "db/dex-credits.json", pick: (j) => ({ creditsCount: (j.credits as unknown[])?.length ?? 0, lastScanBlock: j.lastScanBlock ?? null }) },
  { name: "state-snapshot", file: "db/state-snapshot.json", pick: (j) => { const st = (j.state ?? {}) as Record<string, unknown>; return { savedAt: j.savedAt ?? null, height: st.height ?? null, treasury: st.treasury ?? (st.balances as Record<string, unknown>)?.treasury ?? null }; } },
  { name: "fuel-state", file: "../receipts/fuel-state-latest.json", pick: (j) => ({ at: j.at ?? null, blockers: (j.blockers as unknown[])?.slice?.(0, 6) ?? null }) },
  { name: "revenue-router", file: "../receipts/revenue-router-latest.json", pick: (j) => ({ at: j.at ?? null, spread: j.spread ?? null, yield: j.yield ?? null }) },
  { name: "rpc-mesh", file: "../receipts/rpc-mesh-latest.json", pick: (j) => ({ at: j.at ?? null, ranked: j.ranked ?? null }) },
];

/* ── הדחיסה-הקנונית (דור-TS של "compaction"): מיון-מפתחות · ניפוי-ריקים ·
 *    עיגול-צפים-4dp · קיצוץ-מחרוזות-96 · בלי-רווחים — דטרמיניסטי-מלא ── */
function compactCanon(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return Math.round(v * 1e4) / 1e4;
  if (typeof v === "string") return v.length > 96 ? v.slice(0, 93) + "…" : v;
  if (Array.isArray(v)) { const a = v.map(compactCanon).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const c = compactCanon((v as Record<string, unknown>)[k]);
      if (c !== undefined) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}

interface Payload { schema: string; book: string; at: string; bytes: { raw: number; compact: number }; body: unknown; status: string }

async function main(): Promise<void> {
  const at = new Date().toISOString();
  const payloads: Payload[] = [];
  const skipped: Array<{ book: string; reason: string }> = [];
  for (const b of BOOKS) {
    const p = path.resolve(DEX, b.file);
    try {
      const raw = fs.readFileSync(p, "utf8");
      const j = JSON.parse(raw) as Record<string, unknown>;
      const body = compactCanon(b.pick(j));
      if (body === undefined) { skipped.push({ book: b.name, reason: "empty-after-compaction-honest" }); continue; }
      const compactStr = JSON.stringify(body);
      if (compactStr.length > MAX_BATCH_BYTES / 2) { skipped.push({ book: b.name, reason: "oversize-honest" }); continue; }
      payloads.push({ schema: "saos.post-payload/1", book: b.name, at, bytes: { raw: Buffer.byteLength(raw), compact: Buffer.byteLength(compactStr) }, body, status: "COMPILED" });
    } catch (e) { skipped.push({ book: b.name, reason: String((e as Error)?.message ?? e).slice(0, 60) }); }
  }
  if (payloads.length === 0) {
    console.error("[post-batcher] no books compiled (honest) — zero staging written");
    process.exit(1);
  }
  // שורש-שושלת: עלה = גוף-ה-payload-המקומט (אותה-ספריית-מרקל-מוכחת)
  const tree = await buildMerkleTree(payloads.map((p) => JSON.stringify({ book: p.book, at: p.at, body: p.body })));
  // T-36: חציית-השושלת מול-העותק-האחות **לפני-האחסון** (fail-closed על-אי-התאמה)
  const { verify, mismatch } = verifyLineage();
  const heldStatus = "ARCHIVE-HELD (lineage mismatch vs sibling — fail-closed)";
  const batch = {
    schema: "saos.post-batch/1",
    at,
    bookCount: payloads.length, // כנות: מה-שקיים-בדיסק-באמת
    lineageRoot: tree.root,
    leafCount: tree.leaves.length,
    lineageVerify: verify,
    payloads: payloads.map(({ body, ...rest }) => ({ ...rest, body })),
    status: mismatch ? heldStatus : "BROADCAST-READY (staging-only — actual posting broadcast remains cadence/owner-gated)",
    doctrine: "books→content-payloads · native-TS compaction · proven merkle lineage · sibling-continuity cross-check · zero secrets · zero auto-broadcast",
    keysLeaked: false,
  };
  const batchStr = JSON.stringify(batch, null, 1) + "\n";
  if (Buffer.byteLength(batchStr) > MAX_BATCH_BYTES) {
    console.error(`[post-batcher] batch oversize ${Buffer.byteLength(batchStr)}B > ${MAX_BATCH_BYTES}B (honest — skipped)`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_PKG, { recursive: true });
  const pkgFile = path.join(OUT_PKG, `post-batch-${at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(pkgFile, batchStr);
  fs.writeFileSync(path.join(OUT_PKG, "post-batch-latest.json"), batchStr);
  const saved = payloads.reduce((n, p) => n + (p.bytes.raw - p.bytes.compact), 0);
  if (mismatch) {
    // fail-closed: הקבלה-הקנונית-האחרונה **לא-נדרסת** (היא-העוגן-הטוב-האחרון);
    // עדות-ההחזקה נכתבת-בקובץ-נפרד והחבילה מסומנת ARCHIVE-HELD.
    appendGuard({ at, root: tree.root, prevRoot: verify.prevRoot, verdict: verify.verdict, action: "archive-refused" });
    fs.writeFileSync(HELD_RECEIPT, JSON.stringify({
      schema: "saos.post-batcher-held/1", at,
      bookCount: payloads.length, skipped,
      lineageRoot: tree.root, leafCount: tree.leaves.length, lineageVerify: verify,
      staged: path.relative(MOTHER, pkgFile),
      status: heldStatus, keysLeaked: false,
    }, null, 1) + "\n");
    console.error(`[post-batcher] FAILED: lineage MISMATCH vs sibling (local=${(verify.prevRoot ?? "null").slice(0, 16)}… remote=${(verify.remoteReceiptAt ? "differs" : "null")}) — ARCHIVE-HELD, canonical receipt preserved (fail-closed)`);
    process.exit(1);
  }
  fs.writeFileSync(OUT_RECEIPT, JSON.stringify({
    schema: "saos.post-batcher/2", at,
    bookCount: payloads.length, skipped,
    lineageRoot: tree.root, leafCount: tree.leaves.length, lineageVerify: verify,
    compaction: { rawBytes: payloads.reduce((n, p) => n + p.bytes.raw, 0), compactBytes: payloads.reduce((n, p) => n + p.bytes.compact, 0), savedBytes: saved },
    staged: path.relative(MOTHER, pkgFile),
    status: "BROADCAST-READY (staging-only)", keysLeaked: false,
  }, null, 1) + "\n");
  appendGuard({ at, root: tree.root, prevRoot: verify.prevRoot, verdict: verify.verdict, action: "archived-broadcast-ready" });
  writeBooksLineage(tree.root, verify);
  console.log(`post-batcher: books=${payloads.length} skipped=${skipped.length} · lineageRoot=${tree.root.slice(0, 16)}… · leaves=${tree.leaves.length} · saved=${saved}B · lineage=${verify.verdict} · BROADCAST-READY (staged, zero broadcast)`);
}

main().catch((e) => { console.error(`[post-batcher] FAILED: ${String((e as Error).message ?? e).slice(0, 200)}`); process.exit(1); });
