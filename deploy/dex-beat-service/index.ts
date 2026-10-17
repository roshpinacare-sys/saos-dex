// [agent-zai/W1.3] dex-beat-service — the canonical local pacer for the SAOS-DEX
// chain, packaged as a mini-service (own port + `bun --hot`) because the sandbox
// reaps plain nohup background loops (measured: 04:40Z and 05:10Z reaps).
//
// Law: R71 cadence — hourly at :53 UTC. One beat at a time (flock inside the
// keeper script; the service additionally serializes with a simple flag).
// The keeper script is the ONLY executor — this service never touches the
// chain itself; it just drives the canonical script on the canonical clock.
// WASH stays at the DAM-RELEASE law (floor 0, owner-ratified 2026-10-17,
// hub lease W1.3) — the service makes no economic decisions.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

// [W1.6] cross-process single-instance law — measured 23:18Z: THREE `bun --hot
// index.ts` schedulers fired at :53 in parallel (two 20:07 zombies that survived
// the audit wipe — processes outlive deleted files — plus the 21:04 relaunch that
// silently LOST the port bind but kept its timers; the old-code zombie served
// /health, so BOOTSTRAP's health-check blessed the wrong owner). The in-process
// globalThis guard (W1.5) cannot see across processes; the OS lockfile can.
// flock -n here (held for process lifetime via package.json dev script) + PID
// in every boot log = one clock owner, ever. A second instance exits 0 quietly
// by DESIGN — losing the race honestly is correct; duplicating the clock is not.

const PORT = 3044;
const KEEPER = "/home/z/audit/saos-dex/deploy/dex-beat-keeper.sh";
const LOG = "/tmp/dex-beat-service.log";

let running = false;
let lastBeat: { startedAt: string; finishedAt?: string; rc?: number | null; tail?: string[] } | null = null;
let nextFireAt = "";

function log(line: string) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  try { appendFileSync(LOG, entry + "\n"); } catch {}
  console.log(entry);
}

function msToNext53(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(53, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - now.getTime();
}

function fireKeeper() {
  if (running) { log("beat already running — skip (machine skips, never stacks)"); return; }
  running = true;
  const startedAt = new Date().toISOString();
  lastBeat = { startedAt };
  log("firing canonical keeper: " + KEEPER);
  const child = spawn("bash", [KEEPER], { cwd: "/home/z/audit/saos-dex" });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); if (out.length > 8000) out = out.slice(-8000); });
  child.stderr.on("data", (d) => { out += String(d); if (out.length > 8000) out = out.slice(-8000); });
  child.on("close", (rc) => {
    running = false;
    if (lastBeat) { lastBeat.finishedAt = new Date().toISOString(); lastBeat.rc = rc; lastBeat.tail = out.split("\n").filter(Boolean).slice(-6); }
    log(`keeper finished rc=${rc}`);
  });
  child.on("error", (e) => { running = false; log("keeper spawn error: " + String(e)); });
}

function armNext() {
  const wait = msToNext53();
  nextFireAt = new Date(Date.now() + wait).toISOString();
  log(`next beat at ${nextFireAt} (in ${Math.round(wait / 1000)}s)`);
  setTimeout(() => { fireKeeper(); armNext(); }, wait);
}

// health endpoint — the sandbox gateway expects every mini-service to own a port
Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "dex-beat-service", cadence: "hourly :53 UTC", running, nextFireAt, lastBeat });
    }
    if (url.pathname === "/fire-now") {
      // manual trigger, same canonical script — for operator use only
      fireKeeper();
      return Response.json({ ok: true, fired: true });
    }
    return new Response("dex-beat-service\n", { status: 200 });
  },
});

log(`dex-beat-service up pid=${process.pid} (R71 hourly :53 cadence; keeper=${KEEPER})`);
// [W1.5] double-arm guard — measured 17.10 20:53:00.011Z: bun --hot re-evaluates
// this module on file change (BOOTSTRAP overwrite) while the OLD timer chain
// keeps living on the process, so two keepers fired in the same millisecond.
// Law: ONE scheduler per process. globalThis survives hot reload; module state
// does not. A new module instance attaches to nothing and leaves the arm alone.
const G = globalThis as typeof globalThis & { __dexBeatArmed?: boolean };
if (!G.__dexBeatArmed) {
  G.__dexBeatArmed = true;
  armNext();
} else {
  log("scheduler already armed on this process (hot-reload) — not re-arming");
}
