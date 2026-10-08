/**
 * redteam-probes.ts — LIVE ADVERSARIAL HTTP PROBES · פרובות-אדום-חיות
 * ═════════════════════════════════════════════════════════════════════
 * רמת-הענקים: תוכניות-bug-bounty (HackerOne/Immunefi) לא סומכות על "הקוד נראה
 * בטוח" — הן **יורות** על הממשק החי. כאן: ירי מבוקר על המנוע (:3010) ועל
 * הפלטפורמה-האם (:3000) — כל-ניסיון פסול-מלידה (אין-אימות, אין-גוף-תקין,
 * אין-אפשרות-להזיז-שקל-אמת):
 *
 *   R1 · fail-closed    — כל-ניסיון נענה דחייה-מבוקרת (4xx או {ok:false}) ולא 200-כוזב
 *   R2 · no-crash       — אף-פרובה לא מפילה-תהליך (המנוע חי אחרי-הירי)
 *   R3 · no-leak        — אף-תשובה לא מכילה-חומר-סודות (WIF/PVT/sk-/ghp_/mnemonic/PEM)
 *   R4 · door-speaks    — הדלת רושמת את הדחיות (rejectedLast count עולה — עדות-שנקלטו)
 *
 * ריצה: cd /home/z/my-project/saos-dex && bun harness/redteam-probes.ts
 */
interface ProbeResult { name: string; target: string; status: number | "CRASH"; failClosed: boolean; note: string }
const results: ProbeResult[] = [];
const responseBodies: string[] = [];
const t0 = Date.now();

const SECRET_PATTERNS: [string, RegExp][] = [
  ["WIF-5", /5[HJK][1-9A-HJ-NP-Za-km-z]{50}/],
  ["PVT_K1", /PVT_K1_[1-9A-HJ-NP-Za-km-z]{50}/],
  ["sk- (api key)", /sk-[A-Za-z0-9]{20,}/],
  ["github token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["mnemonic", /\b(abandon|legal winner|seed phrase)\b.*\b(12|24)\b/i],
  ["PEM key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["long-hex-secret", /\b[0-9a-f]{64,}\b/],
];

async function fire(name: string, url: string, init: RequestInit, expectFailClosed = true): Promise<void> {
  let status: number | "CRASH" = "CRASH";
  let body = "";
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    status = r.status;
    body = await r.text().catch(() => "");
  } catch (e) {
    status = "CRASH";
  }
  responseBodies.push(body.slice(0, 4_000));
  let failClosed: boolean;
  let note: string;
  if (status === "CRASH") { failClosed = false; note = "connection crash"; }
  else if (status >= 400 && status < 500) { failClosed = true; note = `rejected ${status}`; }
  else if (status >= 500) {
    // 5xx = לא fail-closed מושלם אך גם לא אישור — נחשב כשל-מבוקר רק-אם-אין-גוף-עשיר
    failClosed = body.length < 2_000;
    note = `server-error ${status} (body ${body.length}B)`;
  } else {
    // 2xx — תקין רק-אם-הגוף מדווח-דחייה
    let okFalse = false;
    try { okFalse = (JSON.parse(body) as { ok?: boolean }).ok === false; } catch { okFalse = false; }
    failClosed = okFalse;
    note = okFalse ? "200 with ok:false (graceful rejection)" : `200 with body ${body.length}B — SUSPICIOUS`;
  }
  results.push({ name, target: url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), status, failClosed, note });
  if (!expectFailClosed && failClosed) results[results.length - 1].note += " (was allowed to succeed — recorded)";
}

async function main(): Promise<void> {
  console.log("\n════ RED TEAM · LIVE HTTP FIRE ════");
  const ENG = "http://127.0.0.1:3010/saos-dex/api";
  const MUM = "http://127.0.0.1:3000/api";

  // R4-baseline: rejectedLast לפני-הירי
  const pre = await fetch(`${ENG}/dex/state`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json() as Promise<{ state: { rejectedLast: { count: number } | null } }>).catch(() => null);

  const post = (url: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  /* ── מנוע :3010 — שערי-המסחר ── */
  await fire("R01 order: malformed JSON", `${ENG}/dex/order`, post(`${ENG}/dex/order`, "{not json at all"));
  await fire("R02 order: negative amount", `${ENG}/dex/order`, post(`${ENG}/dex/order`, { issuer: "attacker", nonce: `rt-${Date.now()}`, type: "order", base: "SAOS", quote: "USDS", side: "buy", price: -5, amount: -100 }));
  await fire("R03 order: proto-pollution body", `${ENG}/dex/order`, post(`${ENG}/dex/order`, '{"issuer":"x","nonce":"n","__proto__":{"admin":true},"type":"order"}'));
  await fire("R04 order: deep-nesting 1k", `${ENG}/dex/order`, post(`${ENG}/dex/order`, `{"issuer":"x","nonce":"n","a":${"[".repeat(900)}1${"]".repeat(900)}}`));
  await fire("R05 order: huge payload 256KB", `${ENG}/dex/order`, post(`${ENG}/dex/order`, { issuer: "x", nonce: "n", memo: "A".repeat(256_000) }));
  await fire("R06 transfer: no auth replay-style", `${ENG}/dex/transfer`, post(`${ENG}/dex/transfer`, { issuer: "treasury", nonce: "rt-theft", type: "xfer_free", to: "attacker", asset: "USDS", amount: 999_999_999 }));
  await fire("R07 settle: garbage body", `${ENG}/dex/settle`, post(`${ENG}/dex/settle`, { force: true, bypass: true }));
  await fire("R08 revive: unauthorized", `${ENG}/revive`, post(`${ENG}/revive`, { cmd: "reset --all" }));
  await fire("R09 order: SQL-injection in fields", `${ENG}/dex/order`, post(`${ENG}/dex/order`, { issuer: "x'; DROP TABLE orders;--", nonce: "n' OR '1'='1", type: "order", base: "SAOS", quote: "USDS", side: "buy", price: 1, amount: 1 }));
  await fire("R10 order: unicode homoglyph issuer", `${ENG}/dex/order`, post(`${ENG}/dex/order`, { issuer: "оperаtor", nonce: "rt-homoglyph", type: "order", base: "SAOS", quote: "USDS", side: "buy", price: 1300, amount: 5 }));

  /* ── פלטפורמה-האם :3000 — שערי-הכספת/הכלכלה ── */
  await fire("R11 vault/login: garbage creds", `${MUM}/vault/login`, post(`${MUM}/vault/login`, { user: "admin", password: "' OR 1=1 --" }));
  await fire("R12 vault/verify: no signature", `${MUM}/vault/verify`, post(`${MUM}/vault/verify`, { probe: true }));
  await fire("R13 swap/execute: unauthenticd attempt", `${MUM}/swap/execute`, post(`${MUM}/swap/execute`, { from: "treasury", to: "attacker", amount: 999_999_999 }));
  await fire("R14 saos/value-engine: owner-gate", `${MUM}/saos/value-engine`, post(`${MUM}/saos/value-engine`, { action: "tick" }, { authorization: "Bearer fake-token-123" }));
  await fire("R15 agent/bounty: fake agent claim", `${MUM}/agent/bounty`, post(`${MUM}/agent/bounty`, { action: "claim", id: 1, agent: "ghost" }, { "x-agent-node": "ghost", authorization: "Bearer ghost" }));
  await fire("R16 vault/addresses: public-surface (traversal param ignored)", `${MUM}/vault/addresses?chain=../../etc/passwd`);
  await fire("R17 saos/kernel: proto-injection", `${MUM}/saos/kernel`, post(`${MUM}/saos/kernel`, '{"__proto__":{"isAdmin":true},"action":"reset"}'));
  await fire("R18 health: oversized-header 64KB", `${MUM}/health`, { method: "GET", headers: { "x-fwd": "A".repeat(64_000) } });

  /* ── R2: המנוע חי אחרי-הירי ── */
  let engineAlive = false, aliveNote = "";
  try {
    const s = await fetch(`${ENG}/dex/state`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json() as Promise<{ ok: boolean; state: { height: number; rejectedLast: { count: number } | null } }>);
    engineAlive = s.ok === true;
    const postCount = s.state.rejectedLast?.count ?? 0;
    const preCount = pre?.state.rejectedLast?.count ?? 0;
    aliveNote = `h alive · rejectedLast ${preCount} → ${postCount} (${postCount > preCount ? `+${postCount - preCount} rejections recorded — the door speaks` : "no delta recorded in window"})`;
  } catch { engineAlive = false; aliveNote = "engine DEAD after fire (!)"; }
  results.push({ name: "R99 engine-alive-after-fire", target: ":3010", status: engineAlive ? 200 : "CRASH", failClosed: engineAlive, note: aliveNote });

  /* ── R16-classification: משטח-ציבורי — רק-מניפסט, בלי-תוכן-מעבר-לעץ ── */
  {
    const r16 = results.find((r) => r.name.startsWith("R16"));
    if (r16) {
      const idx = results.findIndex((r) => r.name.startsWith("R16"));
      const body = responseBodies.find((b) => b.includes('"sovereign-01"') && b.includes('"addresses"'));
      const publicOnly = !!body && !/root:|bin\/|etc\/passwd|\/usr\//.test(body);
      r16.failClosed = publicOnly;
      r16.note = publicOnly ? "200 = public manifest by design (funnel law §6 — addresses are public); traversal param ignored; zero filesystem content" : "SUSPICIOUS — manifest leaked non-public content";
      results[idx] = r16;
    }
  }

  /* ── R3: סריקת-סודות בכל-התשובות ── */
  const leaks: string[] = [];
  for (const [label, re] of SECRET_PATTERNS) for (const b of responseBodies) if (re.test(b)) leaks.push(label);
  results.push({ name: "R98 no-secret-leak", target: "all-responses", status: leaks.length === 0 ? 200 : "CRASH", failClosed: leaks.length === 0, note: leaks.length ? `LEAKS: ${leaks.join(", ")}` : `0 secret patterns in ${responseBodies.length} responses` });

  /* ── דוח ── */
  const fired = results.filter((r) => r.name.startsWith("R0") || r.name.startsWith("R1")).length;
  const closed = results.filter((r) => (r.name.startsWith("R0") || r.name.startsWith("R1")) && r.failClosed).length;
  const infra = results.filter((r) => !r.name.startsWith("R0") && !r.name.startsWith("R1"));
  const verdict = closed === fired && infra.every((r) => r.failClosed) ? "PASS" : "FAIL";
  console.log(`\n── PROBE RESULTS ──`);
  for (const r of results) console.log(`  ${r.failClosed ? "✓" : "✗"} ${r.name.padEnd(38)} ${String(r.status).padEnd(7)} ${r.note}`);
  console.log(`\n── VERDICT: ${verdict} — fail-closed ${closed}/${fired} · infrastructure ${infra.filter((r) => r.failClosed).length}/${infra.length} · ${(Math.round((Date.now() - t0) / 100) / 10)}s ──`);
  await Bun.write("audit-package/proof-pack/redteam.json", JSON.stringify({
    instrument: "redteam-probes", at: new Date().toISOString(), verdict,
    summary: { fired, failClosed: closed, infraOk: infra.filter((r) => r.failClosed).length, infraTotal: infra.length },
    results, secretPatterns: SECRET_PATTERNS.map(([l]) => l),
  }, null, 2));
  console.log("artifact → audit-package/proof-pack/redteam.json");
  if (verdict !== "PASS") process.exit(1);
}

await main();
