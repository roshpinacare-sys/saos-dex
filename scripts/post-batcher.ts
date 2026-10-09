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
import { buildMerkleTree } from "../../src/lib/saos/merkle";

const DEX = process.cwd();
const MOTHER = path.join(DEX, "..");
const OUT_PKG = path.join(DEX, "state", "broadcast-pending");
const OUT_RECEIPT = path.join(MOTHER, "receipts", "post-batcher-latest.json");
const MAX_BATCH_BYTES = 32 * 1024;

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
  const batch = {
    schema: "saos.post-batch/1",
    at,
    bookCount: payloads.length, // כנות: מה-שקיים-בדיסק-באמת
    lineageRoot: tree.root,
    leafCount: tree.leaves.length,
    payloads: payloads.map(({ body, ...rest }) => ({ ...rest, body })),
    status: "BROADCAST-READY (staging-only — actual posting broadcast remains cadence/owner-gated)",
    doctrine: "books→content-payloads · native-TS compaction · proven merkle lineage · zero secrets · zero auto-broadcast",
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
  fs.writeFileSync(OUT_RECEIPT, JSON.stringify({
    schema: "saos.post-batcher/1", at,
    bookCount: payloads.length, skipped,
    lineageRoot: tree.root, leafCount: tree.leaves.length,
    compaction: { rawBytes: payloads.reduce((n, p) => n + p.bytes.raw, 0), compactBytes: payloads.reduce((n, p) => n + p.bytes.compact, 0), savedBytes: saved },
    staged: path.relative(MOTHER, pkgFile),
    status: "BROADCAST-READY (staging-only)", keysLeaked: false,
  }, null, 1) + "\n");
  console.log(`post-batcher: books=${payloads.length} skipped=${skipped.length} · lineageRoot=${tree.root.slice(0, 16)}… · leaves=${tree.leaves.length} · saved=${saved}B · BROADCAST-READY (staged, zero broadcast)`);
}

main().catch((e) => { console.error(`[post-batcher] FAILED: ${String((e as Error).message ?? e).slice(0, 200)}`); process.exit(1); });
