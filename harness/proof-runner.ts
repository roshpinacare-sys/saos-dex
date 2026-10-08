/**
 * proof-runner.ts — THE SELF-HOSTED CONTINUOUS PROOF RUNNER · רץ-ההוכחה-הרציף (מכשיר #16)
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXEC-CD-36 · התשובה-המוסדית-לשאלה "איך הענקים עושים את זה יותר טוב?":
 *   הענקים לא מוכיחים-פעם-אחת — הם מוכיחים **ברציפות** (CI-gate על כל-קומיט).
 *   ה-CI-המתארח של GitHub אדום-מאז-2026-10-05 (אזלו-דקות-חינם — מתועד
 *   SAOS-CI-OUTAGE-2026-10-06). התשובה-שלהם-לזה: self-hosted runner. זה מה שהמכשיר
 *   הזה — ההוכחה רצה-כאן, מקומית, במחזוריות, וכל-ריצה כותבת-שורת-אמת-לפנקס.
 *
 * בכל-ריצה (--once):
 *   1. חיווט-חי: מנוע 3010 (height/root) · נמלי-הערימה 3000/3010/3003/3012/3042
 *   2. סנכרון-גיט: HEAD מקומי מול-origin לשני-הריפו (GitHub-API; PAT לעולם לא-נדפס)
 *   3. סוללה: BMC depth-3 (אקסהוסטיבי) + fuzzer fixture (אדיברסרי) — subprocess-ים,
 *      exit-code + ארטיפקט-הם-האמת (לא-ההצהרה-שלנו)
 *   4. התראות: כללים-מדודים → alerts.jsonl (open/resolve, אפס-רעש-כפול)
 *   5. פנקס: proof-ledger.jsonl (שורה-לכל-ריצה) + latest-proof.json (מצב-נוכחי)
 *
 * כללי-התראה: engine-down · height-stale (3-ריצות-ללא-התקדמות) · proof-fail ·
 *             git-drift · snapshot-stale (>600) · port-down
 *
 * ריצה: bun harness/proof-runner.ts --once [--skip-battery] | --loop [מחזוריות-דק']
 * החלטת-מחזוריות: בידי-הקורא (instrumentation/watchdog) — SAOS_PROOF_RUNNER=off כיבוי.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;               // saos-dex/
const MOTHER = "/home/z/my-project";
const PP = new URL("../audit-package/proof-pack/", import.meta.url).pathname;
const ONCE = process.argv.includes("--once");
const LOOP = process.argv.includes("--loop");
const SKIP_BATTERY = process.argv.includes("--skip-battery");
const LOOP_MIN = Number(process.argv[process.argv.indexOf("--loop") + 1]) > 0
  ? Number(process.argv[process.argv.indexOf("--loop") + 1]) : 240;
const ENGINE = "http://127.0.0.1:3010/saos-dex/api/dex/state";
const PORTS: [string, number][] = [["mother", 3000], ["engine", 3010], ["relay", 3003], ["governor", 3042], ["legion", 3012]];

/* ── עזרים ──────────────────────────────────────────────────────────────────── */
const nowIso = (): string => new Date().toISOString();
async function probeEngine(): Promise<{ up: boolean; height: number; root: string }> {
  try {
    const r = await fetch(ENGINE, { signal: AbortSignal.timeout(8_000) });
    const j = (await r.json()) as { ok?: boolean; state?: { height?: number } } & { state?: { height?: number; } } & { root?: string } & { stateRoot?: string };
    const h = j?.state?.height;
    if (typeof h === "number") return { up: true, height: h, root: (j as { stateRoot?: string }).stateRoot ?? (j as { root?: string }).root ?? "" };
    return { up: false, height: -1, root: "" };
  } catch { return { up: false, height: -1, root: "" }; }
}
async function portUp(p: number): Promise<boolean> {
  try { const s = await Bun.connect({ hostname: "127.0.0.1", port: p, socket: { data() {}, close() {}, error() {} } }); await new Promise((r) => setTimeout(r, 30)); s.end(); return true; }
  catch { return false; }
}
function localHead(repo: string): string {
  try { return spawnSync("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim(); } catch { return ""; }
}
function patToken(): string {
  try {
    const env = readFileSync(`${MOTHER}/upload/pat.env`, "utf8");
    const m = env.match(/ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/);
    return m ? m[0] : "";
  } catch { return ""; }
}
async function gitSync(repo: string, name: string): Promise<{ repo: string; local: string; remote: string; synced: boolean | null }> {
  const local = localHead(repo);
  const tok = patToken();
  if (!tok || !local) return { repo: name, local: local.slice(0, 7), remote: "unverified", synced: null };
  try {
    const r = await fetch(`https://api.github.com/repos/roshpinacare-sys/${name}/branches/main`, { headers: { Authorization: `token ${tok}` }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { commit?: { sha?: string } };
    const remote = j?.commit?.sha ?? "";
    return { repo: name, local: local.slice(0, 7), remote: remote.slice(0, 7), synced: remote ? local === remote : null };
  } catch { return { repo: name, local: local.slice(0, 7), remote: "api-fail", synced: null }; }
}

/* ── פנקסים ─────────────────────────────────────────────────────────────────── */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as T; } catch { return null; } }).filter(Boolean) as T[];
}
interface AlertRow { ts: string; run: number; rule: string; state: "open" | "resolve"; detail: string }
function writeAlerts(run: number, rows: AlertRow[]): void { for (const r of rows) appendFileSync(`${PP}alerts.jsonl`, JSON.stringify(r) + "\n"); }
function openRules(lastLedger: { alerts?: { rule: string }[] } | null): Set<string> {
  return new Set((lastLedger?.alerts ?? []).filter((a) => a.rule).map((a) => a.rule));
}

/* ── ריצה-אחת ───────────────────────────────────────────────────────────────── */
interface RunRow {
  ts: string; run: number; engine: { up: boolean; height: number; root: string };
  ports: Record<string, boolean>; git: { repo: string; local: string; remote: string; synced: boolean | null }[];
  battery: { bmc: { verdict: string; depth: number; sequences: number; applies: number } | null; fuzzer: { verdict: string } | null };
  alerts: { rule: string }[];
}
async function runOnce(): Promise<RunRow> {
  const t0 = Date.now();
  const ledger = readJsonl<RunRow & { alerts: { rule: string }[] }>(`${PP}proof-ledger.jsonl`);
  const last = ledger.length ? ledger[ledger.length - 1] : null;
  const run = ledger.length + 1;

  // 1+2. חיווט-חי + גיט
  const engine = await probeEngine();
  const ports: Record<string, boolean> = {};
  for (const [nm, p] of PORTS) ports[nm] = await portUp(p);
  const git = await Promise.all([gitSync(MOTHER, "saos-control-center"), gitSync(ROOT, "saos-dex")]);

  // 3. סוללה (subprocess — exit-code הוא-האמת)
  const battery: RunRow["battery"] = { bmc: null, fuzzer: null };
  if (!SKIP_BATTERY) {
    const b = spawnSync("bun", ["harness/bmc.ts", "--depth", "3", "--quiet"], { cwd: ROOT, timeout: 300_000, env: { ...process.env, DATABASE_URL: `file:${ROOT}db/dex.db` } });
    try {
      const j = JSON.parse(readFileSync(`${PP}bmc.json`, "utf8")) as { verdict: string; depth: number; sequences: number; applies: number; ts: string };
      battery.bmc = b.status === 0 && Date.now() - Date.parse(j.ts) < 120_000 ? j : { verdict: `STALE(${b.status})`, depth: 0, sequences: 0, applies: 0 };
    } catch { battery.bmc = { verdict: `CRASH(${b.status})`, depth: 0, sequences: 0, applies: 0 }; }
    const f = spawnSync("bun", ["harness/invariant-fuzzer.ts", "--fixture"], { cwd: ROOT, timeout: 600_000, env: { ...process.env, DATABASE_URL: `file:${ROOT}db/dex.db` } });
    try {
      const j = JSON.parse(readFileSync(`${PP}invariant-fuzz.json`, "utf8")) as { verdict?: string } & Record<string, unknown>;
      battery.fuzzer = { verdict: f.status === 0 ? (j.verdict ?? "PASS") : `FAIL(${f.status})` };
    } catch { battery.fuzzer = { verdict: `CRASH(${f.status})` }; }
  }

  // 4. התראות — כללים-מדודים, open/resolve, אפס-רעש-כפול
  const prevOpen = openRules(last);
  const nowOpen = new Map<string, string>();
  if (!engine.up) nowOpen.set("engine-down", `המנוע לא מגיב על ${ENGINE}`);
  else if (last && last.engine.up && engine.height === last.engine.height) {
    const staleRun = (last as { staleCount?: number }).staleCount ?? 0;
    if (staleRun >= 2) nowOpen.set("height-stale", `height ${engine.height} זהה-${staleRun + 1}-ריצות-רצופות`);
  }
  if (battery.bmc && !battery.bmc.verdict.startsWith("PASS")) nowOpen.set("proof-fail", `bmc=${battery.bmc.verdict}`);
  if (battery.fuzzer && !battery.fuzzer.verdict.startsWith("PASS")) nowOpen.set("proof-fail", `fuzzer=${battery.fuzzer.verdict}`);
  for (const g of git) if (g.synced === false) nowOpen.set("git-drift", `${g.repo}: local=${g.local} ≠ remote=${g.remote}`);
  for (const [nm, up] of Object.entries(ports)) if (!up) nowOpen.set("port-down", `${nm}:${nm === "engine" ? 3010 : nm === "mother" ? 3000 : nm === "relay" ? 3003 : nm === "governor" ? 3042 : 3012} לא-מאזין`);
  // snapshot-stale
  try {
    const snap = JSON.parse(readFileSync(`${ROOT}db/state-snapshot.json`, "utf8")) as { state?: { height?: number } };
    const sh = snap.state?.height ?? -1;
    if (engine.up && sh > 0 && engine.height - sh > 600) nowOpen.set("snapshot-stale", `engine h${engine.height} vs snapshot h${sh} (Δ${engine.height - sh})`);
  } catch { /* חסר = לא-נשפט כאן */ }
  const alerts: { rule: string }[] = [];
  const rows: AlertRow[] = [];
  for (const [rule, detail] of nowOpen) if (!prevOpen.has(rule)) { rows.push({ ts: nowIso(), run, rule, state: "open", detail }); alerts.push({ rule }); }
  for (const rule of prevOpen) if (!nowOpen.has(rule)) { rows.push({ ts: nowIso(), run, rule, state: "resolve", detail: "החוק חזר-ירוק" }); alerts.push({ rule }); }
  if (rows.length) writeAlerts(run, rows);

  // 5. פנקס
  const row: RunRow = {
    ts: nowIso(), run, engine: { up: engine.up, height: engine.height, root: engine.root.slice(0, 16) },
    ports, git, battery,
    alerts: [...prevOpen].filter((r) => nowOpen.has(r)).map((rule) => ({ rule })).concat(alerts),
  };
  appendFileSync(`${PP}proof-ledger.jsonl`, JSON.stringify(row) + "\n");
  const bmcOk = !battery.bmc || battery.bmc.verdict.startsWith("PASS");
  const fzOk = !battery.fuzzer || battery.fuzzer.verdict.startsWith("PASS");
  const verdict = engine.up && bmcOk && fzOk && nowOpen.size === 0 ? "PASS" : (nowOpen.size ? "ALERT" : "DEGRADED");
  await Bun.write(`${PP}latest-proof.json`, JSON.stringify({ ...row, verdict, elapsedMs: Date.now() - t0 }, null, 2) + "\n");
  console.log(`[${nowIso()}] run#${run} verdict=${verdict} engine=h${engine.height} alerts=[${[...nowOpen.keys()].join(",") || "אין"}] bmc=${battery.bmc?.verdict ?? "skip"} fuzzer=${battery.fuzzer?.verdict ?? "skip"} git=${git.map((g) => `${g.repo}:${g.synced === null ? "?" : g.synced ? "✓" : "✗"}`).join(" ")} (${Date.now() - t0}ms)`);
  return row;
}

if (ONCE) { runOnce().then((r) => process.exit(r && 0)).catch((e) => { console.error("proof-runner crash:", e); process.exit(1); }); }
else if (LOOP) { console.log(`proof-runner loop: כל-${LOOP_MIN}-דק'`); const tick = (): void => { runOnce().catch((e) => console.error("tick crash:", e)); }; tick(); setInterval(tick, LOOP_MIN * 60_000); }
else { console.log("שימוש: bun harness/proof-runner.ts --once [--skip-battery] | --loop [דק']"); }
