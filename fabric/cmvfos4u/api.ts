import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { URL } from 'node:url';

type UserRole = 'user' | 'admin';

// Mock user database
const mockUsers = new Map<string, { id: string; role: UserRole; apiKey?: string }>([
  ['user1', { id: 'user1', role: 'user' }],
  ['admin1', { id: 'admin1', role: 'admin', apiKey: 'admin-key-123' }],
]);

// Mock API keys database
const mockApiKeys = new Map<string, { id: string; userId: string; permissions: string[] }>([
  ['key1', { id: 'key1', userId: 'user1', permissions: ['read'] }],
  ['admin-key-123', { id: 'admin-key-123', userId: 'admin1', permissions: ['read', 'write', 'admin'] }],
]);

// Mock authentication function
function authenticateUser(apiKey?: string): { userId: string; role: UserRole } | null {
  if (!apiKey) return null;
  
  // Check if it's a direct user ID
  const user = mockUsers.get(apiKey);
  if (user) return { userId: user.id, role: user.role };
  
  // Check if it's an API key
  for (const [key, keyData] of mockApiKeys) {
    if (key === apiKey) {
      const user = mockUsers.get(keyData.userId);
      if (user) return { userId: user.id, role: user.role };
    }
  }
  
  return null;
}

// Mock permission checker
function hasPermission(userId: string, permission: string): boolean {
  const user = mockUsers.get(userId);
  if (!user) return false;
  
  if (user.role === 'admin') return true;
  
  // Check user's API keys for permissions
  for (const [keyId, keyData] of mockApiKeys) {
    if (keyData.userId === userId && keyData.permissions.includes(permission)) {
      return true;
    }
  }
  
  return false;
}

// Mock API server
const server = createServer((req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const apiKey = req.headers['x-api-key'] as string;
  const auth = authenticateUser(apiKey);
  
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  
  // Handle /api/v1/keys endpoint
  if (url.pathname === '/api/v1/keys' && req.method === 'GET') {
    if (!hasPermission(auth.userId, 'admin')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Insufficient permissions' }));
      return;
    }
    
    // Return all keys (mock response)
    const keys = Array.from(mockApiKeys.values()).map(key => ({
      id: key.id,
      userId: key.userId,
      permissions: key.permissions
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(keys));
    return;
  }
  
  // Handle /api/v1/keys/create endpoint
  if (url.pathname === '/api/v1/keys/create' && req.method === 'POST') {
    if (!hasPermission(auth.userId, 'admin')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Insufficient permissions' }));
      return;
    }
    
    // Simulate key creation
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      id: 'new-key-456', 
      apiKey: 'new-key-456',
      permissions: ['read', 'write']
    }));
    return;
  }
  
  // Handle /api/v1/keys/delete endpoint
  if (url.pathname === '/api/v1/keys/delete' && req.method === 'DELETE') {
    if (!hasPermission(auth.userId, 'admin')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Insufficient permissions' }));
      return;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  
  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = 3001;

beforeAll(async () => {
  server.listen(PORT);
  await new Promise(resolve => server.once('listening', resolve));
});

afterAll(async () => {
  server.close();
});

describe('API Key Management Authorization Tests', () => {
  it('should prevent regular user from creating API key with admin permissions', async () => {
    const response = await fetch(`http://localhost:${PORT}/api/v1/keys/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'user1'
      },
      body: JSON.stringify({
        permissions: ['read', 'admin']
      })
    });
    
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Insufficient permissions');
  });
  
  it('should prevent regular user from accessing private API key management routes', async () => {
    // Test GET /api/v1/keys
    const response = await fetch(`http://localhost:${PORT}/api/v1/keys`, {
      method: 'GET',
      headers: {
        'x-api-key': 'user1'
      }
    });
    
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Insufficient permissions');
    
    // Test DELETE /api/v1/keys
    const deleteResponse = await fetch(`http://localhost:${PORT}/api/v1/keys/delete`, {
      method: 'DELETE',
      headers: {
        'x-api-key': 'user1'
      }
    });
    
    expect(deleteResponse.status).toBe(403);
    const deleteData = await deleteResponse.json();
    expect(deleteData.error).toBe('Insufficient permissions');
  });
  
  it('should allow admin to perform all key management operations', async () => {
    // Test GET /api/v1/keys
    const response = await fetch(`http://localhost:${PORT}/api/v1/keys`, {
      method: 'GET',
      headers: {
        'x-api-key': 'admin-key-123'
      }
    });
    
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    
    // Test POST /api/v1/keys/create
    const createResponse = await fetch(`http://localhost:${PORT}/api/v1/keys/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'admin-key-123'
      },
      body: JSON.stringify({
        permissions: ['read', 'write']
      })
    });
    
    expect(createResponse.status).toBe(201);
    const createData = await createResponse.json();
    expect(createData.id).toBeDefined();
    expect(createData.apiKey).toBeDefined();
    expect(createData.permissions).toEqual(['read', 'write']);
    
    // Test DELETE /api/v1/keys/delete
    const deleteResponse = await fetch(`http://localhost:${PORT}/api/v1/keys/delete`, {
      method: 'DELETE',
      headers: {
        'x-api-key': 'admin-key-123'
      }
    });
    
    expect(deleteResponse.status).toBe(200);
    const deleteData = await deleteResponse.json();
    expect(deleteData.success).toBe(true);
  });
});
