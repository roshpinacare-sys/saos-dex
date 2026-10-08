/**
 * por-ceremony.ts — PROOF-OF-RESERVES CEREMONY · טקס-הוכחת-העתודות
 * ═══════════════════════════════════════════════════════════════════
 * רמת-הענקים: Coinbase ו-Binance מפרסמות Proof-of-Reserves — מרקל-עץ של כל-יתרה
 * שמאפשר לכל-צד-שלישי לאמת שהיתרה-שלו נכללת-בספר, בלי-לחשוף-הכל ובלי-לסמוך-על-
 * הפלטפורמה. אנחנו עושים את-זה על-הספר-הריבוני כולו:
 *
 *   · עלים: כל-יתרת-ארנק×נכס (µ) + כל-יתרת-קרדיט-דלק — מהסנאפשוט-הקנוני (הארטיפקט
 *     ש-state-push מפרסם לגיט — אותו-קובץ שהציבור יכול להשוות).
 *   · סכמת-העץ: RFC-6962-style (leaf=sha256(0x00‖), node=sha256(0x01‖), root=sha256(0x02‖uint32le(count)‖top))
 *     — אותו-קונבנציון של src/lib/saos/merkle.ts בפלטפורמה-האם (נגד CVE-2012-2459).
 *   · הארטיפקט: audit-package/proof-pack/por.json — root + כל-העלים + totals +
 *     stateRoot של המצב-הקנוני + גובה-החי (צליבה).
 *   · האימות: scripts/por-verify.ts — מאמת **בלי-יבוא-אחד מהמנוע** (רק את הארטיפקט).
 *
 * ריצה: cd /home/z/my-project/saos-dex && bun scripts/por-ceremony.ts
 */
import { stateRootOf } from "../src/lib/dex/canonical";

const enc = new TextEncoder();
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const u32le = (n: number): Uint8Array => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n, true); return a; };

/** RFC-6962-style: בניית-עץ + מסלולי-הכלה לכל-עלה */
async function merkleTree(leafHashes: string[]): Promise<{ root: string; levels: string[][] }> {
  if (leafHashes.length === 0) throw new Error("no-leaves");
  const levels: string[][] = [[...leafHashes]];
  let cur = levels[0];
  while (cur.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i], r = cur[i + 1] ?? cur[i]; // עלה-אחרון-אי-זוגי משוכפל
      next.push(await sha256Hex(new Uint8Array([...new Uint8Array([0x01]), ...enc.encode(l + r)])));
    }
    levels.push(next); cur = next;
  }
  const root = await sha256Hex(new Uint8Array([...new Uint8Array([0x02]), ...u32le(leafHashes.length), ...enc.encode(cur[0])]));
  return { root, levels };
}
async function leafHash(domain: string, data: string): Promise<string> {
  return sha256Hex(new Uint8Array([...new Uint8Array([0x00]), ...enc.encode(`${domain}:${data}`)]));
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const snapFile = await Bun.file("db/state-snapshot.json").json() as { state: Record<string, unknown>; savedAt?: string };
  const st = snapFile.state as { height: number; balances: Record<string, Record<string, number>>; credits: Record<string, number>; locked: Record<string, Record<string, number>>; pools: Record<string, { a: string; ra: number; b: string; rb: number }> };
  const stateRoot = stateRootOf(st);

  // צליבה-מול-המנוע-החי (הארטיפקט נושא גם-את-גובה-החי — המאמת העצמאי יצליב)
  const eng = await fetch("http://127.0.0.1:3010/saos-dex/api/dex/state", { signal: AbortSignal.timeout(8_000) }).then((r) => r.json() as Promise<{ ok: boolean; state: { height: number; stateRoot: string } }>).catch(() => null);
  if (!eng?.ok) { console.error("engine unreachable — טקס-ה-PoR דורש-צליבה-חיה"); process.exit(1); }

  /* ── העלים ── */
  interface Leaf { kind: string; wallet: string; asset: string; mu: number; hash: string }
  const leaves: Leaf[] = [];
  const addLeaf = async (kind: string, wallet: string, asset: string, mu: number): Promise<void> => {
    if (!Number.isSafeInteger(mu) || mu === 0) return; // אפס = אין-טענה
    leaves.push({ kind, wallet, asset, mu, hash: await leafHash(`por/${kind}`, `${wallet}|${asset}|${mu}`) });
  };
  for (const [w, wallet] of Object.entries(st.balances)) for (const [a, mu] of Object.entries(wallet)) await addLeaf("balance", w, a, mu);
  for (const [w, mu] of Object.entries(st.credits)) await addLeaf("credit", w, "FUEL", mu);
  for (const [w, wallet] of Object.entries(st.locked ?? {})) for (const [a, mu] of Object.entries(wallet)) await addLeaf("locked", w, a, mu);
  for (const [k, p] of Object.entries(st.pools)) { await addLeaf("pool", k, p.a, p.ra); await addLeaf("pool", k, p.b, p.rb); }

  leaves.sort((x, y) => (x.hash < y.hash ? -1 : 1)); // קנוני — אותו-סט → אותו-שורש תמיד
  const hashes = leaves.map((l) => l.hash);
  const { root, levels } = await merkleTree(hashes);

  // מסלולי-הכלה
  const paths = hashes.map((h, idx) => {
    const path: { sibling: string; dir: "L" | "R" }[] = [];
    let i = idx;
    for (let lv = 0; lv < levels.length - 1; lv++) {
      const sib = i % 2 === 0 ? i + 1 : i - 1;
      const level = levels[lv];
      path.push({ sibling: level[Math.min(sib, level.length - 1)], dir: i % 2 === 0 ? "R" : "L" });
      i = Math.floor(i / 2);
    }
    return { index: idx, leaf: h, path };
  });

  // סכומים פר-נכס (המאמת מחשב אותם-מחדש מהעלים)
  const totals: Record<string, number> = {};
  for (const l of leaves) totals[`${l.kind}:${l.asset}`] = (totals[`${l.kind}:${l.asset}`] ?? 0) + l.mu;

  const artifact = {
    instrument: "proof-of-reserves",
    version: 1,
    generatedAt: new Date().toISOString(),
    ceremonyMs: 0,
    chain: {
      snapshotHeight: st.height,
      snapshotStateRoot: stateRoot,
      liveHeight: eng.state.height,
      liveStateRoot: eng.state.stateRoot,
      snapshotLag: eng.state.height - st.height,
    },
    scheme: "rfc6962-style leaf=H(0x00||data) node=H(0x01||l||r) root=H(0x02||u32le(count)||top) — CVE-2012-2459-safe",
    leafCount: leaves.length,
    root,
    totals,
    leaves,
    paths,
  };
  artifact.ceremonyMs = Date.now() - t0;
  await Bun.write("audit-package/proof-pack/por.json", JSON.stringify(artifact, null, 2));
  console.log(`\n════ PROOF-OF-RESERVES CEREMONY ════`);
  console.log(`  snapshot h=${st.height} (stateRoot ${stateRoot.slice(0, 12)}…) · live h=${eng.state.height} (lag ${eng.state.height - st.height})`);
  console.log(`  leaves=${leaves.length} · root=${root}`);
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [k, v] of top) console.log(`    ${k.padEnd(22)} ${v.toLocaleString("en-US")} µ`);
  console.log(`  artifact → audit-package/proof-pack/por.json (${Math.round((Date.now() - t0) / 100) / 10}s)`);
}

await main();
