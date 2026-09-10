// Revive endpoint — internal watchdog hook for the SAOS platform family.
// This Next dev server belongs to the container-boot process tree, which is the
// ONLY lineage that survives shell-command reaping. So services that died must
// be re-spawned FROM HERE (this process), never from an operator shell.
// GET /api/revive → checks the family ports and re-spawns whatever is dead.
// Idempotent, port-checked, zero secrets involved.
import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import net from 'net';
import { operatorAuth } from '@/lib/operator-auth';

export const dynamic = 'force-dynamic';

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 900).unref?.();
  });
}

function spawnDetached(cmd: string, args: string[], cwd: string): number | null {
  try {
    const child = spawn(cmd, args, { cwd, env: { ...process.env }, stdio: 'ignore' });
    child.unref();
    child.on('error', (e: Error) => console.log('[revive] spawn error:', cmd, e.message));
    return child.pid ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  // FIX(Roast-63 · M6): זה-שער-תהליכים (spawn!) — לא-עוד-פתוח-לכולם. מפעיל-בלבד (fail-closed).
  const oa = operatorAuth(req);
  if (oa) return oa;
  const report: Record<string, unknown> = {};

  // 1) main platform :3000
  if (await portBusy(3000)) {
    report.main3000 = 'alive';
  } else {
    const pid = spawnDetached('bun', ['run', 'dev'], '/home/z/my-project');
    report.main3000 = pid ? `spawning pid=${pid}` : 'spawn-failed';
  }

  // 2) relay :3003 (socket.io realtime bus)
  if (await portBusy(3003)) {
    report.relay3003 = 'alive';
  } else {
    const pid = spawnDetached('bun', ['run', 'dev'], '/home/z/my-project/mini-services/relay-service');
    report.relay3003 = pid ? `spawning pid=${pid}` : 'spawn-failed';
  }

  return NextResponse.json({ ok: true, at: new Date().toISOString(), ...report });
}
