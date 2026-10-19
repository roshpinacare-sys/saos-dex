import { NextRequest, NextResponse } from 'next/server';

// מערכת הרשאות מבוססת תפקידים (RBAC)
type UserRole = 'admin' | 'user' | 'guest';

interface User {
  id: string;
  username: string;
  role: UserRole;
  email?: string;
}

// מודל משתמש לדוגמה (ביישום אמיתי זה יגיע ממסד נתונים)
const mockUsers: User[] = [
  { id: '1', username: 'admin', role: 'admin', email: 'admin@example.com' },
  { id: '2', username: 'user1', role: 'user', email: 'user1@example.com' },
  { id: '3', username: 'user2', role: 'user', email: 'user2@example.com' },
];

// פונקציית עזר לאימות המשתמש
function authenticateUser(request: NextRequest): User | null {
  // ביישום אמיתי, זה יבדוק את הטוקן מה-header
  const authHeader = request.headers.get('authorization');
  
  // לדוגמה: מציאת המשתמש לפי ה-username בטוקן
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const username = token.split(':')[0]; // פשוט לדוגמה
    
    const user = mockUsers.find(u => u.username === username);
    return user || null;
  }
  
  return null;
}

// פונקציית עזר לבדיקת הרשאות
function checkAuthorization(user: User, action: 'read' | 'update', targetUserId?: string): boolean {
  // מנהלים יכולים לבצע כל פעולה
  if (user.role === 'admin') {
    return true;
  }
  
  // משתמשים רגילים יכולים לקרוא את כל המשתמשים
  if (action === 'read') {
    return true;
  }
  
  // משתמשים רגילים יכולים לעדכן רק את המידע של עצמם
  if (action === 'update' && targetUserId && user.id === targetUserId) {
    return true;
  }
  
  // בכל מקרה אחר - אין הרשאה
  return false;
}

// Middleware לאימות והרשאות
export function withAuth(handler: (req: NextRequest, user: User) => Promise<NextResponse>) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // אימות המשתמש
    const user = authenticateUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // העברת המשתמש ל-handler
    return handler(request, user);
  };
}

export async function GET(request: NextRequest) {
  // אימות והרשאות
  const user = authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // בדיקת הרשאת קריאה
  if (!checkAuthorization(user, 'read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  
  // ברירת מחדל: רק מנהלים יכולים לראות את כל המשתמשים
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  
  return NextResponse.json({ users: mockUsers });
}

export async function PUT(request: NextRequest) {
  // אימות והרשאות
  const user = authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  try {
    const body = await request.json();
    const { id, ...updateData } = body;
    
    // בדיקת הרשאת עדכון
    if (!checkAuthorization(user, 'update', id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    
    // ביישום אמיתי, זה יעדכן את המשתמש במסד הנתונים
    const userIndex = mockUsers.findIndex(u => u.id === id);
    
    if (userIndex === -1) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    
    // מנהלים יכולים לעדכן כל שדה
    if (user.role === 'admin') {
      mockUsers[userIndex] = { ...mockUsers[userIndex], ...updateData };
    } else {
      // משתמשים רגילים יכולים לעדכן רק שדות מסוימים (לא תפקיד ולא סיסמה)
      const allowedFields = ['email'];
      const filteredUpdateData = {};
      
      for (const key in updateData) {
        if (allowedFields.includes(key)) {
          filteredUpdateData[key] = updateData[key];
        }
      }
      
      mockUsers[userIndex] = { ...mockUsers[userIndex], ...filteredUpdateData };
    }
    
    return NextResponse.json({ success: true, user: mockUsers[userIndex] });
  } catch (error) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}