import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

// פונקציית עזר לאימות JWT
function verifyToken(token: string): any {
  try {
    // ביישום אמיתי, יש להגדיר סוד סודי מאובטח מתוך משתני הסביבה
    const secret = process.env.JWT_SECRET || 'your-secret-key';
    return jwt.verify(token, secret);
  } catch (error) {
    return null;
  }
}

// פונקציית עזר לבדיקת הרשאות
function hasPermission(userRole: string, requiredRole: string): boolean {
  // ביישום אמיתי, יש ליישם לוגיקה מורכבת יותר של בדיקת הרשאות
  // לצורך הדוגמה, מניחים שמנהל יכול לגשת לכל המשתמשים
  if (userRole === 'admin') return true;
  
  // משתמשים רגילים יכולים לגשת רק למידע על עצמם
  return userRole === requiredRole;
}

export function middleware(request: NextRequest) {
  // ניתוב ספציפי ל-API של משתמשים
  if (request.nextUrl.pathname.startsWith('/api/v1/users')) {
    // בדיקה אם קיימת כותרת הרשאה
    const authHeader = request.headers.get('authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Authorization header missing or malformed' },
        { status: 401 }
      );
    }
    
    // הפשטת ה-TOKEN מהכותרת
    const token = authHeader.substring(7);
    
    // אימות ה-TOKEN
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      );
    }
    
    // בדיקת הרשאות בהתאם לנתיב
    if (request.nextUrl.pathname === '/api/v1/users') {
      // רק מנהלים יכולים לגשת לרשימת כל המשתמשים
      if (decoded.role !== 'admin') {
        return NextResponse.json(
          { error: 'Insufficient permissions' },
          { status: 403 }
        );
      }
    } else {
      // עבור נתיבים ספציפיים של משתמשים, בדיקה אם המשתמש יכול לגשת למידע של עצמו
      const requestedUserId = request.nextUrl.pathname.split('/').pop();
      
      if (decoded.id !== requestedUserId && decoded.role !== 'admin') {
        return NextResponse.json(
          { error: 'Access denied to user data' },
          { status: 403 }
        );
      }
    }
    
    // אם כל הבדיקות עברו בהצלחה, ממשיכים לבקשה הבאה
    return NextResponse.next();
  }
  
  // עבור כל הנתיבים האחרים, ממשיכים ללא שינוי
  return NextResponse.next();
}

// קובע את הנתיבים שהמידלוור יופעל עבורם
export const config = {
  matcher: ['/api/v1/users/:path*'],
};