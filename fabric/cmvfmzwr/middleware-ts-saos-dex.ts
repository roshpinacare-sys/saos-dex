import { NextRequest, NextResponse } from "next/server";

// ── AnomalyDetector: ניטור התנהגותי מתקדם ──
export class AnomalyDetector {
  private requestCounts = new Map<string, number[]>(); // ip -> timestamps (last 60s)
  private pathHistory = new Map<string, string[]>(); // ip -> last 20 paths
  private nonceHistory = new Map<string, string[]>(); // ip -> last 10 nonces
  private suspiciousHeaders = new Set(["x-forwarded-for", "x-real-ip"]);
  private readonly WINDOW_MS = 60_000;
  private readonly MAX_PATH_HISTORY = 20;
  private readonly MAX_NONCE_HISTORY = 10;

  recordRequest(req: NextRequest): void {
    const ip = this.extractIP(req);
    const pathname = req.nextUrl.pathname;
    const now = Date.now();

    // 1. ניטור קצב בקשות + זיהוי פתאומיות בשינויי קצב
    if (!this.requestCounts.has(ip)) this.requestCounts.set(ip, []);
    const timestamps = this.requestCounts.get(ip)!;
    timestamps.push(now);
    // שימור רק החלון האחרון
    while (timestamps.length > 0 && now - timestamps[0] > this.WINDOW_MS) timestamps.shift();
    const rate = timestamps.length / (this.WINDOW_MS / 1000);
    if (rate > 10) { // חריגה: מעל 10 בקשות/שניה
      console.warn(JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "rate_anomaly",
        ip,
        path: pathname,
        requestCount: timestamps.length,
        ratePerSec: rate.toFixed(2),
        note: "קצב בקשות חריג לזיהוי DDoS או אוטומציה"
      }));
    }

    // 2. זיהוי גישה חוזרת לנתיבים רגישים עם פרמטרים מוזרים
    const sensitivePaths = ["/api/dex/settle", "/api/dex/transfer"];
    if (sensitivePaths.some(p => pathname.startsWith(p))) {
      const history = this.pathHistory.get(ip) || [];
      history.push(pathname);
      if (history.length > this.MAX_PATH_HISTORY) history.shift();
      this.pathHistory.set(ip, history);
      // בדיקה אם אותו IP פונה לאותו נתיב עם פרמטרים משתנים באופן חשוד
      const pathWithQuery = `${pathname}${req.nextUrl.search}`;
      const similarEntries = history.filter(h => h.includes(pathname.split("/")[3]));
      if (similarEntries.length > 3) {
        console.warn(JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: "sensitive_path_repetition",
          ip,
          path: pathname,
          repetitionCount: similarEntries.length,
          note: "גישה חוזרת לנתיב רגיש עם וריאציות פרמטרים"
        }));
      }
    }

    // 3. ניתור סדרות בקשות עם אותו nonce
    const nonce = req.headers.get("x-nonce") || "";
    if (nonce) {
      if (!this.nonceHistory.has(ip)) this.nonceHistory.set(ip, []);
      const nonces = this.nonceHistory.get(ip)!;
      nonces.push(nonce);
      while (nonces.length > this.MAX_NONCE_HISTORY) nonces.shift();
      this.nonceHistory.set(ip, nonces);
      // זיהוי חזרה של nonce (אפשרות לניסיון ריפליי)
      const duplicateCount = nonces.filter(n => n === nonce).length - 1;
      if (duplicateCount > 0) {
        console.warn(JSON.stringify({
          timestamp: new Date(now).toISOString(),
          action: "nonce_replay_attempt",
          ip,
          nonce,
          duplicateCount,
          note: "ניסיון ריפולי אפשרי - nonce חוזר"
        }));
      }
    }

    // 4. בדיקת כותרות בקשות חשודות
    const suspiciousHeadersFound: string[] = [];
    for (const [key, value] of req.headers.entries()) {
      if (this.suspiciousHeaders.has(key.toLowerCase())) {
        suspiciousHeadersFound.push(`${key}: ${value}`);
      }
      // בדיקת User-Agent קיצוני
      if (key.toLowerCase() === "user-agent") {
        if (value.includes("bot") || value.includes("scraper") || value.length > 500) {
          suspiciousHeadersFound.push(`${key}: [חשוד]`);
        }
      }
    }
    if (suspiciousHeadersFound.length > 0) {
      console.warn(JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "suspicious_headers",
        ip,
        headers: suspiciousHeadersFound,
        note: "כותרות בקשה חשודות שנלכדו"
      }));
    }
  }

  private extractIP(req: NextRequest): string {
    // נטילת IP מקצה אחרון של XFF (לא ניתן לזיוף בקלות)
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const ips = xff.split(",").map(s => s.trim());
      return ips[ips.length - 1] || "unknown";
    }
    return req.ip || "unknown";
  }

  // שיטה לקבלת דו"ח מצב נוכחי
  getStatus() {
    return {
      trackedIPs: this.requestCounts.size,
      suspiciousPaths: Array.from(this.pathHistory.keys()).length,
      nonceTrackingActive: this.nonceHistory.size > 0
    };
  }
}

// מופע גלובלי של detector
const anomalyDetector = new AnomalyDetector();

export function withAnomalyDetection(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    // הקלטת בקשה למערכת הניטור
    anomalyDetector.recordRequest(req);
    
    try {
      const response = await handler(req);
      
      // הוספת כותרת המעידה על ניטור פעיל (ללא השפעה על התוכן)
      response.headers.set("x-anomaly-monitored", "true");
      
      return response;
    } catch (error) {
      console.error("Handler error:", error);
      // רישום אירוע שגיאה
      const now = Date.now();
      console.warn(JSON.stringify({
        timestamp: new Date(now).toISOString(),
        action: "handler_error",
        note: "שגיאה בטיפול בבקשה לאחר ניטור"
      }));
      throw error;
    }
  };
}

export { anomalyDetector };
