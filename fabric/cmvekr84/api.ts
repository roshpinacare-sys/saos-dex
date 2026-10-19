import { NextRequest, NextResponse } from 'next/server';

// ── רשימת דפוסי תקיפה ידועים ──
const attackPatterns = {
  sqlInjection: /\b(union|select|insert|delete|update|drop|create|alter|exec|execute|xp_cmdshell|sp_executesql|truncate|alter)\b/i,
  xss: /<\s*script[^>]*?>|<\s*\/\s*script>|javascript:|on\w+\s*=\s*['"]?javascript:/i,
  pathTraversal: /\.\.\//i,
  ssrf: /(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/i,
  commandInjection: /\b(cmd|exec|eval|system|passthru|shell_exec|exec|proc_open|popen|`|\\$\(|\\${)/i,
  ldapInjection: /\b(\(|\)|\*|\\|&|!|\||\^|=|>|<|;|\(|\)|\$|\{|\}|\\)/i,
  xxe: /<!DOCTYPE|<!ENTITY|SYSTEM|PUBLIC|\]\s*>/i,
};

// ── מנגנון חסימה הדרגתית ──
const ipBlocker = new Map<string, {
  count: number;
  lastAttempt: number;
  blocked: boolean;
}>();

const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 60 * 60 * 1000; // 1 שעה

function isIpBlocked(ip: string): boolean {
  const record = ipBlocker.get(ip);
  if (!record) return false;
  
  if (record.blocked && Date.now() - record.lastAttempt > BLOCK_DURATION) {
    ipBlocker.delete(ip);
    return false;
  }
  
  return record.blocked;
}

function incrementIpAttempts(ip: string) {
  const now = Date.now();
  const record = ipBlocker.get(ip) || { count: 0, lastAttempt: now, blocked: false };
  
  record.count += 1;
  record.lastAttempt = now;
  
  if (record.count >= MAX_ATTEMPTS && !record.blocked) {
    record.blocked = true;
    console.warn(`[SECURITY] IP ${ip} blocked after ${MAX_ATTEMPTS} attack attempts`);
  }
  
  ipBlocker.set(ip, record);
}

// ── פונקציה לניתוח פרמטרים ──
function analyzeParameters(request: NextRequest): { detected: boolean; type?: string; details?: string } {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  
  // בדיקת query params
  for (const [key, value] of params) {
    for (const [type, pattern] of Object.entries(attackPatterns)) {
      if (pattern.test(value)) {
        return {
          detected: true,
          type,
          details: `Query param '${key}' contains suspicious pattern: ${value}`
        };
      }
    }
  }
  
  // בדיקת headers
  const headers = request.headers;
  for (const [key, value] of headers.entries()) {
    for (const [type, pattern] of Object.entries(attackPatterns)) {
      if (pattern.test(value)) {
        return {
          detected: true,
          type,
          details: `Header '${key}' contains suspicious pattern: ${value}`
        };
      }
    }
  }
  
  // בדיקת body עבור POST/PUT
  if (['POST', 'PUT'].includes(request.method)) {
    try {
      const body = request.body;
      if (body) {
        // בדיקת JSON body
        if (headers.get('content-type')?.includes('application/json')) {
          const text = typeof body === 'string' ? body : await (body as any).text();
          try {
            const json = JSON.parse(text);
            
            const scanObject = (obj: any, path = '') => {
              for (const [key, value] of Object.entries(obj)) {
                const currentPath = path ? `${path}.${key}` : key;
                
                if (typeof value === 'string') {
                  for (const [type, pattern] of Object.entries(attackPatterns)) {
                    if (pattern.test(value)) {
                      return {
                        detected: true,
                        type,
                        details: `JSON body path '${currentPath}' contains suspicious pattern: ${value}`
                      };
                    }
                  }
                } else if (typeof value === 'object' && value !== null) {
                  const result = scanObject(value, currentPath);
                  if (result.detected) return result;
                }
              }
              return { detected: false };
            };
            
            const result = scanObject(json);
            if (result.detected) return result;
          } catch (e) {
            // JSON לא תקין, נמשיך לבדיקת form data
          }
        }
        
        // בדיקת form data
        if (headers.get('content-type')?.includes('form')) {
          const formData = await (body as any).formData();
          for (const [key, value] of formData.entries()) {
            if (typeof value === 'string') {
              for (const [type, pattern] of Object.entries(attackPatterns)) {
                if (pattern.test(value)) {
                  return {
                    detected: true,
                    type,
                    details: `Form field '${key}' contains suspicious pattern: ${value}`
                  };
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[SECURITY] Error parsing request body:', e);
    }
  }
  
  return { detected: false };
}

// ── פונקציית המידלוור ──
export async function middleware(request: NextRequest): Promise<NextResponse> {
  // קבלת IP מהקצה האמיתי (הכי קרוב לשרת)
  const ip = 
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
    request.headers.get('x-real-ip') || 
    'unknown';
  
  // בדיקה אם ה-IP חסום
  if (isIpBlocked(ip)) {
    return new NextResponse(
      JSON.stringify({ 
        error: 'Access denied', 
        message: 'Your IP has been blocked due to suspicious activity' 
      }),
      { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      }
    );
  }
  
  // פטורים מבדיקות (כמו במידלוור הקיים)
  const exemptPaths = ['/api/dex/stream', '/api/revive'];
  if (exemptPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    return NextResponse.next();
  }
  
  // ניתוח הפרמטרים
  const analysis = analyzeParameters(request);
  
  if (analysis.detected) {
    // רישום ניסיון התקפה
    console.log(`[SECURITY ALERT] Attack detected from IP ${ip}:`, {
      type: analysis.type,
      details: analysis.details,
      method: request.method,
      url: request.url,
      userAgent: request.headers.get('user-agent'),
      timestamp: new Date().toISOString()
    });
    
    // הגבלת ניסיונות מה-IP
    incrementIpAttempts(ip);
    
    // החזרת שגיאה
    return new NextResponse(
      JSON.stringify({ 
        error: 'Security violation', 
        message: 'Malicious request detected' 
      }),
      { 
        status: 403, 
        headers: { 
          'Content-Type': 'application/json',
          'X-Security-Alert': analysis.type || 'unknown'
        } 
      }
    );
  }
  
  // המשך עם בקשה תקינה
  return NextResponse.next();
}

// ── חשיפת הפונקציה לכל הנתיבים ──
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
