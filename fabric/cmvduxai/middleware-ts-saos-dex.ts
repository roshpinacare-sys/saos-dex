import { NextRequest, NextResponse } from "next/server";
import rateLimit from "express-rate-limit";
import { createLogger } from "winston";
import type { RateLimitRequestHandler } from "express-rate-limit";

// ── הגדרות סביבה (עם ברירות-מחדל בטוחות) ──
const BURST_WINDOW_MS = Number(process.env.RATE_BURST_WINDOW_MS ?? "5000");
const BURST_LIMIT = Number(process.env.RATE_BURST_LIMIT ?? "30");
const SUSPICIOUS_TTL_SECONDS = Number(process.env.SUSPICIOUS_TTL_SECONDS ?? "300");
const LOG_EXTERNAL = process.env.LOG_EXTERNAL ?? "false" === "true";

// ── מעקב מצב בזיכרון (TTL מוגבל) ──
const burstCounters = new Map<string, { count: number; firstTs: number }>();
const ipBehavior = new Map<string, {
  pathHistory: string[];
  errorCounts: Map<string, number>;
  lastSeen: number;
  suspiciousScore: number;
}>( );
const suspiciousIPs = new Map<string, number>( ); // ip -> expireTs

// ── ניקוי רקע (כל 60 שניות) ──
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of burstCounters) {
    if (now - data.firstTs > SUSPICIOUS_TTL_SECONDS * 1000) {
      burstCounters.delete(ip);
    }
  }
  for (const [ip, data] of ipBehavior) {
    if (now - data.lastSeen > SUSPICIOUS_TTL_SECONDS * 1000) {
      ipBehavior.delete(ip);
      suspiciousIPs.delete(ip);
    }
  }
}, 60_000);

// ── לוגינג חיצוני (Winston) ──
const logger = createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    ...(LOG_EXTERNAL ? [new winston.transports.File({ filename: "suspicious.log" })] : []),
  ],
});

function logAnomaly(metadata: { ip: string; userAgent?: string; path: string; method: string; type: string; timestamp: number }) {
  if (LOG_EXTERNAL) {
    logger.warn("suspicious_activity", metadata);
  } else {
    console.warn(JSON.stringify(metadata));
  }
}

// ── זיהוי burst (יותר מ-N בקשות ב-X שניות) ──
function checkBurst(ip: string, now: number): boolean {
  const entry = burstCounters.get(ip) ?? { count: 0, firstTs: now };
  if (now - entry.firstTs > BURST_WINDOW_MS) {
    burstCounters.set(ip, { count: 1, firstTs: now });
    return false;
  }
  entry.count++;
  burstCounters.set(ip, entry);
  if (entry.count > BURST_LIMIT) {
    const data = ipBehavior.get(ip) ?? {
      pathHistory: [],
      errorCounts: new Map(),
      lastSeen: now,
      suspiciousScore: 0,
    };
    data.lastSeen = now;
    data.suspiciousScore += 10;
    ipBehavior.set(ip, data);
    logAnomaly({
      ip,
      path: entry.firstTs !== now ? "burst-start" : entry.pathHistory[entry.pathHistory.length - 1] || "unknown",
      method: "POST",
      type: "burst",
      timestamp: now,
    });
    return true;
  }
  return false;
}

// ── זיהוי שינוי IP פתאומי ──
function checkGeoJump(ip: string, currentPathname: string, now: number): boolean {
  const data = ipBehavior.get(ip);
  if (!data) {
    ipBehavior.set(ip, {
      pathHistory: [currentPathname],
      errorCounts: new Map(),
      lastSeen: now,
      suspiciousScore: 0,
    });
    return false;
  }
  // פשוט: אם הנתיב הנוכחי שונה בתכלית מההיסטוריה (למשל מכיל אזור גאוגרפי אחר ברמה של /api/dex/agent vs /api/dex/swap)
  if (data.pathHistory.length > 0 && !currentPathname.startsWith(data.pathHistory[0].split("/")[1])) {
    data.suspiciousScore += 15;
    logAnomaly({
      ip,
      path: currentPathname,
      method: "GET",
      type: "geo_jump",
      timestamp: now,
    });
  }
  data.pathHistory.push(currentPathname);
  if (data.pathHistory.length > 10) data.pathHistory.shift();
  data.lastSeen = now;
  ipBehavior.set(ip, data);
  return data.suspiciousScore >= 20;
}

// ── זיהוי הזרקה (SQLi / Path Traversal) ──
function checkInjection(pathname: string, method: string): boolean {
  const SENSITIVE_PATHS = ["/api/dex/agent", "/api/dex/order", "/api/dex/swap"];
  if (!SENSITIVE_PATHS.some((p) => pathname.startsWith(p))) return false;
  const injectionPatterns = [
    /(?:union|select|insert|delete|drop|alter|exec|shutdown|grant|revoke)/i,
    /(\.\./|%2e%2e|..%2f)/,
    /(?:'|\"|%27|%22)\s*(?:or|and|where|having)/i,
  ];
  const data = pathname + " " + method;
  return injectionPatterns.some((re) => re.test(data));
}

// ── ספירת שגיאות לפי סוג ──
function recordError(ip: string, status: number, pathname: string, now: number) {
  const data = ipBehavior.get(ip);
  if (!data) return;
  const key = `${status} ${pathname}`;
  data.errorCounts.set(key, (data.errorCounts.get(key) ?? 0) + 1);
  if (status >= 400 && status < 500) data.suspiciousScore += 5;
  if (status >= 500) data.suspiciousScore += 10;
  data.lastSeen = now;
  ipBehavior.set(ip, data);
  // זיהוי תקיפה: 5 שגיאות 4xx/5xx מאותו IP באותו נתיב בדקה
  const recent = Array.from(data.errorCounts.entries()).filter(([k]) => k.includes(pathname));
  if (recent.filter(([, c]) => c >= 5).length > 0 && now - data.lastSeen < 60_000) {
    logAnomaly({
      ip,
      path: pathname,
      method: "UNKNOWN",
      type: "error_concentration",
      timestamp: now,
    });
  }
}

// ── middleware הראשי ──
export async function middleware(request: NextRequest) {
  const now = Date.now();
  const ip = request.ip ?? "unknown";
  const pathname = request.nextUrl.pathname;
  const method = request.method;

  // 1. בדיקת burst
  const isBurst = checkBurst(ip, now);

  // 2. בדיקת שינוי גאוגרפי/דפוס
  const isGeoJump = checkGeoJump(ip, pathname, now);

  // 3. בדיקת הזרקה
  const isInjection = checkInjection(pathname, method);

  // 4. טיפול באירועים חריגים
  if (isBurst || isGeoJump || isInjection) {
    // סימון IP כ-false positive / malicious (TTL מוגבל)
    let expireTs = suspiciousIPs.get(ip) ?? now + SUSPICIOUS_TTL_SECONDS * 1000;
    if (isInjection) expireTs = now + 60_000; // הזרקה — חסימה קצרה יותר
    suspiciousIPs.set(ip, expireTs);

    // החזר תשובה מותאם
    return new NextResponse(JSON.stringify({
      error: "request_blocked",
      reason: isInjection ? "injection_attempt" : isBurst ? "burst_detected" : "geo_pattern_jump",
      timestamp: new Date(now).toISOString(),
    },
    {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 5. הקלטת שגיאות (אם response כבר נשלח — נרשם לאחר מכן)
  // note: נרשמת ברמה הבינונית; הלוגיקה המלאה תתחבר לנקודות ה-end של ה-API

  // 6. המשך ל-handler הרגיל
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/dex/agent/:path*", "/api/dex/order/:path*", "/api/dex/swap/:path*", "/api/dex/:path*"],
};
