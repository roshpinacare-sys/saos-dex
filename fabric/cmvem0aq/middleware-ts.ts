import { NextRequest, NextResponse } from 'next/server';

// ── מנגנון סטטיסטיקות וסיווג בקשות ──
interface RequestStats {
  total: number;
  byMethod: Record<string, number>;
  byStatusCode: Record<string, number>;
  byPath: Record<string, number>;
  suspicious: {
    count: number;
    byIP: Record<string, number>;
    byPath: Record<string, number>;
    signatures: SuspiciousRequest[];
  };
}

interface SuspiciousRequest {
  timestamp: number;
  ip: string;
  method: string;
  path: string;
  reason: string;
  details: Record<string, unknown>;
}

const stats: RequestStats = {
  total: 0,
  byMethod: {},
  byStatusCode: {},
  byPath: {},
  suspicious: {
    count: 0,
    byIP: {},
    byPath: {},
    signatures: [],
  },
};

// ── פונקציות עזר לזיהוי חריגות ──
const CRITICAL_PATHS = [
  '/api/dex/agent',
  '/api/dex/order',
  '/api/dex/swap',
  '/api/dex/bridge',
  '/api/dex/wallets',
];

const ATTACK_PATTERNS = {
  sqlInjection: /('('|\"|;|\||\-|\#|\*|\-\-|\/\*|\*\/|\b(ALTER|CREATE|DELETE|DROP|EXEC(UTE){0,1}|INSERT( +INTO){0,1}|MERGE|SELECT|UPDATE|UNION( +ALL){0,1})\b))/i,
  pathTraversal: /\.\.|\\\\|\%2e\%2e\%2f/i,
  xss: /<script|javascript:|on\w+\s*=|<iframe|<img\s*src\s*=|<body\s*onload/i,
};

function analyzeRequest(req: NextRequest, ip: string): { suspicious: boolean; reason: string; details: Record<string, unknown> } {
  const method = req.method;
  const path = req.nextUrl.pathname;
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const referer = req.headers.get('referer') || 'none';
  
  const details: Record<string, unknown> = {
    method,
    path,
    userAgent,
    referer,
    headers: Object.fromEntries(req.headers.entries()),
  };

  // בדיקת נתיבים קריטיים
  if (CRITICAL_PATHS.some(cp => path.startsWith(cp))) {
    details.criticalPath = true;
    return { suspicious: true, reason: 'critical_path_access', details };
  }

  // בדיקת פרמטרים חשודים
  const searchParams = req.nextUrl.searchParams;
  for (const [key, value] of searchParams.entries()) {
    if (ATTACK_PATTERNS.sqlInjection.test(value)) {
      details.suspiciousParam = key;
      details.paramValue = value;
      return { suspicious: true, reason: 'sql_injection_attempt', details };
    }
    
    if (ATTACK_PATTERNS.pathTraversal.test(value)) {
      details.suspiciousParam = key;
      details.paramValue = value;
      return { suspicious: true, reason: 'path_traversal_attempt', details };
    }
    
    if (ATTACK_PATTERNS.xss.test(value)) {
      details.suspiciousParam = key;
      details.paramValue = value;
      return { suspicious: true, reason: 'xss_attempt', details };
    }
  }

  // בדיקת כותרות חשודות
  const contentType = req.headers.get('content-type');
  if (contentType && !['application/json', 'application/x-www-form-urlencoded'].includes(contentType)) {
    details.unusualContentType = contentType;
  }

  return { suspicious: false, reason: '', details };
}

function updateStats(req: NextRequest, res: NextResponse, ip: string, suspicious: boolean, reason: string, details: Record<string, unknown>) {
  const method = req.method;
  const statusCode = res.status;
  const path = req.nextUrl.pathname;
  
  stats.total++;
  stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
  stats.byStatusCode[statusCode] = (stats.byStatusCode[statusCode] || 0) + 1;
  stats.byPath[path] = (stats.byPath[path] || 0) + 1;

  if (suspicious) {
    stats.suspicious.count++;
    stats.suspicious.byIP[ip] = (stats.suspicious.byIP[ip] || 0) + 1;
    stats.suspicious.byPath[path] = (stats.suspicious.byPath[path] || 0) + 1;
    
    const signature: SuspiciousRequest = {
      timestamp: Date.now(),
      ip,
      method,
      path,
      reason,
      details,
    };
    
    stats.suspicious.signatures.push(signature);
    
    // שמירה על רשימה מוגבלת של חתימות חשודות (1000 האחרונות)
    if (stats.suspicious.signatures.length > 1000) {
      stats.suspicious.signatures = stats.suspicious.signatures.slice(-1000);
    }
  }
}

// ── API endpoint לגישה לסטטיסטיקות ──
export async function GET(req: NextRequest) {
  if (req.nextUrl.pathname !== '/api/stats') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // בדיקת הרשאות פשוטה (ביישום מציאותי יהיה כאן אימות מלא)
  const authHeader = req.headers.get('authorization');
  if (!authHeader || authHeader !== 'Bearer saos-dex-monitor') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    stats,
    timestamp: Date.now(),
  });
}

// ── פונקציית ה-middleware הראשית ──
export async function middleware(req: NextRequest) {
  const start = Date.now();
  
  // קבלת IP מהקצה האמיתי (האחרון ב-X-Forwarded-For)
  const xForwardedFor = req.headers.get('x-forwarded-for');
  const ip = xForwardedFor ? xForwardedFor.split(',').pop()?.trim() || 'unknown' : 'unknown';
  
  // ניתוח בקשה לזיהוי חריגות
  const { suspicious, reason, details } = analyzeRequest(req, ip);
  
  // המשך ביצוע הבקשה
  const res = NextResponse.next();
  
  // עדכון סטטיסטיקות
  updateStats(req, res, ip, suspicious, reason, details);
  
  // רישום בקשות חשודות בלוג
  if (suspicious) {
    console.warn(
      `[SECURITY] Suspicious request detected: ${reason} from ${ip} to ${req.nextUrl.pathname}`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ip,
        method: req.method,
        path: req.nextUrl.pathname,
        reason,
        details,
      }, null, 2)
    );
  }
  
  // הוספת כותרת עם מידע על ביצועים
  res.headers.set('x-response-time', `${Date.now() - start}ms`);
  
  return res;
}

// ── הגדרת נתיבים שיושפעו מה-middleware ──
export const config = {
  matcher: [
    '/api/:path*',
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};