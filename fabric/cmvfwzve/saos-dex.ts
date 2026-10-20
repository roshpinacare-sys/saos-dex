import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.LOG_SERVICE_PORT || 3011;

app.use(express.json());

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  message: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

// יצירת טבלת לוגים אם לא קיימת (במציאות זה ייעשה דרך Prisma migrate)
// לצורך הדגמה, נניח שהטבלה קיימת דרך schema.prisma

app.post('/logs', async (req: Request, res: Response) => {
  try {
    const { level, service, message, metadata, traceId } = req.body;
    
    if (!level || !service || !message) {
      return res.status(400).json({ error: 'Missing required fields: level, service, message' });
    }
    
    const logEntry = await prisma.logEntry.create({
      data: {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        level,
        service,
        message,
        metadata: metadata ?? undefined,
        traceId: traceId ?? undefined,
      },
    });
    
    res.status(201).json(logEntry);
  } catch (error) {
    console.error('Failed to store log:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/logs', async (req: Request, res: Response) => {
  try {
    const { level, service, startTime, endTime, search, limit = 100, offset = 0 } = req.query;
    
    const where: any = {};
    
    if (level) where.level = level as string;
    if (service) where.service = service as string;
    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) where.timestamp.gte = startTime as string;
      if (endTime) where.timestamp.lte = endTime as string;
    }
    if (search) {
      where.message = {
        contains: search as string,
        mode: 'insensitive'
      };
    }
    
    const logs = await prisma.logEntry.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: Number(limit),
      skip: Number(offset),
    });
    
    const total = await prisma.logEntry.count({ where });
    
    res.json({ logs, total, limit: Number(limit), offset: Number(offset) });
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/logs/:id', async (req: Request, res: Response) => {
  try {
    const log = await prisma.logEntry.findUnique({
      where: { id: req.params.id },
    });
    
    if (!log) {
      return res.status(404).json({ error: 'Log entry not found' });
    }
    
    res.json(log);
  } catch (error) {
    console.error('Failed to fetch log:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/logs', async (req: Request, res: Response) => {
  try {
    const { olderThan } = req.query;
    
    if (!olderThan) {
      return res.status(400).json({ error: 'olderThan parameter is required' });
    }
    
    const result = await prisma.logEntry.deleteMany({
      where: {
        timestamp: {
          lt: olderThan as string,
        },
      },
    });
    
    res.json({ deletedCount: result.count });
  } catch (error) {
    console.error('Failed to delete logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// בריאות השירות
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const startServer = async () => {
  try {
    await prisma.$connect();
    console.log('Connected to database');
    
    app.listen(PORT, () => {
      console.log(`Log service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start log service:', error);
    process.exit(1);
  }
};

startServer();

// ייצוא לבדיקה
export { app };