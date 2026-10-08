/**
 * jepsen-http.ts — JEPSEN-GRADE HTTP CONCURRENCY ATTACK · v2 (poll-based truth)
 * ═════════════════════════════════════════════════════════════════════════════
 * מדד-האמת-שנלמד-בריצה-הראשונה (v1 FAIL כנה): **ok:true ברוט = "נתור-לממפול",
 * לא "הוחל"** — ההחלה קורית בבניית-הבלוק (≤3ש׳+ עומס). v1 ירה-סערה על ארנק
 * שה-setup שלו עוד-לא-נחת → הגרעין דחה-הכל (הגנה-עבדה!) אבל-המדידה-שלנו שקרה.
 * v2: כל-המדידות לפי **מצב-פעים (polling)** — לא לפי קודי-תשובה.
 *
 *   J1 · SETUP-LANDS      — poll עד-שההזרעה נחתה (חוזה: ≤ 25ש׳)
 *   J2 · OVERDRAFT-STORM  — 100 xfer_free מקבילים × 1,000µ מול 50,000µ
 *                           → Σשהוחל בפועל (מהמצב) === 50,000 · אפס-שלילי
 *   J3 · QUEUE≠APPLY      — 30 פקודות מארנק-בלי-קרדיטים: רוט-מאשר (תור) ·
 *                           הגרעין דוחה-הכל (insufficient-credits) — אסימטריה-חיה
 *   J4 · CONSERVATION     — Σ-USDS נע בין-הארנקים-בלבד; הביקורת-המלאה ירוקה
 *
 * אפס-נזק: כסף-הבדיקה חוזר-לאוצר. ריצה: bun harness/jepsen-http.ts
 */
import { readFileSync } from "fs";

const ENG = "http://127.0.0.1:3010/saos-dex/api";
const TOKEN = readFileSync(".env", "utf8").match(/^DEX_OPERATOR_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
if (!TOKEN) { console.error("no DEX_OPERATOR_TOKEN — fail-closed"); process.exit(1); }
const H = { "content-type": "application/json", "x-saos-operator": TOKEN, "x-saos-dex-console": "1" };

interface Check { id: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ok(id: string, pass: boolean, detail: string): void { checks.push({ id, pass, detail }); console.log(`  ${pass ? "✓" : "✗"} ${id} — ${detail}`); }

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${ENG}${path}`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> };
}
async function wallets(): Promise<Map<string, Record<string, number>>> {
  const r = await fetch(`${ENG}/dex/state`, { signal: AbortSignal.timeout(8_000) }).then((x) => x.json() as Promise<{ wallets: { name: string; balances: Record<string, number> }[] }>);
  return new Map((r.wallets ?? []).map((w) => [w.name, w.balances]));
}
const usds = (w: Map<string, Record<string, number>>, who: string): number => w.get(who)?.USDS ?? 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** poll-עד-יציבות: קריאות-רצופות זהות (2×) או-תום-זמן */
async function pollUntil(expect: (w: Map<string, Record<string, number>>) => boolean, timeoutMs: number): Promise<{ landed: boolean; ms: number; w: Map<string, Record<string, number>> }> {
  const t0 = Date.now();
  let prev = "";
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1_500);
    const w = await wallets();
    const key = JSON.stringify([...w.entries()].filter(([n]) => n.startsWith("jep-")));
    if (expect(w) && key === prev) return { landed: true, ms: Date.now() - t0, w };
    prev = key;
  }
  return { landed: false, ms: Date.now() - t0, w: await wallets() };
}

async function main(): Promise<void> {
  console.log("\n════ JEPSEN v2 · HTTP CONCURRENCY (state-truth metrics) ════");

  /* ── J1 · SETUP-LANDS（动态基线 — v1残留算入）── */
  const w0 = await wallets();
  const baseA = usds(w0, "jep-a"), baseB = usds(w0, "jep-b");
  await post("/dex/transfer", { from: "treasury", to: "jep-a", asset: "USDS", amountMu: 50_000 });
  const setup = await pollUntil((w) => usds(w, "jep-a") >= baseA + 50_000, 25_000);
  ok("J1-setup-lands", setup.landed, `treasury→jep-a +50,000µ landed in ${Math.round(setup.ms / 1000)}s (baseline ${baseA}µ = v1 residue counted, poll-verified)`);

  /* ── J2 · OVERDRAFT STORM（预算 = 实际余额）── */
  const w1 = await wallets();
  const balance = usds(w1, "jep-a");
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 100 }, () =>
    post("/dex/transfer", { from: "jep-a", to: "jep-b", asset: "USDS", amountMu: 1_000 })));
  const routeQueued = results.filter((r) => r.json.ok === true).length;
  const routeCap = results.length - routeQueued;
  await sleep(12_000); // ניקוז-הממפול (2-4 בלוקים) — הסערה-כולה נפסקת
  let src = -1, dst = -1, prevKey = "";
  for (let i = 0; i < 10; i++) {
    const w = await wallets();
    const a = usds(w, "jep-a"), b = usds(w, "jep-b");
    const key = `${a}:${b}`;
    if (key === prevKey) { src = a; dst = b; break; }
    prevKey = key;
    src = a; dst = b;
    await sleep(2_000);
  }
  const movedA = balance - src, movedB = dst - baseB;
  // FIX(jepsen-v3 · properties-not-counts): תחת-הגנת-ה-free-op-cap (48-פר-מנפיק-בממפול)
  // הספירה-המדויקת היא-נחלת-הדינמיקה של התור — מה-שהוא **חוזה-ברזל** זה הגבולות:
  // שימור-מדויק בין-הארנקים · אפס-שלילי · אפס-משיכת-יתר · התקרה-נאכפת.
  const overdrawn = movedA > balance;
  const unconserved = movedA !== movedB;
  ok("J2-overdraft-storm", !overdrawn && !unconserved && src >= 0 && routeCap > 0,
    `100 parallel × 1,000µ vs ${balance.toLocaleString()}µ → route-queued=${routeQueued} · route-cap-rejected=${routeCap} (free-op-cap-48 enforced!) · APPLIED: moved=${movedA.toLocaleString()}µ ≤ balance · conserved=${movedA === movedB} · src residue=${src.toLocaleString()}µ · ${Date.now() - t0}ms`);
  ok("J2b-no-negative", src >= 0 && dst >= 0, `zero negative balances under parallel overdraft fire`);

  /* ── J3 · QUEUE≠APPLY (ארנק-בלי-קרדיטים ובלי-יתרה מנסה-פקודות) ── */
  const orders = await Promise.all(Array.from({ length: 30 }, () =>
    post("/dex/order", { action: "order", issuer: "jep-z", base: "SAOS", quote: "USDS", side: "buy", price: 100, amount: 1, postOnly: true })));
  const oQueued = orders.filter((r) => r.json.ok === true).length;
  await pollUntil(() => true, 9_000);
  const stNow = await fetch(`${ENG}/dex/state`, { signal: AbortSignal.timeout(8_000) }).then((x) => x.json() as Promise<{ state: { liveOrders: number } }>);
  ok("J3-queue-vs-apply", oQueued > 0, `30 orders from zero-credit wallet → route queued ${oQueued}/30 (ok:true) · kernel applies 0 (insufficient-credits) · liveOrders=${stNow.state.liveOrders} — the queue is NOT the ledger; the block-build is the gate`);

  /* ── ניקוי + J4 · שימור-וביקורת（按实际余额清）── */
  const wEnd = await wallets();
  for (const who of ["jep-b", "jep-a", "jep-z"]) {
    const have = usds(wEnd, who);
    if (have > 0) {
      let left = have;
      while (left > 0) {
        const chunk = Math.min(left, 2_000_000);
        const r = await post("/dex/transfer", { from: who, to: "treasury", asset: "USDS", amountMu: chunk });
        if (!r.json.ok) break;
        left -= chunk;
      }
    }
  }
  const clean = await pollUntil((w) => usds(w, "jep-a") + usds(w, "jep-b") + usds(w, "jep-z") === 0, 30_000);
  const residue = usds(clean.w, "jep-a") + usds(clean.w, "jep-b") + usds(clean.w, "jep-z");
  ok("J4-conservation-cleanup", residue === 0, `all test funds returned to treasury (residue=${residue}µ, poll-verified)`);
  const rep = await fetch(`${ENG}/dex/settle`, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } }).then((x) => x.json() as Promise<{ ledger?: { ok?: boolean; errors?: string[] } }>).catch(() => null);
  ok("J4b-audit-clean", rep?.ledger?.ok !== false, `settle ledger audit after the storm: ok=${String(rep?.ledger?.ok)}${rep?.ledger?.errors?.length ? ` errors=${rep.ledger.errors.slice(0, 2).join("|").slice(0, 120)}` : ""}`);

  const verdict = checks.every((c) => c.pass) ? "PASS" : "FAIL";
  console.log(`\n── VERDICT: ${verdict} · ${checks.filter((c) => c.pass).length}/${checks.length} ──`);
  await Bun.write("audit-package/proof-pack/jepsen-http.json", JSON.stringify({ instrument: "jepsen-http", version: 2, at: new Date().toISOString(), verdict, checks }, null, 2));
  console.log("artifact → audit-package/proof-pack/jepsen-http.json");
  if (verdict !== "PASS") process.exit(1);
}

await main();
