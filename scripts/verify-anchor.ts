/* ═══════════════════════════════════════════════════════════════════════════
 * VERIFY-ANCHOR — CLI ציבורי לאימות-צד-שלישי (M4 מ-ARCHITECTURE_ROADMAP)
 * ═══════════════════════════════════════════════════════════════════════════
 * SECURITY INTENT: אימות-אמת של עיגוני השרשרת בלי לסמוך עלינו. הכלי עצמאי
 * לגמרי — אפס יבוא מ-src/, אפס תלות מעבר ל-bun עצמו — כדי שכל אדם יוכל
 * להריץ אותו מכל מקום: הוא קורא את ה-tx מה-RPC הציבורי (אותם צמתים שה-Relay
 * משתמש בהם), מוציא ממנו את ה-custom_json של `saos-dex.anchor.v1`, ומשווה
 * ביט-מול-ביט מול מקור-אמת מקומי שהבודק בוחר.
 *
 * מקורות-אמת אפשריים (בדיקה על כל מי שזמין):
 *   · --height N --root R     ציפייה ידנית (הבודק יודע בעצמו מה ה-root הנכון)
 *   · --anchors <path>        state/anchors.json שפורסם (רשומות לפי txid)
 *   · --db <path>             db/dex.db → SealRecord (השוואת stateRoot/merkleRoot
 *                             מול החותם המקומי של חלון הגובה)
 * בלי אף מקור: SELF-REPORT כנה — העדות מוצגת כפי שהיא על השרשרת (מפורקת
 * ומאומתת-מבנית: פרוטוקול/פעולה/חתימה), אבל לא נקראת "VERIFIED" — כנות
 * מוסדית: אימות דורש צד-השוואה, אחרת זה רק קריאה.
 *
 * שימוש:
 *   bun scripts/verify-anchor.ts <txid> [--chain auto|steem|hive|blurt]
 *                                  [--height N] [--root R]
 *                                  [--anchors state/anchors.json]
 *                                  [--db db/dex.db] [--json]
 *
 * קודי-יציאה: 0=VERIFIED · 1=MISMATCH · 2=NOT-INDEXED/בלתי-הכרעה · 3=שימוש-רע
 *
 * דוגמאות חיות (עיגונים היסטוריים מתועדים ב-STATUS.md §עיגון-רשת חי):
 *   bun scripts/verify-anchor.ts 390bcfc2586def1ef02cc40a0e983c8dd8fce177
 *   bun scripts/verify-anchor.ts d4cf936b0b5e1eff8dcc8a508532f67c95682bd5 --chain hive
 * ═══════════════════════════════════════════════════════════════════════ */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ANCHOR_ID = "saos-dex.anchor.v1";

/* אותם צמתים-ציבוריים שה-Relay עצמו מדבר איתם (src/lib/dex/relay.ts) —
 * עדכון שם צריך להתלוות בעדכון כאן (הכלי חייב לראות את אותו עולם). */
const NODES: Record<string, string[]> = {
  steem: ["https://api.steemit.com", "https://api.justyy.com"],
  hive: ["https://api.hive.blog", "https://api.deathwing.me"],
  blurt: ["https://rpc.blurt.blog"],
};

interface AnchorPayload {
  protocol?: string;
  action?: string;
  at?: string;
  epoch?: string;
  height?: number;
  sealFrom?: number;
  stateRoot?: string;
  merkleRoot?: string;
  leaves?: number;
  digest?: string;
}

interface Expectation {
  source: string;
  height?: number;
  stateRoot?: string;
  merkleRoot?: string;
  account?: string;
}

interface OnChainFinding {
  chain: string;
  node: string;
  blockNum: number | null;
  accounts: string[];
  payload: AnchorPayload;
  raw: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function isHex64(x: unknown): x is string {
  return typeof x === "string" && HEX64.test(x);
}

/* ── שליפה מה-RPC הציבורי ─────────────────────────────────────────────── */
async function fetchTx(node: string, txid: string): Promise<{ operations?: unknown[]; block_num?: number } | null> {
  try {
    const res = await fetch(node, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "condenser_api.get_transaction", params: [txid], id: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: { operations?: unknown[]; block_num?: number } };
    return j.result ?? null;
  } catch {
    return null;
  }
}

function extractAnchor(tx: { operations?: unknown[]; block_num?: number }, chain: string, node: string, txid: string): OnChainFinding | null {
  if (!Array.isArray(tx.operations)) return null;
  for (const entry of tx.operations as [string, Record<string, unknown>][]) {
    const [opName, opBody] = entry;
    if (opName !== "custom_json" || opBody?.id !== ANCHOR_ID) continue;
    const accounts = [
      ...((opBody.required_auths as unknown[] | undefined) ?? []),
      ...((opBody.required_posting_auths as unknown[] | undefined) ?? []),
    ].map((x) => String(x));
    let payload: AnchorPayload = {};
    try { payload = JSON.parse(String(opBody.json)) as AnchorPayload; } catch { /* נדווח כשקוף למטה */ }
    return {
      chain, node,
      blockNum: typeof tx.block_num === "number" ? tx.block_num : null,
      accounts,
      payload,
      raw: String(opBody.json ?? ""),
    };
  }
  return null;
}

/* ── מקורות-אמת מקומיים ────────────────────────────────────────────────── */
function expectationsFromAnchors(file: string, txid: string): Expectation[] {
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { records?: Array<Record<string, unknown>> };
    return (j.records ?? [])
      .filter((r) => String(r.txid ?? "") === txid)
      .map((r) => ({
        source: `anchors.json (${r.chain})`,
        height: typeof r.height === "number" ? r.height : undefined,
        stateRoot: isHex64(r.stateRoot) ? r.stateRoot : undefined,
        account: typeof r.account === "string" ? r.account : undefined,
      }));
  } catch {
    return [];
  }
}

function expectationsFromDb(file: string, payloadHeight?: number): Expectation[] {
  if (!existsSync(file)) return [];
  try {
    const db = new Database(file, { readonly: true });
    const rows = (
      payloadHeight !== undefined
        ? db.query("SELECT root, stateRoot, fromHeight, toHeight, leavesCount FROM SealRecord WHERE toHeight = ? OR stateRoot IS NOT NULL ORDER BY createdAt DESC LIMIT 400").all(payloadHeight)
        : db.query("SELECT root, stateRoot, fromHeight, toHeight, leavesCount FROM SealRecord ORDER BY createdAt DESC LIMIT 400").all()
    ) as Array<{ root: string; stateRoot: string; fromHeight: number | null; toHeight: number | null; leavesCount: number }>;
    db.close();
    return rows
      .filter((r) => isHex64(r.stateRoot) && (payloadHeight === undefined || (r.fromHeight ?? 0) <= payloadHeight && payloadHeight <= (r.toHeight ?? Number.MAX_SAFE_INTEGER)))
      .map((r) => ({
        source: `db SealRecord h${r.fromHeight ?? "?"}..${r.toHeight ?? "?"}`,
        height: r.toHeight ?? undefined,
        stateRoot: r.stateRoot,
        merkleRoot: isHex64(r.root) ? r.root : undefined,
      }));
  } catch {
    return [];
  }
}

/* ── ראשי ─────────────────────────────────────────────────────────────── */
function usage(): never {
  console.error(`verify-anchor — אימות-צד-שלישי של עיגוני saos-dex (M4)
שימוש: bun scripts/verify-anchor.ts <txid> [--chain auto|steem|hive|blurt]
        [--height N] [--root R] [--anchors path] [--db path] [--json]
קודי-יציאה: 0=VERIFIED 1=MISMATCH 2=NOT-INDEXED/בלתי-הכרעה 3=שימוש-רע`);
  process.exit(3);
}

const args = process.argv.slice(2);
const TXID = args.find((a) => !a.startsWith("--"));
if (!TXID || TXID.length < 40) usage();

function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

const CHAIN = (opt("chain") ?? "auto").toLowerCase();
if (!["auto", ...Object.keys(NODES)].includes(CHAIN)) usage();

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const ANCHORS_PATH = opt("anchors") ?? path.join(ROOT_DIR, "state", "anchors.json");
const DB_PATH = opt("db") ?? path.join(ROOT_DIR, "db", "dex.db");

/* 1) ציפיות — ידניות גוברות, אחר-כך anchors.json, אחר-כך db */
const manual: Expectation[] = [];
if (opt("root")) {
  if (!isHex64(opt("root"))) usage();
  manual.push({ source: "--root (manual)", stateRoot: opt("root"), height: opt("height") ? Number(opt("height")) : undefined });
}

/* שליפת-מקדימה: כדי לדעת את הגובה לסינון-db, קוראים את ה-tx קודם */
const CHAINS_TO_TRY = CHAIN === "auto" ? Object.keys(NODES) : [CHAIN];
let found: OnChainFinding | null = null;
let triedNodes = 0;
for (const ch of CHAINS_TO_TRY) {
  for (const node of NODES[ch]) {
    triedNodes++;
    const tx = await fetchTx(node, TXID);
    if (!tx) continue;
    const f = extractAnchor(tx, ch, node, TXID);
    if (f) { found = f; break; }
  }
  if (found) break;
}

if (!found) {
  const out = { verdict: "NOT-INDEXED", txid: TXID, triedNodes, detail: "אף צומת לא החזיר את ה-tx, או שהוא לא נושא את ה-op שלנו — נסיון-חוזר מותר (אינו מיסמאץ')" };
  if (flag("json")) console.log(JSON.stringify(out, null, 2));
  else console.log(`NOT-INDEXED — ${out.detail} (נסה --chain ספציפי)`);
  process.exit(2);
}

const expects: Expectation[] = [
  ...manual,
  ...expectationsFromAnchors(ANCHORS_PATH, TXID),
  ...expectationsFromDb(DB_PATH, found.payload.height),
];

/* 2) השוואה — ביט מול ביט על stateRoot (+height כשיש) + merkleRoot מול db */
const comparisons = expects.map((e) => {
  const rootOk = e.stateRoot !== undefined && found!.payload.stateRoot === e.stateRoot;
  const heightOk = e.height === undefined || found!.payload.height === e.height;
  const merkleOk = e.merkleRoot === undefined || found!.payload.merkleRoot === e.merkleRoot;
  return {
    source: e.source,
    pass: rootOk && heightOk && merkleOk,
    detail: `stateRoot ${rootOk ? "שווה" : "שונה"}${e.height !== undefined ? ` · height ${heightOk ? "שווה" : "שונה"}` : ""}${e.merkleRoot !== undefined ? ` · merkleRoot ${merkleOk ? "שווה" : "שונה"}` : ""}`,
  };
});

const structural = {
  protocolKnown: found.payload.protocol === "saos-dex/v1",
  actionKnown: found.payload.action === "chain-seal",
  stateRootHex: isHex64(found.payload.stateRoot),
  merkleHex: found.payload.merkleRoot === undefined || isHex64(found.payload.merkleRoot),
  authorized: found.accounts.length > 0,
};
const structuralOk = Object.values(structural).every(Boolean);

let verdict: "VERIFIED" | "MISMATCH" | "SELF-REPORT";
if (comparisons.some((c) => c.pass)) verdict = "VERIFIED";
else if (comparisons.length > 0) verdict = "MISMATCH";
else verdict = "SELF-REPORT";

const out = {
  verdict,
  txid: TXID,
  chain: found.chain,
  node: found.node,
  blockNum: found.blockNum,
  accounts: found.accounts,
  payload: found.payload,
  structural,
  comparisons,
  expectationsSources: expects.map((e) => e.source),
  generatedAt: new Date().toISOString(),
  note: verdict === "SELF-REPORT"
    ? "העדות נקראה מהשרשרת ועומדת בבדיקה-מבנית, אך לא נמצא מקור-אמת מקומי להשוואה — אין VERIFIED בלי צד-השוואה (כנות)"
    : undefined,
};

if (flag("json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`VERIFY-ANCHOR · פסק-דין: ${verdict}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`txid:      ${TXID}`);
  console.log(`שרשרת:     ${found.chain} · צומת ${new URL(found.node).host} · בלוק ${found.blockNum ?? "?"}`);
  console.log(`חותמים:    ${found.accounts.join(", ") || "(אף אחד — רשות לא קשורה)"}`);
  console.log(`פרוטוקול:  ${found.payload.protocol ?? "?"} · פעולה: ${found.payload.action ?? "?"}`);
  console.log(`גובה:      h${found.payload.height ?? "?"}${found.payload.sealFrom !== undefined ? ` (חלון מ-h${found.payload.sealFrom}, ${found.payload.leaves ?? "?"} עלים)` : ""}`);
  console.log(`stateRoot: ${found.payload.stateRoot ?? "?"}`);
  console.log(`merkle:    ${found.payload.merkleRoot ?? "(לא נכלל)"}`);
  console.log(`digest:    ${found.payload.digest ?? "(לא נכלל)"}`);
  console.log(`מבני:      ${structuralOk ? "עובר" : `נכשל (${JSON.stringify(structural)})`}`);
  if (comparisons.length === 0) {
    console.log("השוואות:   אין מקור-אמת מקומי — הפסק SELF-REPORT (אימות דורש השוואה)");
    console.log(`           טיפ: --height/--root, --anchors state/anchors.json, או --db db/dex.db`);
  } else {
    for (const c of comparisons) console.log(`השוואה:    [${c.pass ? "✔" : "✘"}] ${c.source} — ${c.detail}`);
  }
  console.log("═══════════════════════════════════════════════════════════");
}
process.exit(verdict === "VERIFIED" ? 0 : verdict === "MISMATCH" ? 1 : 2);
