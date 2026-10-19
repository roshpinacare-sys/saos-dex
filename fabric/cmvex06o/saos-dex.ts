import { NextRequest, NextResponse } from 'next/server';

// ── מחלקת BehaviorAnalyzer — ניתוח התנהגות טראפיק ──
class BehaviorAnalyzer {
  private requestCounts = new Map<string, number>();
  private ipBehavior = new Map<string, {
    lastRequest: number;
    requestFrequency: number[];
    suspiciousPatterns: string[];
    riskScore: number;
  }>();
  private suspiciousHeaders = new Set([
    'x-forwarded-for',
    'x-real-ip',
    'via',
    'x-cluster-client-ip',
    'cf-connecting-ip',
    'true-client-ip'
  ]);

  // ניתון קצב בקשות ל-IP
  analyzeRequestRate(ip: string, windowMs: number = 60000): number {
    const now = Date.now();
    const ipData = this.ipBehavior.get(ip) || {
      lastRequest: now,
      requestFrequency: [],
      suspiciousPatterns: [],
      riskScore: 0
    };

    // הוספת חותמת זמן למערך הקצב
    ipData.requestFrequency.push(now);
    
    // סינון בקשות ישנות מעבר לחלון הזמן
    ipData.requestFrequency = ipData.requestFrequency.filter(
      timestamp => now - timestamp < windowMs
    );

    // חישוב קצב הבקשות
    const requestRate = ipData.requestFrequency.length;
    
    // עדכון נתוני ה-IP
    this.ipBehavior.set(ip, {
      ...ipData,
      lastRequest: now
    });

    return requestRate;
  }

  // זיהוי יעדים לא אופייניים
  analyzeTargetPath(path: string, ip: string): boolean {
    // דפים חשודים נפוצים בתקיפות
    const suspiciousPaths = [
      '/admin',
      '/wp-admin',
      '/phpmyadmin',
      '/.env',
      '/config',
      '/api/v1/admin',
      '/robots.txt',
      '/.git',
      '/backup'
    ];

    const isSuspicious = suspiciousPaths.some(suspicious => 
      path.includes(suspicious)
    );

    if (isSuspicious) {
      const ipData = this.ipBehavior.get(ip) || {
        lastRequest: Date.now(),
        requestFrequency: [],
        suspiciousPatterns: [],
        riskScore: 0
      };

      ipData.suspiciousPatterns.push(`suspicious-path:${path}`);
      this.ipBehavior.set(ip, ipData);
    }

    return isSuspicious;
  }

  // זיהוי כותרות חשודות
  analyzeHeaders(headers: Headers, ip: string): boolean {
    let hasSuspiciousHeaders = false;
    
    for (const [key, value] of headers.entries()) {
      if (this.suspiciousHeaders.has(key.toLowerCase())) {
        hasSuspiciousHeaders = true;
        
        const ipData = this.ipBehavior.get(ip) || {
          lastRequest: Date.now(),
          requestFrequency: [],
          suspiciousPatterns: [],
          riskScore: 0
        };

        ipData.suspiciousPatterns.push(`suspicious-header:${key}:${value}`);
        this.ipBehavior.set(ip, ipData);
      }
    }

    return hasSuspiciousHeaders;
  }

  // זיהוי רצף בקשות חוזרות עם אותו nonce
  analyzeNoncePatterns(headers: Headers, ip: string): boolean {
    const nonce = headers.get('x-nonce') || headers.get('nonce');
    if (!nonce) return false;

    const ipData = this.ipBehavior.get(ip) || {
      lastRequest: Date.now(),
      requestFrequency: [],
      suspiciousPatterns: [],
      riskScore: 0
    };

    // בדיקה אם ה-nonce כבר נרשם עבור IP זה
    const existingNonce = ipData.suspiciousPatterns.find(pattern => 
      pattern.startsWith(`nonce:${nonce}`)
    );

    if (existingNonce) {
      // עדכון רשומת ה-nonce עם חותמת זמן חדשה
      const updatedPatterns = ipData.suspiciousPatterns.filter(pattern => 
        !pattern.startsWith(`nonce:${nonce}`)
      );
      
      updatedPatterns.push(`nonce:${nonce}:${Date.now()}`);
      
      this.ipBehavior.set(ip, {
        ...ipData,
        suspiciousPatterns: updatedPatterns
      });
      
      return true;
    } else {
      // רישום nounce חדש
      ipData.suspiciousPatterns.push(`nonce:${nonce}:${Date.now()}`);
      this.ipBehavior.set(ip, ipData);
    }

    return false;
  }

  // חישוב ציון סיכון
  calculateRiskScore(ip: string): number {
    const ipData = this.ipBehavior.get(ip);
    if (!ipData) return 0;

    let score = 0;
    
    // ניקוד על פי קצב בקשות
    const requestRate = this.analyzeRequestRate(ip);
    if (requestRate > 100) score += 3;
    else if (requestRate > 50) score += 2;
    else if (requestRate > 20) score += 1;

    // ניקוד על פי דפים חשודים
    const suspiciousPaths = ipData.suspiciousPatterns.filter(pattern => 
      pattern.startsWith('suspicious-path:')
    ).length;
    score += suspiciousPaths * 2;

    // ניקוד על פי כותרות חשודות
    const suspiciousHeaders = ipData.suspiciousPatterns.filter(pattern => 
      pattern.startsWith('suspicious-header:')
    ).length;
    score += suspiciousHeaders * 1.5;

    // ניקוד על פי רצפי nonce
    const suspiciousNonces = ipData.suspiciousPatterns.filter(pattern => 
      pattern.startsWith('nonce:')
    ).length;
    score += suspiciousNonces * 3;

    // עדכון ציון הסיכון
    ipData.riskScore = Math.min(score, 10); // מגבלת ציון מרבית של 10
    this.ipBehavior.set(ip, ipData);

    return ipData.riskScore;
  }

  // חסימה הדרגתית
  getBlockingDuration(riskScore: number): number {
    if (riskScore >= 8) return 24 * 60 * 60 * 1000; // 24 שעות
    if (riskScore >= 6) return 4 * 60 * 60 * 1000;  // 4 שעות
    if (riskScore >= 4) return 60 * 60 * 1000;      // שעה
    if (riskScore >= 2) return 10 * 60 * 1000;      // 10 דקות
    return 0; // אין חסימה
  }

  // רישום חריגות ללוג
  logSuspiciousActivity(ip: string, riskScore: number, details: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      ip,
      riskScore,
      details
    };
    
    // כאן ניתן להוסיף לוגים למערכת לוגים חיצונית
    console.log('SUSPICIOUS_ACTIVITY:', JSON.stringify(logEntry));
    
    // דוגמה לשמירה במסד נתונים
    // saveToDatabase('security_logs', logEntry);
  }
}

// יצירת מופע של המנתח
const behaviorAnalyzer = new BehaviorAnalyzer();

// ── הטמעה במידלוואר ──
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const ip = request.ip || 'unknown';
  const path = request.nextUrl.pathname;
  const headers = request.headers;

  // בדיקות התנהגות
  const requestRate = behaviorAnalyzer.analyzeRequestRate(ip);
  const hasSuspiciousPath = behaviorAnalyzer.analyzeTargetPath(path, ip);
  const hasSuspiciousHeaders = behaviorAnalyzer.analyzeHeaders(headers, ip);
  const hasRepeatedNonce = behaviorAnalyzer.analyzeNoncePatterns(headers, ip);

  // חישוב ציון סיכון
  const riskScore = behaviorAnalyzer.calculateRiskScore(ip);
  const blockingDuration = behaviorAnalyzer.getBlockingDuration(riskScore);

  // אם יש סיכון וצריך חסימה
  if (blockingDuration > 0) {
    const details = `High risk score: ${riskScore}. Blocked for ${blockingDuration / 60000} minutes.`;
    behaviorAnalyzer.logSuspiciousActivity(ip, riskScore, details);
    
    // יצירת תגובת חסימה
    return new NextResponse('Access denied due to suspicious activity', {
      status: 403,
      headers: {
        'X-Risk-Score': riskScore.toString(),
        'X-Block-Duration': blockingDuration.toString(),
        'Content-Type': 'text/plain'
      }
    });
  }

  // אם יש פעילות חשודה אך לא מספיק חמורה לחסימה
  if (riskScore > 0) {
    const details = `Suspicious activity detected. Risk score: ${riskScore}. Path: ${path}, Headers: ${hasSuspiciousHeaders}, Nonce pattern: ${hasRepeatedNonce}`;
    behaviorAnalyzer.logSuspiciousActivity(ip, riskScore, details);
  }

  // המשך עם הבקשה הרגילה אם לא נמצאה פעילות חשודה מספיק
  return NextResponse.next();
}

// הגדרת נתיבים שעליהם יופעל המידלוואר
export const config = {
  matcher: [
    '/api/:path*',
    '/admin/:path*',
    '/dashboard/:path*'
  ]
};