import { NextRequest, NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const LIMIT_INTERNAL = 2_000;
const LIMIT_PUBLIC = 240;
const MAX_KEYS = 5_000;
const EXEMPT = ["/api/dex/stream", "/api/revive"];

// ── cmvdkj2e (מאושר): התראה-מוקדמת-מדודה ──
const EARLY_WARN_THRESHOLD = 100;
const lastWarn = new Map<string, number>();
const EARLY_WARN_MAX_KEYS = 5_000;

function earlyWarn(ip: string, pathname: string, now: number): void {
  const prev = lastWarn.get(ip);
  if (prev !== undefined && now - prev < WINDOW_MS) return;
  lastWarn.set(ip, now);
  if (lastWarn.size > EARLY_WARN_MAX_KEYS) {
    const oldest = lastWarn.keys().next().value;
    if (oldest !== undefined) lastWarn.delete(oldest);
  }
  console.warn(
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      action: "traffic_alert",
      ip,
      path: pathname,
      note: `crossed ${EARLY_WARN_THRESHOLD} req/min`,
    })
  );
}

// ── ניטור חריגות ספציפי (Task 39) ──
const ANOMALY_WINDOW_MS = 60_000;
const ANOMALY_MAX_ORDERS_PER_IP = 50; // סף קבוע מראש
const orderHistory = new Map<string, number[]>(); // ip -> מערך timestamps
const agentCreationCount = new Map<string, number>(); // ip -> count per window

// סוגי פעולות חריגות מוגדרים מראש
enum AnomalyType {
  AGENT_MODIFICATION = "agent_modification",
  ORDER_SPIKE = "order_spike",
  SWAP_SLIPPAGE_ANOMALY = "swap_slippage_anomaly",
}

interface AnomalyLog {
  timestamp: string;
  endpoint: string;
  type: AnomalyType;
  details: Record<string, unknown>;
  severity: "low" | "medium" | "high";
  userId?: string;
}

function logAnomaly(log: AnomalyLog): void {
  console.warn(JSON.stringify(log));
}

function checkOrderSpike(ip: string, now: number, orderCount: number): boolean {
  const timestamps = orderHistory.get(ip) || [];
  // ניקוי timestamps ישנים מחוץ לחלון
  const valid = timestamps.filter((t) => now - t < ANOMALY_WINDOW_MS);
  orderHistory.set(ip, valid);
  // אם חרגנו מהסף בחלון הנוכחי
  if (valid.length > ANOMALY_MAX_ORDERS_PER_IP) {
    logAnomaly({
      timestamp: new Date(now).toISOString(),
      endpoint: "/api/dex/order",
      type: AnomalyType.ORDER_SPIKE,
      details: { orderCount, recentCount: valid.length, windowMs: ANOMALY_WINDOW_MS },
      severity: "high",
      userId: ip,
    });
    return true;
  }
  return false;
}

function checkSwapSlippageAnomaly(ip: string, now: number, slippage: number): boolean {
  // סף glide: slippage > 5% נחשב חריג ברירת מחדל
  const SLIPPAGE_THRESHOLD = 0.05;
  if (slippage > SLIPPAGE_THRESHOLD) {
    logAnomaly({
      timestamp: new Date(now).toISOString(),
      endpoint: "/api/dex/swap",
      type: AnomalyType.SWAP_SLIPPAGE_ANOMALY,
      details: { slippage, threshold: SLIPPAGE_THRESHOLD, ip },
      severity: "medium",
      userId: ip,
    });
    return true;
  }
  return false;
}

function checkAgentModification(ip: string, agentCount: number): boolean {
  // ניטור עלייה פתאומית במספר סוכנים שנוצרו מאותה כתובת IP
  const prevCount = agentCreationCount.get(ip) || 0;
  if (agentCount - prevCount >= 5 && agentCount >= 10) {
    logAnomaly({
      timestamp: new Date().toISOString(),
      endpoint: "/api/dex/agent",
      type: AnomalyType.AGENT_MODIFICATION,
      details: { previousCount: prevCount, currentCount: agentCount, ip },
      severity: "high",
      userId: ip,
    });
    agentCreationCount.set(ip, agentCount);
    return true;
  }
  agentCreationCount.set(ip, agentCount);
  return false;
}

export async function rateLimitMiddleware(req: NextRequest, next: () => Promise<NextResponse>) {
  const ip = req.ip || "unknown";
  const pathname = req.nextUrl.pathname;
  const now = Date.now();

  // פטורים קיימים
  if (EXEMPT.some((p) => pathname.startsWith(p))) {
    return next();
  }

  // rate limiting בסיסי (לא משתנה)
  const isInternal = req.headers.get("x-forwarded-for") === null;
  const limit = isInternal ? LIMIT_INTERNAL : LIMIT_PUBLIC;
  const key = ip;
  const prev = lastWarn.get(key);
  if (prev !== undefined && now - prev < WINDOW_MS) {
    if (lastWarn.size > MAX_KEYS) {
      const oldest = lastWarn.keys().next().value;
      if (oldest !== undefined) lastWarn.delete(oldest);
    }
    lastWarn.set(key, now);
  } else {
    lastWarn.set(key, now);
    if (lastWarn.size > MAX_KEYS) {
      const oldest = lastWarn.keys().next().value;
      if (oldest !== undefined) lastWarn.delete(oldest);
    }
  }

  // ניטור חריגות ספציפי (לא פוגע ב-rate limiting)
  if (pathname === "/api/dex/order") {
    // ננסה למצוא מספר הזמנות בבקשה (למשל מגוף JSON)
    let orderCount = 1; // ברירת מחדל: לפחות הזמנה אחת
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        // ספירת הזמנות אם קיימת מערך
        if (Array.isArray(body.orders)) {
          orderCount = body.orders.length;
        } else if (body.orderId) {
          orderCount = 1;
        }
      }
    } catch {
      // אם לא ניתן לקרוא גוף הבקשה – נמשיך עם ברירת מחדל
    }
    checkOrderSpike(ip, now, orderCount);
  }

  if (pathname === "/api/dex/swap") {
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        // בדיקת slippage אם קיימת
        if (typeof body.slippage === "number") {
          checkSwapSlippageAnomaly(ip, now, body.slippage);
        }
        // בדיקת נפח swap
        if (typeof body.amountIn === "number" || typeof body.amountOut === "number") {
          // ניטור נפח חריג מתבצע דרך checkOrderSpike או כללים נוספים
        }
      }
    } catch {
      // המשך אם גוף הבקשה אינו JSON
    }
  }

  if (pathname === "/api/dex/agent") {
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        // ניטור יצירת/שינוי סוכן
        if (body.agentId || body.action === "create" || body.action === "update") {
          checkAgentModification(ip, (body.count || 1));
        }
      }
    } catch {
      // המשך אם גוף הבקשה אינו JSON
    }
  }

  return next();
}
