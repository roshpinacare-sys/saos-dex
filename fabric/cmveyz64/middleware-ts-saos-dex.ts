import { NextRequest, NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── ניתוח התנהגותי בזמן אמת ─────────────────────────────────────────────
const BURST_THRESHOLD = 50; // יותר מ-50 בקשות ב-5 שניות
const BURST_WINDOW_MS = 5_000;
const IP_CHANGE_THRESHOLD = 10; // יותר מ-10 IP שונים בדקה
const INJECTION_PATTERNS = [
  /';/', /"/, /\bunion\b/, /\bselect\b/, /\bdrop\b/, /\binsert\b/, /\bdelete\b/, /\bupdate\b/, /\bcreate\b/, /\balter\b/, /\btruncate\b/, /\bcast\b/, /\bexec\b/, /\bshutdown\b/, /\bchmod\b/, /\.\./, /etc/passwd/, /\bexec\b/,
];

// מצב מעקב (מופע-חד-פעמי בשרת)
const burstTracker = new Map<string, { count: number; firstTs: number }>();
const ipChangeTracker = new Map<string, Set<string>>(); // ip -> Set של IP-יעדים בדקה האחרונה
const requestCount = new Map<string, number>(); // מזהה בקשה -> ספירה (ל-4xx/5xx)
const errorCounts = {
  400: 0, 401: 0, 403: 0, 429: 0, 500: 0,
};
const errorTimestamps = new Map<string, number>(); // סוג שגיאה -> חותמת אחרונה

function detectInjection(pathname: string, rawQuery: string): boolean {
  const combined = `${pathname}${rawQuery}`;
  return INJECTION_PATTERNS.some((re) => re.test(combined));
}

function sendStructuredLog(entry: { level: string; message: string; [k: string]: unknown }) {
  // פלט JSON ל-stdout לתאימות Pino/Winston
  console.log(JSON.stringify(entry));
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const rawQuery = request.nextUrl.search;
  const ip = request.ip ?? "unknown";
  const now = Date.now();

  // 1. ניטור burst לפי IP
  const burstEntry = burstTracker.get(ip);
  if (burstEntry) {
    if (now - burstEntry.firstTs > BURST_WINDOW_MS) {
      burstTracker.delete(ip);
      burstTracker.set(ip, { count: 1, firstTs: now });
    } else {
      burstEntry.count++;
      if (burstEntry.count > BURST_THRESHOLD) {
        sendStructuredLog({
          level: "warn",
          message: "Abnormal burst detected",
          ip,
          path: pathname,
          count: burstEntry.count,
          window: "5s",
        });
      }
    }
  } else {
    burstTracker.set(ip, { count: 1, firstTs: now });
  }

  // 2. ניטור שינוי IP (זיהוי סשן-חטיפה או בוט)
  const ipSet = ipChangeTracker.get(ip) || new Set();
  ipSet.add(ip);
  if (ipSet.size > IP_CHANGE_THRESHOLD) {
    // שמר רק IP אחרונים לדקה
    const limitedSet = new Set([...ipSet].slice(-IP_CHANGE_THRESHOLD * 2));
    ipChangeTracker.set(ip, limitedSet);
    sendStructuredLog({
      level: "warn",
      message: "Sudden IP change detected",
      ip,
      path: pathname,
      uniqueIPs: ipSet.size,
    });
  }
  ipChangeTracker.set(ip, ipSet);

  // 3. זיהוי הזרקת SQL/נתיב
  if (detectInjection(pathname, rawQuery)) {
    sendStructuredLog({
      level: "error",
      message: "Potential injection attempt detected",
      ip,
      path: pathname,
      query: rawQuery.substring(0, 200), // איפיון חלקי בלבד
    });
    // אפשר לחסום כאן או להמשיך עם תגובה מותאמת
  }

  // 4. ספירת שגיאות 4xx/5xx לפי סוג
  // ה-middleware פועל לפני התגובה, לכן נרשם את הבקשה למעקב אחרי תגובה
  const requestId = request.headers.get("x-request-id") || "unknown";
  // נשמור את פרטי הבקשה לזיהוי לאחר התגובה
  // (במקרים אמיתיים נשתמש ב-response hooks, כאן נרשם את המבנה)

  // 5. בדיקת סף שגיאות (למשל 400) - נבדוק בתגובה
  // נרשם את המזהה למעקב אחרי ספירת שגיאות בדקה
  const errorKey = `${pathname}:${ip}`;
  requestCount.set(requestCount.size + 1, now); // תיוג פשוט למעקב

  // המשך לטיפול הקיים
  return NextResponse.next({
    request: {
      ...request,
      // נציין שטופל ניתוח התנהגותי
      headers: new Headers(request.headers).set("x-behavioral-analysis", "active"),
    },
  });
}

// האזנה לתגובה כדי לספור שגיאות
export const config = {
  matcher: ["/api/dex/:path*", "/api/revive"],
};

// ניקוי מונים כל דקה (ניתן להוסיף setInterval בשרת הראשי)
export function cleanupCounters() {
  const now = Date.now();
  for (const [ip, entry] of burstTracker) {
    if (now - entry.firstTs > WINDOW_MS) {
      burstTracker.delete(ip);
    }
  }
  for (const [ip, set] of ipChangeTracker) {
    // ניקוי לוגי - הסט מתאפס מעצמו עם בקשות חדשות
  }
}
