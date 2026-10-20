import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import csv from 'csv-writer';
import { createObjectCsvWriter } from 'csv-writer';
import fs from 'fs';
import path from 'path';

// הגדרות
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/saos-dex-logs';
const PORT = process.env.PORT || 3001;

// הגדרת Express
const app = express();
app.use(express.json());

// התחברות ל-MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// סכמת מסד הנתונים
const logSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  level: { type: String, enum: ['error', 'warn', 'info', 'debug'], required: true },
  message: { type: String, required: true },
  source: { type: String, required: true },
  instanceId: { type: String, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
});

const Log = mongoose.model('Log', logSchema);

// מידלוואר אימות JWT
const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// נקודת קצה לקבלת לוגים
app.post('/logs', authenticateToken, async (req, res) => {
  try {
    const { level, message, source, instanceId, metadata } = req.body;

    if (!level || !message || !source || !instanceId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const log = new Log({
      level,
      message,
      source,
      instanceId,
      metadata
    });

    await log.save();
    res.status(201).json({ success: true, id: log._id });
  } catch (error) {
    console.error('Error saving log:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// נקודת קצה לשאילתות לוגים
app.get('/logs', authenticateToken, async (req, res) => {
  try {
    const {
      level,
      source,
      instanceId,
      startDate,
      endDate,
      page = 1,
      limit = 100
    } = req.query;

    const filter: any = {};
    
    if (level) filter.level = level;
    if (source) filter.source = source;
    if (instanceId) filter.instanceId = instanceId;
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate as string);
      if (endDate) filter.timestamp.$lte = new Date(endDate as string);
    }

    const logs = await Log.find(filter)
      .sort({ timestamp: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    const total = await Log.countDocuments(filter);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// נקודת קצה לייצוא לוגים ל-CSV
app.get('/logs/export', authenticateToken, async (req, res) => {
  try {
    const {
      level,
      source,
      instanceId,
      startDate,
      endDate
    } = req.query;

    const filter: any = {};
    
    if (level) filter.level = level;
    if (source) filter.source = source;
    if (instanceId) filter.instanceId = instanceId;
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate as string);
      if (endDate) filter.timestamp.$lte = new Date(endDate as string);
    }

    const logs = await Log.find(filter).sort({ timestamp: -1 });
    
    if (logs.length === 0) {
      return res.status(404).json({ error: 'No logs found for export' });
    }

    const fileName = `logs-${new Date().toISOString().slice(0, 10)}.csv`;
    const filePath = path.join(__dirname, 'exports', fileName);
    
    // יצירת תיקייה אם לא קיימת
    const exportDir = path.dirname(filePath);
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'timestamp', title: 'Timestamp' },
        { id: 'level', title: 'Level' },
        { id: 'message', title: 'Message' },
        { id: 'source', title: 'Source' },
        { id: 'instanceId', title: 'Instance ID' },
        { id: 'metadata', title: 'Metadata' }
      ]
    });

    await csvWriter.writeRecords(logs);
    
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('Error downloading file:', err);
        res.status(500).json({ error: 'Error exporting logs' });
      }
      
      // מחיקת הקובץ לאחר ההורדה
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('Error deleting file:', unlinkErr);
      });
    });
  } catch (error) {
    console.error('Error exporting logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// התחלת השרת
app.listen(PORT, () => {
  console.log(`Central Logger Service running on port ${PORT}`);
});

// פונקציית עזר ליצירת JWT (למטרות דוגמה)
export function generateToken(userId: string) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });
}
