import { NextRequest, NextResponse } from 'next/server';
import { operatorAuth } from '@/lib/operator-auth';
import { auditLog } from '@/lib/audit';

// Middleware to check admin permissions
async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const authResult = await operatorAuth(request);
  if (!authResult.success || !authResult.isAdmin) {
    return NextResponse.json(
      { error: 'Unauthorized: Admin access required' },
      { status: 403 }
    );
  }
  return null;
}

export async function GET(request: NextRequest) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck) return adminCheck;

  try {
    // In a real implementation, this would fetch from a database
    const apiKeys = [
      { id: '1', key: 'sk_12345', permissions: 'read', createdBy: 'admin1', createdAt: '2023-01-01' },
      { id: '2', key: 'sk_67890', permissions: 'admin', createdBy: 'admin1', createdAt: '2023-01-02' },
    ];

    // Log the access
    await auditLog({
      action: 'read_api_keys',
      userId: 'admin1',
      details: { accessedKeys: apiKeys.length }
    });

    return NextResponse.json({ apiKeys });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to retrieve API keys' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck) return adminCheck;

  try {
    const { permissions } = await request.json();
    
    // Validate permissions
    if (!['read', 'write', 'admin'].includes(permissions)) {
      return NextResponse.json(
        { error: 'Invalid permissions. Must be one of: read, write, admin' },
        { status: 400 }
      );
    }

    // In a real implementation, this would generate and store a new key
    const newKey = {
      id: Math.random().toString(36).substring(7),
      key: `sk_${Math.random().toString(36).substring(7)}`,
      permissions,
      createdBy: 'admin1',
      createdAt: new Date().toISOString()
    };

    // Log the creation
    await auditLog({
      action: 'create_api_key',
      userId: 'admin1',
      details: { 
        keyId: newKey.id, 
        permissions: newKey.permissions,
        keyPrefix: newKey.key.substring(0, 8) + '...'
      }
    });

    return NextResponse.json({ 
      message: 'API key created successfully',
      apiKey: newKey
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck) return adminCheck;

  try {
    const { id, permissions } = await request.json();
    
    // Validate permissions
    if (!['read', 'write', 'admin'].includes(permissions)) {
      return NextResponse.json(
        { error: 'Invalid permissions. Must be one of: read, write, admin' },
        { status: 400 }
      );
    }

    // In a real implementation, this would update the key in the database
    const updatedKey = {
      id,
      permissions,
      updatedAt: new Date().toISOString()
    };

    // Log the update
    await auditLog({
      action: 'update_api_key',
      userId: 'admin1',
      details: { 
        keyId: id, 
        newPermissions: permissions
      }
    });

    return NextResponse.json({ 
      message: 'API key updated successfully',
      apiKey: updatedKey
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update API key' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const adminCheck = await requireAdmin(request);
  if (adminCheck) return adminCheck;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    
    if (!id) {
      return NextResponse.json(
        { error: 'API key ID is required' },
        { status: 400 }
      );
    }

    // In a real implementation, this would delete the key from the database
    
    // Log the deletion
    await auditLog({
      action: 'delete_api_key',
      userId: 'admin1',
      details: { keyId: id }
    });

    return NextResponse.json({ 
      message: 'API key deleted successfully'
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to delete API key' },
      { status: 500 }
    );
  }
}