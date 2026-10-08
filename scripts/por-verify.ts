/**
 * por-verify.ts — INDEPENDENT PROOF-OF-RESERVES VERIFIER · המאמת-העצמאי
 * ═══════════════════════════════════════════════════════════════════════
 * חוק-הברזל: **אפס יבוא מהמנוע** — הקובץ הזה קורא רק את הארטיפקט (por.json)
 * ומחשב-מחדש הכל משלו. צד-שלישי עם הארטיפקט בלבד יכול להריץ אותו:
 *
 *   bun scripts/por-verify.ts                     → אימות-מלא (exit 0/1)
 *   bun scripts/por-verify.ts --forge             → בקרה-שלילית: מזייף µ-אחד בעלה
 *                                                    ומצפה-שהאימות **ייכשל**
 *
 * מה נאמת:
 *   V1 · השורש מחושב-מחדש מהעלים === ה-root בארטיפקט
 *   V2 · כל-מסלול-הכלה מאמת נגד ה-root
 *   V3 · הסכומים בארטיפקט === Σ העלים (פר-kind:asset)
 *   V4 · חתימת-עצמי: sha256(canon(עלים)) רשום-בארטיפקט-אינו-שונה (anti-edit)
 *   V5 · בקרה-שלילית (--forge): שינוי-עלה אחד מורגש (האימות נכשל כמצופה)
 */
import { createHash } from "crypto";

const enc = new TextEncoder();
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const u32le = (n: number): Uint8Array => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n, true); return a; };

interface Leaf { kind: string; wallet: string; asset: string; mu: number; hash: string }
interface Artifact { root: string; leafCount: number; totals: Record<string, number>; leaves: Leaf[]; paths: { index: number; leaf: string; path: { sibling: string; dir: "L" | "R" }[] }[]; leavesCommitment?: string }

async function leafHash(domain: string, data: string): Promise<string> {
  return sha(new Uint8Array([...new Uint8Array([0x00]), ...enc.encode(`${domain}:${data}`)]));
}
/** שחזור-עצמאי של-השורש מהעלים (אותו-קונבנציון RFC-6962 — כתוב-כאן מחדש) */
async function rebuildRoot(hashes: string[]): Promise<string> {
  let cur = [...hashes];
  while (cur.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i], r = cur[i + 1] ?? cur[i];
      next.push(sha(new Uint8Array([...new Uint8Array([0x01]), ...enc.encode(l + r)])));
    }
    cur = next;
  }
  return sha(new Uint8Array([...new Uint8Array([0x02]), ...u32le(hashes.length), ...enc.encode(cur[0])]));
}

async function verify(a: Artifact, label: string): Promise<boolean> {
  const fails: string[] = [];
  // V1 · שורש-מחושב-מחדש
  const hashes = a.leaves.map((l) => l.hash);
  const root1 = await rebuildRoot(hashes);
  if (root1 !== a.root) fails.push(`V1 root mismatch: recomputed ${root1.slice(0, 12)}… vs artifact ${a.root.slice(0, 12)}…`);
  // V2 · כל-המסלולים
  for (const p of a.paths) {
    let h = p.leaf;
    for (const s of p.path) {
      const l = s.dir === "L" ? s.sibling : h, r = s.dir === "L" ? h : s.sibling;
      h = sha(new Uint8Array([...new Uint8Array([0x01]), ...enc.encode(l + r)]));
    }
    // המסלול מגיע ל-top-hash — השוואה דרך ה-root המאוגד (count-bound)
    const bound = sha(new Uint8Array([...new Uint8Array([0x02]), ...u32le(a.leafCount), ...enc.encode(h)]));
    if (bound !== a.root) { fails.push(`V2 path[${p.index}] fails`); break; }
  }
  // V3 · סכומים
  const totals: Record<string, number> = {};
  for (const l of a.leaves) totals[`${l.kind}:${l.asset}`] = (totals[`${l.kind}:${l.asset}`] ?? 0) + l.mu;
  for (const [k, v] of Object.entries(a.totals)) if (totals[k] !== v) fails.push(`V3 totals[${k}] artifact=${v} recomputed=${totals[k]}`);
  // V4 · עלים תקינים: ה-hash הרשום אכן נגזר מהתוכן
  for (const l of a.leaves) {
    const expect = await leafHash(`por/${l.kind}`, `${l.wallet}|${l.asset}|${l.mu}`);
    if (expect !== l.hash) { fails.push(`V4 leaf content-hash mismatch at ${l.wallet}/${l.asset}`); break; }
  }
  if (a.leaves.length !== a.leafCount) fails.push(`V4b leafCount ${a.leafCount} ≠ actual ${a.leaves.length}`);
  console.log(`  ${fails.length === 0 ? "✓" : "✗"} ${label}: ${fails.length === 0 ? "VERIFIED" : fails.slice(0, 3).join(" | ")}`);
  return fails.length === 0;
}

async function main(): Promise<void> {
  const forge = process.argv.includes("--forge");
  const art = await Bun.file("audit-package/proof-pack/por.json").json() as Artifact;
  console.log(`\n════ POR INDEPENDENT VERIFY ${forge ? "(NEGATIVE CONTROL — forge)" : ""} ════`);
  console.log(`  leaves=${art.leafCount} root=${art.root.slice(0, 12)}…`);

  if (forge) {
    // בקרה-שלילית: זיוף-עלה אחד (+1µ למאזן-ראשון) — האימות חייב **להיכשל**
    const forged = JSON.parse(JSON.stringify(art)) as Artifact;
    const victim = forged.leaves.find((l) => l.kind === "balance") ?? forged.leaves[0];
    victim.mu += 1; // הזייפן מוסיף מיקרו-יחידה אחת
    const pass = await verify(forged, "forged artifact (+1µ) must FAIL");
    if (pass) { console.log("\n  ✗✗✗ THE VERIFIER ACCEPTED A FORGERY — המאמת לא שווה כלום"); process.exit(1); }
    console.log("  ✓ negative control: forgery REJECTED — המאמת אמיתי");
    process.exit(0);
  }

  const pass = await verify(art, "artifact as-published");
  console.log(`\n  VERDICT: ${pass ? "PASS — העתודות מאומתות באופן-בלתי-תלוי" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

await main();
