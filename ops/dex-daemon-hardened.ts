/**
 * dex-daemon — שומר-הדקס v2 (IGNITION-R1 · T-77 self-heal upgrade)
 * ============================================================================
 * הלקח-המוסדי (T-77, owner-trace 1a1374bc626866c9): הסנדבוקס נמחק-כולו (repos/
 * נעלם) — הדמון-שרד (הוא-ב-my-project) אבל היעד-שלו לא-היה-קיים, וההקמות
 * נכשלו-בשקט (stdio:ignore). v2 = תיקון-שלושת-החורים:
 *
 *  1. SELF-HEAL מהגיט: DEX_ROOT חסר → clone מ-GitHub (טוקן-מנתיב-מקומי, לעולם
 *     לא-מודפס) + prisma generate/push + עוגן-ראיות-reposnap. השרשרת כולה
 *     ניתנת-לשחזור מהגיט בלבד — "הכל רץ דרך הגיט" (חוק-הבעלים).
 *  2. יומן-אתחול: פלט-הבן נכתב ל-guardian.log (לא יותר stdio:ignore שמוחק ראיות).
 *  3. מטרונום-משוחזר: tick תלוי (ה-await קפא 40 דק' בפועל 22:05Z) → AbortController
 *     קשיח + ווטצ'-דוג על lastCheckAt עצמו (אם קפא מעל 3×CHECK_MS — נרשם ומוכה).
 *
 * חוקי-בטיחות: cooldown-90ש׳ · detached+unref · אפס-סודות-בלוג · loopback בלבד.
 */
import { spawn, execFile } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";

const DEX_ROOT = "/home/z/my-project/repos/saos-dex";
const DEX_URL = "http://127.0.0.1:3010/saos-dex/api/dex/state";
const HEALTH_PORT = 3035;
const CHECK_MS = 45_000;
const COOLDOWN_MS = 90_000;
const LOG = path.join(DEX_ROOT, "guardian.log");
const PAT_FILE = "/home/z/my-project/upload/pat.env";

let restarts = 0;
let lastCheckAt = 0;
let lastAlive = false;
let lastSpawnAt = 0;
let lastSelfHealAt = 0;
let repoPresent = fs.existsSync(path.join(DEX_ROOT, "package.json"));

function logLine(msg: string): void {
  const line = `${new Date().toISOString()} [dex-daemon] ${msg}`;
  console.info(line);
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, line + "\n"); } catch { /* לא-קריטי */ }
}

function readToken(): string {
  try {
    const m = fs.readFileSync(PAT_FILE, "utf8").match(/github_pat_[A-Za-z0-9_]+/);
    return m ? m[0] : "";
  } catch { return ""; }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, envOverrides?: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}`.slice(-800) + `${stderr}`.slice(-800) });
    });
  });
}

// לקח-אמת (R347): db:push מה-CLI מ-DEX_ROOT יורש DATABASE_URL מסביבת-האם
// (bun מטעין .env משורש-הפרויקט) — הדקס-סכימה נדחפה ל-DB הקונסולה וטבלאות-הספר
// נמחקו. התיקון: DATABASE_URL מפורש בכל פעולת-prisma של-ה-self-heal — אותו-חוק
// שכבר-קיים ב-spawnDex.

/** שחזור-מלא-מהגיט: clone → prisma → עוגן-ראיות. כל-שלב fail-soft מתועד. */
async function selfHealFromGit(reason: string): Promise<boolean> {
  const now = Date.now();
  if (now - lastSelfHealAt < 5 * 60_000) return repoPresent; // לא-יותר-מ-פעם-ב-5 דק'
  lastSelfHealAt = now;
  logLine(`SELF-HEAL(${reason}) — משחזר מהגיט…`);
  const token = readToken();
  if (!token) { logLine("SELF-HEAL-ABORT: אין-טוקן-מקומי"); return false; }
  fs.mkdirSync(path.dirname(DEX_ROOT), { recursive: true });
  const r1 = await run("git", ["clone", "--depth", "1", `https://x-access-token:${token}@github.com/roshpinacare-sys/saos-dex.git`, DEX_ROOT], "/home/z/my-project", 240_000);
  if (!r1.ok && !fs.existsSync(path.join(DEX_ROOT, "package.json"))) {
    logLine(`SELF-HEAL-FAIL clone: ${r1.out.slice(-200)}`);
    return false;
  }
  logLine("SELF-HEAL: clone-ok — prisma generate…");
  const dexEnv = { DATABASE_URL: `file:${path.join(DEX_ROOT, "db", "dex.db")}` };
  await run("bun", ["run", "db:generate"], DEX_ROOT, 180_000, dexEnv);
  const r3 = await run("bun", ["run", "db:push"], DEX_ROOT, 180_000, dexEnv);
  logLine(`SELF-HEAL: db-push ok=${r3.ok}`);
  const r4 = await run("bun", ["run", "scripts/seed-evidence-anchor.ts"], DEX_ROOT, 120_000, dexEnv);
  logLine(`SELF-HEAL: seed-anchor ok=${r4.ok} ${r4.out.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 120) ?? ""}`);
  repoPresent = fs.existsSync(path.join(DEX_ROOT, "package.json"));
  logLine(`SELF-HEAL-DONE repoPresent=${repoPresent}`);
  return repoPresent;
}

function probeAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    const hardTimer = setTimeout(() => done(false), 9_000); // קשיח — לא-משנה-מה-קורה-למטה
    try {
      const req = http.get(DEX_URL, { timeout: 6_000 }, (res) => {
        res.resume();
        done(res.statusCode === 200);
      });
      req.on("timeout", () => { req.destroy(); done(false); });
      req.on("error", () => done(false));
    } catch { done(false); }
    // ה-hardTimer-עצמו תמיד-מתפקד; unref כדי-שלא-יחזיק-את-התהליך
    hardTimer.unref?.();
  });
}

function spawnDex(): void {
  const now = Date.now();
  if (now - lastSpawnAt < COOLDOWN_MS) {
    logLine(`cooldown — מדלג-על-הקמה (${Math.ceil((COOLDOWN_MS - (now - lastSpawnAt)) / 1000)}s)`);
    return;
  }
  lastSpawnAt = now;
  restarts++;
  try {
    fs.mkdirSync(path.join(DEX_ROOT, "db"), { recursive: true });
    const out = fs.openSync(LOG, "a");
    const child = spawn(
      "bun",
      ["run", "dev"],
      {
        cwd: DEX_ROOT,
        detached: true,
        stdio: ["ignore", out, out], // v2: ראיות-אתחול-חיות-ביומן (לא-ignore)
        env: {
          ...process.env,
          DATABASE_URL: `file:${path.join(DEX_ROOT, "db", "dex.db")}`,
          SAOS_DEX_STATE_DIR: path.join(DEX_ROOT, "db"),
        },
      },
    );
    child.unref();
    logLine(`REVIVE #${restarts} — הדקס-הוקם-מחדש (pid ${child.pid})`);
  } catch (e) {
    logLine(`REVIVE-FAIL: ${(e as Error).message}`);
  }
}

async function tick(): Promise<void> {
  lastCheckAt = Date.now();
  let alive = false;
  try { alive = await probeAlive(); } catch { alive = false; }
  lastCheckAt = Date.now(); // אחרי-ה-await — המטרונום-חי
  lastAlive = alive;
  if (!alive) {
    if (!repoPresent) {
      const healed = await selfHealFromGit("repo-missing");
      if (!healed) return;
    }
    logLine(`probe-FAIL — מקים-מחדש`);
    spawnDex();
  } else {
    if (!repoPresent) repoPresent = true;
  }
}

// ווטצ'-דוג-על-המטרונום-עצמו: אם-lastCheckAt קפא מעל 3×CHECK_MS — ה-tick תלוי
setInterval(() => {
  const frozenFor = Date.now() - lastCheckAt;
  if (lastCheckAt > 0 && frozenFor > 3 * CHECK_MS) {
    logLine(`WATCHDOG: tick קפא ${Math.round(frozenFor / 1000)}s — מכה-מחדש`);
    lastCheckAt = Date.now();
    void tick();
  }
}, CHECK_MS).unref?.();

// בדיקה-ראשונה-מיידית, ואז-מטרונום
void tick();
setInterval(() => void tick(), CHECK_MS);

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true, dexAlive: lastAlive, restarts, lastCheckAt, checkMs: CHECK_MS,
      repoPresent, lastSelfHealAt: lastSelfHealAt ? new Date(lastSelfHealAt).toISOString() : null, v: 2,
    }));
  })
  .listen(HEALTH_PORT, "127.0.0.1", () => {
    logLine(`dex-daemon v2 עלה — health על 127.0.0.1:${HEALTH_PORT}, probe כל-${CHECK_MS / 1000}s, self-heal מהגיט מופעל`);
  });
