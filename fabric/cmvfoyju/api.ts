import { NextRequest, NextResponse } from 'next/server';
import { operatorAuth } from '@/lib/operator-auth';

// Middleware to check admin permissions for API keys management
export async function middleware(request: NextRequest) {
  // Only protect the /api/v1/keys endpoint
  if (request.nextUrl.pathname.startsWith('/api/v1/keys')) {
    // Verify operator authentication
    const authResult = await operatorAuth(request);
    
    if (!authResult.success) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }
    
    // Check if user has admin permissions
    if (!authResult.isAdmin) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin privileges required' },
        { status: 403 }
      );
    }
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: '/api/v1/keys/:path*',
};

// Unit tests for API keys permission system
import { describe, it, expect, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

// Mock the operatorAuth function
jest.mock('@/lib/operator-auth', () => ({
  operatorAuth: jest.fn(),
}));

const { operatorAuth } = require('@/lib/operator-auth');

// Mock NextRequest
const createMockRequest = (path: string, headers: Record<string, string> = {}) => {
  return {
    nextUrl: { pathname: path },
    headers: new Map(Object.entries(headers)),
  } as NextRequest;
};

describe('API Keys Permission Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should allow access to admin users for /api/v1/keys', async () => {
    (operatorAuth as jest.Mock).mockResolvedValue({
      success: true,
      isAdmin: true,
    });

    const request = createMockRequest('/api/v1/keys');
    const response = await middleware(request);
    
    expect(response.status).toBe(200);
    expect(operatorAuth).toHaveBeenCalledWith(request);
  });

  it('should deny access to non-admin users for /api/v1/keys', async () => {
    (operatorAuth as jest.Mock).mockResolvedValue({
      success: true,
      isAdmin: false,
    });

    const request = createMockRequest('/api/v1/keys');
    const response = await middleware(request);
    
    expect(response.status).toBe(403);
    expect(response.json()).resolves.toEqual({
      error: 'Forbidden',
      message: 'Admin privileges required',
    });
    expect(operatorAuth).toHaveBeenCalledWith(request);
  });

  it('should deny access to unauthenticated users for /api/v1/keys', async () => {
    (operatorAuth as jest.Mock).mockResolvedValue({
      success: false,
    });

    const request = createMockRequest('/api/v1/keys');
    const response = await middleware(request);
    
    expect(response.status).toBe(401);
    expect(response.json()).resolves.toEqual({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    expect(operatorAuth).toHaveBeenCalledWith(request);
  });

  it('should not protect endpoints other than /api/v1/keys', async () => {
    (operatorAuth as jest.Mock).mockResolvedValue({
      success: false,
    });

    const request = createMockRequest('/api/v1/users');
    const response = await middleware(request);
    
    expect(response.status).toBe(200);
    expect(operatorAuth).not.toHaveBeenCalled();
  });
});

// API route implementation with permission checks
import { NextRequest, NextResponse } from 'next/server';
import { operatorAuth } from '@/lib/operator-auth';

export async function POST(request: NextRequest) {
  try {
    // Verify admin permissions
    const authResult = await operatorAuth(request);
    
    if (!authResult.success || !authResult.isAdmin) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin privileges required' },
        { status: 403 }
      );
    }
    
    const { keyName, permissions } = await request.json();
    
    // Validate input
    if (!keyName || typeof keyName !== 'string') {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Invalid key name' },
        { status: 400 }
      );
    }
    
    // Check if admin permissions are being requested
    const isAdminRequest = permissions && permissions.includes('admin');
    
    if (isAdminRequest) {
      // Additional validation for admin key creation
      if (!authResult.superAdmin) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Super admin privileges required for admin keys' },
          { status: 403 }
        );
      }
      
      // Create admin key with special handling
      const newKey = await createAdminKey(keyName);
      return NextResponse.json({ key: newKey }, { status: 201 });
    }
    
    // Regular key creation
    const newKey = await createRegularKey(keyName);
    return NextResponse.json({ key: newKey }, { status: 201 });
    
  } catch (error) {
    console.error('Error creating API key:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to create API key' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    // Verify admin permissions
    const authResult = await operatorAuth(request);
    
    if (!authResult.success || !authResult.isAdmin) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin privileges required' },
        { status: 403 }
      );
    }
    
    // Fetch all keys (filter based on admin level)
    const keys = await getAllKeys(authResult.superAdmin);
    return NextResponse.json({ keys });
    
  } catch (error) {
    console.error('Error fetching API keys:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to fetch API keys' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Verify admin permissions
    const authResult = await operatorAuth(request);
    
    if (!authResult.success || !authResult.isAdmin) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin privileges required' },
        { status: 403 }
      );
    }
    
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get('id');
    
    if (!keyId) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Missing key ID' },
        { status: 400 }
      );
    }
    
    // Check if trying to delete an admin key
    const isAdminKey = await isAdminKeyById(keyId);
    
    if (isAdminKey && !authResult.superAdmin) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Super admin privileges required to delete admin keys' },
        { status: 403 }
      );
    }
    
    // Delete the key
    await deleteKey(keyId);
    return NextResponse.json({ message: 'Key deleted successfully' }, { status: 200 });
    
  } catch (error) {
    console.error('Error deleting API key:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to delete API key' },
      { status: 500 }
    );
  }
}

// Helper functions (mock implementations)
async function createAdminKey(keyName: string) {
  // In a real implementation, this would generate a secure key with admin permissions
  return {
    id: `admin-${Date.now()}`,
    name: keyName,
    key: `admin-key-${Math.random().toString(36).substring(2, 10)}`,
    permissions: ['admin'],
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

async function createRegularKey(keyName: string) {
  // In a real implementation, this would generate a regular API key
  return {
    id: `key-${Date.now()}`,
    name: keyName,
    key: `key-${Math.random().toString(36).substring(2, 10)}`,
    permissions: ['read'],
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

async function getAllKeys(includeAdmin: boolean) {
  // In a real implementation, this would fetch from the database
  const regularKeys = [
    {
      id: 'key-1',
      name: 'Regular Key 1',
      permissions: ['read'],
      createdAt: '2023-01-01T00:00:00.000Z',
    },
  ];
  
  const adminKeys = includeAdmin ? [
    {
      id: 'admin-1',
      name: 'Admin Key 1',
      permissions: ['admin'],
      createdAt: '2023-01-01T00:00:00.000Z',
    },
  ] : [];
  
  return [...regularKeys, ...adminKeys];
}

async function isAdminKeyById(keyId: string) {
  // In a real implementation, this would check the database
  return keyId.startsWith('admin-');
}

async function deleteKey(keyId: string) {
  // In a real implementation, this would delete from the database
  console.log(`Deleting key with ID: ${keyId}`);
}
