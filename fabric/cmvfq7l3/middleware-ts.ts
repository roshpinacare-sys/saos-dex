import { NextRequest, NextResponse } from 'next/server';

// ── מנגנון ניתוח התנהגותי מתקדם ──

// תצורת כללי הזיהוי
interface DetectionRule {
  id: string;
  name: string;
  description: string;
  weight: number;
  condition: (req: NextRequest, ip: string, state: RequestState) => boolean;
}

// מצב הבקשות לכל IP
interface RequestState {
  count: number;
  firstRequest: number;
  lastRequest: number;
  paths: Map<string, number>;
  suspiciousPaths: Map<string, Set<string>>;
  nonces: Map<string, number>;
  headers: Map<string, number>;
  riskScore: number;
}

// תצורת המערכת
interface BehavioralAnalysisConfig {
  enabled: boolean;
  riskThreshold: number;
  blockThreshold: number;
  decayIntervalMs: number;
  maxRequestsPerWindow: number;
  sensitivePaths: string[];
}

const DEFAULT_CONFIG: BehavioralAnalysisConfig = {
  enabled: true,
  riskThreshold: 70,
  blockThreshold: 90,
  decayIntervalMs: 60_000, // דקה אחת
  maxRequestsPerWindow: 100,
  sensitivePaths: [
    '/api/dex/settle',
    '/api/dex/transfer',
    '/api/dex/order',
    '/api/dex/cancel',
    '/api/dex/swap'
  ]
};

// מצב גלובלי של המערכת
const ipStates = new Map<string, RequestState>();
const config = DEFAULT_CONFIG;

// כללי זיהוי
const detectionRules: DetectionRule[] = [
  {
    id: 'REQUEST_RATE_SPIKE',
    name: 'זינוק בקצב הבקשות',
    description: 'זיהוי זינוק פתאומי בקצב הבקשות לכל IP',
    weight: 30,
    condition: (req, ip, state) => {
      const now = Date.now();
      const timeWindow = 10_000; // 10 שניות
      
      if (now - state.firstRequest < timeWindow) {
        const rate = state.count / ((now - state.firstRequest) / 1000);
        return rate > 20; // יותר מ-20 בקשות לשנייה
      }
      return false;
    }
  },
  {
    id: 'SENSITIVE_PATH_ACCESS',
    name: 'גישה לנתיבים רגישים',
    description: 'ניטור גישה חוזרת לנתיבים רגישים עם פרמטרים מוזרים',
    weight: 25,
    condition: (req, ip, state) => {
      const path = req.nextUrl.pathname;
      if (!config.sensitivePaths.includes(path)) return false;
      
      // בדיקת פרמטרים מוזרים
      const params = req.nextUrl.searchParams;
      const suspiciousParams = ['debug', 'test', 'admin', 'root'];
      
      for (const param of suspiciousParams) {
        if (params.has(param)) {
          const value = params.get(param);
          if (value && value.length > 5) {
            return true;
          }
        }
      }
      
      // בדיקת גישה חוזרת לאותו נתיב עם פרמטרים שונים
      const pathCount = state.paths.get(path) || 0;
      if (pathCount > 5) {
        return true;
      }
      
      return false;
    }
  },
  {
    id: 'SUSPICIOUS_NONCE_SEQUENCE',
    name: 'רצף בקשות חשודות עם nonce',
    description: 'זיהוי רצף בקשות חשודות עם אותו nonce',
    weight: 35,
    condition: (req, ip, state) => {
      const path = req.nextUrl.pathname;
      if (path !== '/api/dex/order') return false;
      
      const nonce = req.nextUrl.searchParams.get('nonce');
      if (!nonce) return false;
      
      const nonceCount = state.nonces.get(nonce) || 0;
      if (nonceCount > 10) {
        return true;
      }
      
      return false;
    }
  },
  {
    id: 'SUSPICIOUS_HEADERS',
    name: 'כותרות בקשות חריגות',
    description: 'זיהוי כותרות בקשות חריגות או חשודות',
    weight: 20,
    condition: (req, ip, state) => {
      const suspiciousHeaders = [
        'x-forwarded-for',
        'x-real-ip',
        'via',
        'x-cluster-client-ip'
      ];
      
      for (const header of suspiciousHeaders) {
        const value = req.headers.get(header);
        if (value && value.length > 20) {
          return true;
        }
      }
      
      return false;
    }
  }
];

// פונקציית עזר לקבלת IP
function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    // לוקחים את ה-IP האחרון ב-XFF (הקרוב לשרת)
    return forwarded.split(',').pop()?.trim() || '';
  }
  return req.ip || '';
}

// עדכון מצב הבקשות
function updateRequestState(ip: string, req: NextRequest): RequestState {
  const now = Date.now();
  let state = ipStates.get(ip);
  
  if (!state) {
    state = {
      count: 0,
      firstRequest: now,
      lastRequest: now,
      paths: new Map(),
      suspiciousPaths: new Map(),
      nonces: new Map(),
      headers: new Map(),
      riskScore: 0
    };
    ipStates.set(ip, state);
  }
  
  // עדכון ספירת הבקשות
  state.count++;
  state.lastRequest = now;
  
  // עדכון נתיבים
  const path = req.nextUrl.pathname;
  state.paths.set(path, (state.paths.get(path) || 0) + 1);
  
  // עדכון nonces
  if (path === '/api/dex/order') {
    const nonce = req.nextUrl.searchParams.get('nonce');
    if (nonce) {
      state.nonces.set(nonce, (state.nonces.get(nonce) || 0) + 1);
    }
  }
  
  // עדכון כותרות
  req.headers.forEach((value, name) => {
    const key = `${name}:${value.substring(0, 10)}`;
    state.headers.set(key, (state.headers.get(key) || 0) + 1);
  });
  
  return state;
}

// חישוב ציון הסיכון
function calculateRiskScore(req: NextRequest, ip: string, state: RequestState): number {
  let score = 0;
  
  // הפעלת כללי הזיהוי
  for (const rule of detectionRules) {
    try {
      if (rule.condition(req, ip, state)) {
        score += rule.weight;
        console.log(`[BEHAVIORAL_ANALYSIS] נתגלה חריגה: ${rule.name} - ${rule.description}`);
      }
    } catch (error) {
      console.error(`[BEHAVIORAL_ANALYSIS] שגיאה בהערכת כלל ${rule.id}:`, error);
    }
  }
  
  // נורמליזציה של ציון הסיכון
  state.riskScore = Math.min(100, score);
  
  return state.riskScore;
}

// פונקציית דעיכה להפחתת ציוני סיכון
function decayRiskScores() {
  const now = Date.now();
  
  for (const [ip, state] of ipStates.entries()) {
    // אם חלף פרק זמן מספיק מאז הבקשה האחרונה
    if (now - state.lastRequest > config.decayIntervalMs) {
      state.riskScore = Math.max(0, state.riskScore - 10);
      
      // אם הציון ירד לאפס, מוחקים את המצב
      if (state.riskScore === 0) {
        ipStates.delete(ip);
      }
    }
  }
}

// הפעלת טיימר לדעיכה קבועה
setInterval(decayRiskScores, config.decayIntervalMs);

// ── פונקציית המידלוור הראשית ──
export async function middleware(req: NextRequest): Promise<NextResponse> {
  // בדיקה אם המערכת מופעלת
  if (!config.enabled) {
    return NextResponse.next();
  }
  
  const ip = getClientIp(req);
  
  // עדכון מצב הבקשות
  const state = updateRequestState(ip, req);
  
  // חישוב ציון הסיכון
  const riskScore = calculateRiskScore(req, ip, state);
  
  // בדיקת חסימה
  if (riskScore >= config.blockThreshold) {
    console.log(`[BEHAVIORAL_ANALYSIS] חסימת IP ${ip} - ציון סיכון גבוה: ${riskScore}`);
    return new NextResponse('גישה נחסמה מסיבות אבטחה', { status: 429 });
  }
  
  // בדיקת תקרת בקשות
  if (state.count > config.maxRequestsPerWindow) {
    console.log(`[BEHAVIORAL_ANALYSIS] חריגת תקרת בקשות ל-IP ${ip}`);
    return new NextResponse('תקרת בקשות חרגה', { status: 429 });
  }
  
  // הוספת כותרת עם ציון הסיכון לבקשה (לניטור פנימי)
  const response = NextResponse.next();
  response.headers.set('X-Risk-Score', riskScore.toString());
  
  return response;
}

// ── ניתוח ודיווח ──
export function analyzeThreats(): {
  totalIps: number;
  highRiskIps: number;
  blockedRequests: number;
  detectedAttacks: string[];
} {
  let highRiskIps = 0;
  const detectedAttacks: string[] = [];
  
  for (const [ip, state] of ipStates.entries()) {
    if (state.riskScore >= config.riskThreshold) {
      highRiskIps++;
      
      // איסוף מידע על התקפות
      const attackInfo = {
        ip,
        riskScore: state.riskScore,
        requestCount: state.count,
        suspiciousPaths: Array.from(state.suspiciousPaths.keys())
      };
      
      detectedAttacks.push(JSON.stringify(attackInfo));
    }
  }
  
  return {
    totalIps: ipStates.size,
    highRiskIps,
    blockedRequests: highRiskIps,
    detectedAttacks
  };
}

// ── ייצור דוח ניתוח התנהגות ──
export function generateBehaviorReport(): string {
  const report = {
    timestamp: new Date().toISOString(),
    config,
    threats: analyzeThreats(),
    detectionRules: detectionRules.map(rule => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      weight: rule.weight
    })),
    ipStates: Array.from(ipStates.entries()).map(([ip, state]) => ({
      ip,
      riskScore: state.riskScore,
      requestCount: state.count,
      paths: Array.from(state.paths.entries()),
      nonces: Array.from(state.nonces.entries())
    }))
  };
  
  return JSON.stringify(report, null, 2);
}
