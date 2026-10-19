import { NextRequest, NextResponse } from 'next/server';

// Middleware to protect admin-only routes
export async function adminAuthMiddleware(request: NextRequest) {
  // Skip authentication for certain paths (e.g., health checks, public assets)
  if (request.nextUrl.pathname.startsWith('/_next') || 
      request.nextUrl.pathname.startsWith('/api/health')) {
    return NextResponse.next();
  }

  // For the vulnerable /api/v1/users path, enforce admin authentication
  if (request.nextUrl.pathname.startsWith('/api/v1/users')) {
    // Extract the authorization header
    const authHeader = request.headers.get('authorization');
    
    // Check if the header exists and has the expected format
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized: Missing or invalid authorization header' },
        { status: 401 }
      );
    }
    
    // Extract the token
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    // Verify the token (in a real implementation, this would check against a valid token store)
    // For this example, we'll use a simple hardcoded check
    const validAdminTokens = [
      process.env.ADMIN_API_TOKEN_1,
      process.env.ADMIN_API_TOKEN_2
    ];
    
    if (!validAdminTokens.includes(token)) {
      return NextResponse.json(
        { error: 'Forbidden: Invalid admin token' },
        { status: 403 }
      );
    }
    
    // Token is valid, continue to the API route
    return NextResponse.next();
  }
  
  // For other API routes, you might want to implement different authentication strategies
  return NextResponse.next();
}

// Apply the middleware to all API routes
export function middleware(request: NextRequest) {
  return adminAuthMiddleware(request);
}

// Configure the middleware to only run on API routes
export const config = {
  matcher: '/api/:path*',
};