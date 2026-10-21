import type { NextRequest, NextResponse } from "next/server";

// ── פותח על-פי המפרט: /api/dex/metrics (כמודל-על) ──
// נקודת הקצה /metrics תומכת ב-scraping על ידי Prometheus.
// כל מדד כולל מטא-דאטה (type, help, labels) בפורמט exposition.

// מצב-זיכרון-מלא (בתור התחלה — ניתן להחליף ב-PersistentStore בהמשך).
const metricsState = {
  requestsTotal: 0,
  requestsLastSecond: 0,
  totalResponseTime: 0,
  requestCount: 0,
  errorCount: 0,
  successfulTransfers: 0,
  suspiciousActivityAttempts: 0,
  lastSecondReset: Date.now(),
};

// תא-זמן-מונוטוני לצורך חישוב-לשנייה.
let lastTick = Date.now();

export async function metricsHandler(_req: NextRequest): Promise<NextResponse> {
  // עדכון-לשנייה (מונוטוני).
  const now = Date.now();
  const deltaSec = Math.max(0, (now - lastTick) / 1000);
  if (deltaSec >= 1) {
    // העברה-לשנייה הנוכחית למצב-היסטורי והפעלה-מחדש.
    metricsState.requestsLastSecond = metricsState.requestsTotal - metricsState.requestsLastSecond;
    // (לשם פשטות — נשתמש בסך-הכל-מאז-אתחול למטה; בפועל הייתם שומרים מערך-טווח-זמן).
    lastTick = now;
  }

  // בניית-תוכן-פורמט-Prometheus.
  const lines: string[] = [];

  // עזרה-ליצירת-שורה.
  const metric = (name: string, type: "counter" | "gauge", help: string, labels: Record<string, string> = {}) => {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}=\"${v}\"`)
      .join(",");
    return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}${labelStr} `;
  };

  // מדד-בקשות-ל-API.
  lines.push(metric("saos_dex_requests_total", "counter", "סך-בקשות-ל-API", { endpoint: "/api/dex/*" }));
  lines.push(metric("saos_dex_requests_per_second", "gauge", "בקשות-ל-API-לשנייה"));
  lines.push(metric("saos_dex_average_response_time_ms", "gauge", "זמן-תגובה-ממוצע-במערכת-מילישניות", { endpoint: "/api/dex/*" }));
  lines.push(metric("saos_dex_error_rate", "gauge", "שיעור-שגיאות", { endpoint: "/api/dex/*" }));

  // מדדי-תפעול-גרעין.
  lines.push(metric("saos_dex_successful_transfer_operations", "counter", "מספר-פעולות-שער-העברה-מוצלחות"));
  lines.push(metric("saos_dex_suspicious_activity_attempts", "counter", "מספר-ניסיונות-התקפות-חשודות"));

  // ערכים-נוכחיים (מחושבים-על-פי-המצב).
  const total = metricsState.requestsTotal;
  const errors = metricsState.errorCount;
  const avgMs = total > 0 ? Math.round(metricsState.totalResponseTime / total) : 0;
  const errRate = total > 0 ? Math.round((errors / total) * 1000) / 1000 : 0;
  const rps = metricsState.requestsLastSecond || 0;

  lines.push(`${saos_dex_requests_per_second} ${rps}`);
  lines.push(`${saos_dex_average_response_time_ms} ${avgMs}`);
  lines.push(`${saos_dex_error_rate} ${errRate}`);
  lines.push(`${saos_dex_successful_transfer_operations} ${metricsState.successfulTransfers}`);
  lines.push(`${saos_dex_suspicious_activity_attempts} ${metricsState.suspiciousActivityAttempts}`);

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
}

// ── Middleware-אוטומטי (אופציונלי) ──
// מעדכן-את-המדדים על-כל-בקשה-ל-API-DEX.
export function attachMetricsMiddleware() {
  return async (req: NextRequest, _next: any) => {
    const start = Date.now();
    const res = await _next(req);
    const duration = Date.now() - start;
    metricsState.requestsTotal++;
    metricsState.totalResponseTime += duration;
    metricsState.requestCount++;
    // סימולציה-פשוטה של שיעור-שגיאות (בתור-תחליף-לוגיקה-אמיתית).
    if (res.status >= 500) metricsState.errorCount++;
    return res;
  };
}

// ── בדיקות-יחידה (vitest-סגנון) ──
// מאמתות שפורמט-הפלט-תקין-ומתוכנת-כצפוי.
/******************************************************************
 * unit-tests: metrics exposition format compliance
 ******************************************************************/
function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error("unit-test-fail: " + msg);
}

// בדיקה-בסיסית-של-פלט-טקסט-טהור.
try {
  // סימולציה-ידנית-של-מצב.
  metricsState.requestsTotal = 42;
  metricsState.errorCount = 3;
  metricsState.totalResponseTime = 210;
  metricsState.successfulTransfers = 10;
  metricsState.suspiciousActivityAttempts = 1;
  metricsState.requestsLastSecond = 5;
  metricsState.requestCount = 42;
  metricsState.requestsTotal = 42; // כפילות-לצורך-הדגמה
  const result = metricsHandler(new NextRequest("http://localhost"));
  const text = await result.text();
  // אימות-נוכחות-שורות-מפתח.
  assert(text.includes("# HELP saos_dex_requests_total"), "חסר HELP requests_total");
  assert(text.includes("# TYPE saos_dex_requests_total counter"), "חסר TYPE counter");
  assert(text.includes("saos_dex_requests_total 42"), "חסר ערך requests_total");
  assert(text.includes("saos_dex_requests_per_second"), "חסר rps");
  assert(text.includes("saos_dex_average_response_time_ms"), "חסר avgMs");
  assert(text.includes("saos_dex_error_rate"), "חסר errorRate");
  assert(text.includes("saos_dex_successful_transfer_operations"), "חסר successful_transfers");
  assert(text.includes("saos_dex_suspicious_activity_attempts"), "חסר suspicious_activity_attempts");
  console.log("unit-tests: all-passed");
} catch (e) {
  console.error("unit-tests: " + e);
}
