import { NextRequest, NextResponse } from "next/server";

// ── AnomalyDetector: ניטור התנהגותי מתקדם ──────────────────────────
export class AnomalyDetector {
  private requestCounts = new Map<string, number>(); // ip -> count in window
  private lastTimestamps = new Map<string, number>(); // ip -> last request ts
  private pathCounts = new Map<string, Map<string, number>>(); // ip -> {path: count}
  private nonceHistory = new Map<string, string[]>(); // ip -> recent nonces
  private suspiciousPaths = new Set(["/api/dex/settle", "/api/dex/transfer"]);

  // סף לזיהוי שינוי פתאומי בקצב (בקשות/דקה)
  private readonly RATE_CHANGE_THRESHOLD = 300; // 300% increase triggers alert
  // סף לבקשות חשודות לאותו נתיב
  private readonly PATH_COUNT_THRESHOLD = 50; // per minute per ip
  // סף לנonce חוזרים
  private readonly NONCE_REPEAT_THRESHOLD = 3;

  /** רישום בקשה – נקרא בכל בקשה נכנסת */
  recordRequest(ip: string, pathname: string, nonce?: string): void {
    const now = Date.now();
    // עדכון ספירת בקשות כלליות ל-IP
    let count = (this.requestCounts.get(ip) ?? 0) + 1;
    this.requestCounts.set(ip, count);

    // עדכון ספציפי לפי נתיב
    let pathMap = this.pathCounts.get(ip);
    if (!pathMap) {
      pathMap = new Map();
      this.pathCounts.set(ip, pathMap);
    }
    let pathCount = (pathMap.get(pathname) ?? 0) + 1;
    pathMap.set(pathname, pathCount);

    // שמירת נונס לזיהוי חזרות
    if (nonce) {
      let history = this.nonceHistory.get(ip) ?? [];
      // הסר נונסים ישנים מ-5 שניות
      history = history.filter((t) => now - t < 5000);
      if (history.includes(nonce)) {
        // נonce חוזר – אירוע חשוד
        console.warn(
          JSON.stringify({
            timestamp: new Date(now).toISOString(),
            action: "nonce_repeat",
            ip,
            path: pathname,
            nonce,
            note: "Repeated nonce detected – possible replay or manipulation",
          })
        );
      }
      history.push(now);
      if (history.length > 50) history.shift();
      this.nonceHistory.set(ip, history);
    }

    // עדכון זמן אחרון
    this.lastTimestamps.set(ip, now);
  }

  /** בדיקת חריגות – מחזיר אובייקט אירועים או null */
  checkAnomalies(ip: string, pathname: string): Array<{type: string; detail: string}> {
    const alerts: Array<{type: string; detail: string}> = [];
    const count = this.requestCounts.get(ip) ?? 0;
    const pathMap = this.pathCounts.get(ip);
    const pathCount = pathMap?.get(pathname) ?? 0;
    const lastTs = this.lastTimestamps.get(ip);
    const now = Date.now();

    // 1. ניטור שינוי פתאומי בקצב
    if (lastTs !== undefined && now - lastTs > 60000) {
      const prevCount = this.requestCounts.get(ip) ?? 0;
      const changePercent = prevCount > 0 ? ((count - prevCount) / prevCount) * 100 : 0;
      if (changePercent > this.RATE_CHANGE_THRESHOLD) {
        alerts.push({
          type: "rate_spike",
          detail: `IP ${ip} request rate changed by ${changePercent.toFixed(1)}% in last minute (from ${prevCount} to ${count})`,
        });
      }
    }

    // 2. גישה חוזרת לנתיבים רגישים עם תדירות גבוהה
    if (this.suspiciousPaths.has(pathname) && pathCount > this.PATH_COUNT_THRESHOLD) {
      alerts.push({
        type: "sensitive_path_overuse",
        detail: `IP ${ip} accessed sensitive path ${pathname} ${pathCount} times in current window`,
      });
    }

    // 3. ניתור נונס חוזרים (כבר נרשם ב-recordRequest, אך נבדק שוב)
    // (אם נרצה בדיקה נפרדת – אפשר להרחיב)

    // 4. בדיקת כותרות – נדרשת העברת מידע מהבקשה
    // (מאומן על ידי caller להעביר כותרת חשודה)

    return alerts;
  }
}

// מופע גלובלי – יש להתאים לסביבת הייצור
const anomalyDetector = new AnomalyDetector();

// ── Middleware שילוב ────────────────────────────────────────────────────
export async function middleware(request: NextRequest) {
  const ip = request.ip ?? "unknown";
  const pathname = request.nextUrl.pathname;

  // 1. רישום הבקשה אצל detector
  const nonce = request.headers.get("x-nonce");
  anomalyDetector.recordRequest(ip, pathname, nonce);

  // 2. בדיקת חריגות
  const alerts = anomalyDetector.checkAnomalies(ip, pathname);

  // 3. רישום אירועים (לוג-בלבד, fail-open)
  if (alerts.length > 0) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        action: "anomaly_detected",
        ip,
        path: pathname,
        alerts,
        note: "Behavioral anomaly logged – further action may be taken by operator",
      })
    );
  }

  // 4. המשך זרימה – middleware הנוכחי מטופל בנפרד
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/dex/:path*"] // חל רק על נתיבי DEX API",
};