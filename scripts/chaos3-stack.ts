/**
 * chaos3-stack.ts — WHOLE-STACK SELF-HEAL MATRIX · v2 (socket-holder kills)
 * ════════════════════════════════════════════════════════════════════════════
 * v1-FAIL-כנה (נמדד): pkill-לפי-דפוס-טקסט הרג **wrapper** (bash שמחזיק-את-הנתיב
 * בשורת-הפקודה) ולא-את-שרת-ה-bun האמיתי — "self-healed in 5s" היה-חיים-שלא-נהרגו.
 * זהו **אותו-שיעור** מסבב-2 (kill-לפי-cmdline מפספס) — עתה: הריגה-לפי-PID-מחזיק-שקע
 * (+ ההורה שלו), והצהרת-מוות לפי-היעדר-שקע + היעדר-pid.
 */
interface Row { service: string; pidBefore: number; killed: boolean; selfHealed: boolean; seconds: number; reviver: string; note: string }
const rows: Row[] = [];

function portPid(port: number): number {
  const out = Bun.spawnSync(["bash", "-c", `ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\\K[0-9]+' | head -1`]).stdout.toString().trim();
  return Number(out) || 0;
}
function statePushPid(): number {
  // ל-process ללא-פורט: סריקת-/proc לפי-cwd
  const out = Bun.spawnSync(["bash", "-c",
    `for p in $(pgrep -f "bun" 2>/dev/null); do cwd=$(readlink /proc/$p/cwd 2>/dev/null); [[ "$cwd" == *dex-state-push* ]] && echo $p && break; done`]).stdout.toString().trim();
  return Number(out) || 0;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function killPortAndWatch(name: string, port: number, reviveCmd: string, timeoutS = 240): Promise<void> {
  const pid = portPid(port);
  if (!pid) { rows.push({ service: name, pidBefore: 0, killed: false, selfHealed: false, seconds: 0, reviver: "-", note: "not running pre-kill" }); console.log(`  ${name}: NOT RUNNING pre-kill (finding)`); return; }
  const wrapper = Number(Bun.spawnSync(["bash", "-c", `ps -o ppid= -p ${pid} | tr -d ' '`]).stdout.toString().trim()) || 0;
  process.stdout.write(`  ${name}: socket-pid=${pid} (ppid=${wrapper}) → kill -9 both … `);
  Bun.spawnSync(["bash", "-c", `kill -9 ${pid} 2>/dev/null; [ "${wrapper}" != "1" ] && [ -n "${wrapper}" ] && kill -9 ${wrapper} 2>/dev/null; true`]);
  await sleep(2_000);
  const deadConfirmed = portPid(port) === 0;
  if (!deadConfirmed) { rows.push({ service: name, pidBefore: pid, killed: false, selfHealed: false, seconds: 0, reviver: "-", note: "KILL FAILED — port still held" }); console.log("✗ kill failed — port still held"); return; }
  const t0 = Date.now();
  let healed = false;
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    if (portPid(port) > 0) { healed = true; break; }
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  if (healed) {
    const newPid = portPid(port);
    rows.push({ service: name, pidBefore: pid, killed: true, selfHealed: true, seconds, reviver: "supervisor (auto)", note: `new pid=${newPid}` });
    console.log(`✓ self-healed in ${seconds}s (new pid=${newPid})`);
  } else {
    Bun.spawnSync(["bash", "-c", reviveCmd]);
    for (let i = 0; i < 80; i++) { await sleep(3_000); if (portPid(port) > 0) break; }
    rows.push({ service: name, pidBefore: pid, killed: true, selfHealed: false, seconds, reviver: "MANUAL (no supervisor — WATCH-MAP GAP)", note: `stayed dead ${seconds}s` });
    console.log(`✗ NO SELF-HEAL in ${seconds}s → manual revive (finding)`);
  }
}

async function main(): Promise<void> {
  console.log("\n════ CHAOS ROUND 3 v2 · SOCKET-HOLDER KILLS ════");

  await killPortAndWatch("relay :3003", 3003,
    `cd /home/z/my-project/mini-services/relay-service && setsid nohup bun run dev >> /home/z/my-project/relay-dev.log 2>&1 &`);
  await killPortAndWatch("governor :3042", 3042,
    `cd /home/z/my-project/mini-services/revenue-governor && setsid nohup bun run dev >> /home/z/my-project/governor-dev.log 2>&1 &`);
  await killPortAndWatch("legion :3012", 3012,
    `cd /home/z/my-project/mini-services/saos-legion && setsid nohup bun run dev >> /home/z/my-project/legion-dev.log 2>&1 &`);

  // state-push — בלי-פורט: הריגה-לפי-cwd, בדיקת-חיים לפי-pid
  {
    const pid = statePushPid();
    if (!pid) {
      rows.push({ service: "state-push", pidBefore: 0, killed: false, selfHealed: false, seconds: 0, reviver: "-", note: "not running pre-kill" });
      console.log("  state-push: NOT RUNNING pre-kill (finding)");
    } else {
      const wrapper = Number(Bun.spawnSync(["bash", "-c", `ps -o ppid= -p ${pid} | tr -d ' '`]).stdout.toString().trim()) || 0;
      process.stdout.write(`  state-push: pid=${pid} (ppid=${wrapper}) → kill -9 both … `);
      Bun.spawnSync(["bash", "-c", `kill -9 ${pid} 2>/dev/null; [ "${wrapper}" != "1" ] && [ -n "${wrapper}" ] && kill -9 ${wrapper} 2>/dev/null; true`]);
      await sleep(2_000);
      const t0 = Date.now();
      let healed = false;
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        await sleep(5_000);
        if (statePushPid() > 0) { healed = true; break; }
      }
      const seconds = Math.round((Date.now() - t0) / 1000);
      if (healed) {
        rows.push({ service: "state-push", pidBefore: pid, killed: true, selfHealed: true, seconds, reviver: "supervisor (auto)", note: `new pid=${statePushPid()}` });
        console.log(`✓ self-healed in ${seconds}s`);
      } else {
        Bun.spawnSync(["bash", "-c", `cd /home/z/my-project/mini-services/dex-state-push && setsid nohup bun run dev >> /home/z/my-project/state-push-dev.log 2>&1 &`]);
        for (let i = 0; i < 80; i++) { await sleep(3_000); if (statePushPid() > 0) break; }
        rows.push({ service: "state-push", pidBefore: pid, killed: true, selfHealed: false, seconds, reviver: "MANUAL (no supervisor — WATCH-MAP GAP)", note: `stayed dead ${seconds}s` });
        console.log(`✗ NO SELF-HEAL in ${seconds}s → manual revive (finding)`);
      }
    }
  }

  const eng = await fetch("http://127.0.0.1:3010/saos-dex/api/dex/state", { signal: AbortSignal.timeout(8_000) }).then((r) => r.json() as Promise<{ ok: boolean; state: { height: number; halted: boolean } }>).catch(() => null);
  const engineOk = !!eng?.ok && eng.state.halted === false;
  console.log(`\n  engine after the whole matrix: ${engineOk ? `✓ alive h=${eng?.state.height} not-halted` : "✗ DOWN"}`);

  const killedReal = rows.filter((r) => r.killed);
  const healed = killedReal.filter((r) => r.selfHealed).length;
  const verdict = healed === killedReal.length && killedReal.length === rows.length && engineOk ? "PASS" : "FINDINGS";
  console.log(`\n── VERDICT: ${verdict} — real-killed ${killedReal.length}/${rows.length} · self-healed ${healed}/${killedReal.length} · engine alive=${engineOk} ──`);
  for (const r of rows) console.log(`  ${r.selfHealed ? "✓" : "✗"} ${r.service.padEnd(24)} ${r.selfHealed ? `auto ${r.seconds}s ${r.note}` : r.note}`);
  await Bun.write("audit-package/proof-pack/chaos3-stack.json", JSON.stringify({
    instrument: "chaos3-stack", version: 2, at: new Date().toISOString(), verdict, rows,
    engineAlive: engineOk, engineHeight: eng?.state.height,
    methodology: "kill = socket-holder pid + parent; death confirmed by absent socket; v1 lesson recorded (cmdline-pattern kill was a false kill)",
  }, null, 2));
  console.log("artifact → audit-package/proof-pack/chaos3-stack.json");
}

await main();
