import { NextRequest, NextResponse } from 'next/server';

// Middleware to handle JWT authentication and role-based authorization
export async function middleware(request: NextRequest) {
  // Only protect /api/v1/users routes
  if (request.nextUrl.pathname.startsWith('/api/v1/users')) {
    const token = request.headers.get('authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: No token provided' }, { status: 401 });
    }
    
    try {
      // Verify JWT token (in a real implementation, use a proper JWT library)
      const payload = verifyJwtToken(token);
      
      if (!payload) {
        return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
      }
      
      // Check permissions based on user role
      const method = request.method;
      const path = request.nextUrl.pathname;
      
      // Admin has full access
      if (payload.role === 'admin') {
        return NextResponse.next();
      }
      
      // Regular users can only access their own data
      if (payload.role === 'user' && method === 'GET') {
        // In a real implementation, extract user ID from token and path
        // and verify they match
        return NextResponse.next();
      }
      
      // Deny access for all other cases
      return NextResponse.json({ error: 'Forbidden: Insufficient permissions' }, { status: 403 });
    } catch (error) {
      return NextResponse.json({ error: 'Unauthorized: Token verification failed' }, { status: 401 });
    }
  }
  
  // For all other routes, continue as normal
  return NextResponse.next();
}

// In a real implementation, this would use a proper JWT library
function verifyJwtToken(token: string): { role: string; userId: string } | null {
  // This is a placeholder implementation
  // In production, use a library like jsonwebtoken or NextAuth.js
  try {
    // Example: decode and verify the token
    // const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // For demonstration purposes, we'll simulate a valid token with roles
    if (token === 'admin-token') {
      return { role: 'admin', userId: '1' };
    } else if (token === 'user-token') {
      return { role: 'user', userId: '2' };
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Configure the middleware to match only the specific path
export const config = {
  matcher: '/api/v1/users/:path*',
};