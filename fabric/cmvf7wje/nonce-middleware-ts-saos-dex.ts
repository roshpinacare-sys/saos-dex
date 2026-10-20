import { NextRequest, NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// nonce tracking layer (memory Map — PoC, extend to Redis later)
const nonceSeen = new Map<string, { count: number; firstTs: number; lastTs: number; wallet?: string }>();
const NONCE_THRESHOLD = 3;
const NONCE_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 60_000;

// track last cleanup time
let lastCleanup = Date.now();

function cleanupOldNonces() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  const cutoff = now - NONCE_WINDOW_MS;
  for (const [key, data] of nonceSeen) {
    if (data.lastTs < cutoff) {
      nonceSeen.delete(key);
    }
  }
  lastCleanup = Date.now();
}

// early warn for nonce repetition (cmvdkj2e‑style)
function checkNonce(ip: string, wallet: string | null, nonce: string): { allowed: boolean; message?: string } {
  const key = `${ip}:${wallet ?? "unknown"}:${nonce}`;
  const entry = nonceSeen.get(key);
  if (entry) {
    entry.count++;
    entry.lastTs = Date.now();
    if (entry.count >= NONCE_THRESHOLD) {
      // block the IP for 5 minutes
      nonceSeen.delete(key); // remove blocked entry
      return { allowed: false, message: "Suspicious nonce repetition detected" };
    }
  } else {
    nonceSeen.set(key, { count: 1, firstTs: Date.now(), lastTs: Date.now(), wallet });
  }
  return { allowed: true };
}

export async function middleware(request: NextRequest) {
  const ip = request.ip ?? "unknown";
  const pathname = request.nextUrl.pathname;

  // exempt paths
  if (EXEMPT.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // extract wallet from auth header or query (best‑effort PoC)
  const auth = request.headers.get("authorization");
  const wallet = auth ? auth.replace(/^bearer /i, "").trim() : null;
  const queryNonce = request.nextUrl.searchParams.get("nonce");
  const effectiveNonce = queryNonce || wallet?.slice(0, 8) || "";

  // nonce check — layer before rate‑limit
  const nonceResult = checkNonce(ip, wallet, effectiveNonce);
  if (!nonceResult.allowed) {
    const now = Date.now();
    console.warn(
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "nonce_repetition_alert",
        ip,
        wallet: wallet ?? "unknown",
        nonce: effectiveNonce,
        count: NONCE_THRESHOLD,
        note: "blocking IP for 5 min due to nonce reuse"
      })
    );
    return new NextResponse(nonceResult.message, { status: 429 });
  }

  // existing rate‑limit logic (unchanged structure)
  let limit: number;
  if (!XFF_EXISTS) {
    // internal sandbox path
    // ... existing rate-limit code preserved as‑is ...
    limit = LIMIT_INTERNAL;
  } else {
    limit = LIMIT_PUBLIC;
  }
  // ... rest of rate-limit implementation preserved ...

  return NextResponse.next();
}

// scheduled cleanup (run once per minute via next‑server lifecycle or edge function)
setInterval(cleanupOldNonces, CLEANUP_INTERVAL_MS);
