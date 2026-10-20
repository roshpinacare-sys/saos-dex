import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

// יצירת טבלת DLQ באמצעות Prisma
async function createAlertDlqTable() {
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS alert_dql (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL,
        alert_data TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending'
      );
    `;
    console.log('Alert DLQ table created or already exists');
  } catch (error) {
    console.error('Failed to create alert DLQ table:', error);
    throw error;
  }
}

// הוספת התראה ל-DLQ
async function addToAlertDlq(alertData: any) {
  const correlationId = uuidv4();
  
  try {
    await prisma.alertDlq.create({
      data: {
        correlation_id: correlationId,
        alert_data: JSON.stringify(alertData),
      },
    });
    console.log(`Alert added to DLQ with correlation ID: ${correlationId}`);
    return correlationId;
  } catch (error) {
    console.error('Failed to add alert to DLQ:', error);
    throw error;
  }
}

// ניסיון לשלוח מחדש התראות מה-DLQ
async function retryAlertsFromDlq() {
  try {
    const pendingAlerts = await prisma.alertDlq.findMany({
      where: {
        status: 'pending',
        retry_count: { lt: 3 },
      },
    });

    for (const alert of pendingAlerts) {
      try {
        // כאן היינו מנסים לשלוח את ההתראה למערכת ההתראות המקומית
        // לצורך הדוגמה, נדמה שהשליחה הצליחה
        console.log(`Retrying alert with correlation ID: ${alert.correlation_id}`);
        
        // עדכון ההתראה כמותרגת
        await prisma.alertDlq.update({
          where: { id: alert.id },
          data: {
            retry_count: { increment: 1 },
            status: 'processed',
          },
        });
      } catch (error) {
        console.error(`Failed to retry alert with correlation ID: ${alert.correlation_id}:`, error);
        
        // אם נכשלה השליחה, נעדכן את הסטטוס ל-failed
        await prisma.alertDlq.update({
          where: { id: alert.id },
          data: {
            retry_count: { increment: 1 },
            status: 'failed',
          },
        });
      }
    }
  } catch (error) {
    console.error('Failed to retry alerts from DLQ:', error);
  }
}

// ניקוי התראות ישנות מה-DLQ
async function cleanupOldAlerts() {
  try {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const result = await prisma.alertDlq.deleteMany({
      where: {
        timestamp: { lt: twentyFourHoursAgo },
      },
    });

    console.log(`Cleaned up ${result.count} old alerts from DLQ`);
  } catch (error) {
    console.error('Failed to cleanup old alerts:', error);
  }
}

// פונקציית retry עם interval
function startRetryProcess() {
  setInterval(retryAlertsFromDlq, 30000); // כל 30 שניות
  console.log('Started retry process for alerts from DLQ');
}

// פונקציית cleanup עם interval
function startCleanupProcess() {
  // ריצה ראשונית מיידית
  cleanupOldAlerts();
  
  // לאחר מכן, כל שעה
  setInterval(cleanupOldAlerts, 3600000);
  console.log('Started cleanup process for old alerts');
}

// הפונקציה המעודכנת של DB Guard
export async function alertDatabaseConnectionFailure(options: {
  timestamp: string;
  errorType: string;
  description: string;
  severity: string;
}) {
  try {
    // הוספת ההתראה ל-DLQ במקום console.warn
    const correlationId = await addToAlertDlq(options);
    
    // לוג עם correlation ID
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'database_connection_failure',
        correlationId,
        ...options,
      })
    );
  } catch (error) {
    console.error('Failed to add alert to DLQ:', error);
    // כאכן נותרנו עם console.warn כאמצעי גיבוי
    console.warn(`[${options.timestamp}] DATABASE_CONNECTION_FAILURE: ${options.description}`);
  }
}

// הפעלת התהליכים הרקע
async function initializeDlq() {
  try {
    await createAlertDlqTable();
    startRetryProcess();
    startCleanupProcess();
  } catch (error) {
    console.error('Failed to initialize DLQ:', error);
  }
}

// הפעלה בזמן טעינת המודול
initializeDlq();

// בדיקות יחידה
async function runTests() {
  console.log('Running tests for Alert DLQ...');
  
  // בדיקת יצירת טבלה
  await createAlertDlqTable();
  
  // בדיקה הוספת התראה
  const testAlert = {
    timestamp: new Date().toISOString(),
    errorType: 'TEST_ERROR',
    description: 'This is a test alert',
    severity: 'INFO',
  };
  
  const correlationId = await addToAlertDlq(testAlert);
  console.log(`Test alert added with correlation ID: ${correlationId}`);
  
  // בדיקת ניסיון חוזר
  await retryAlertsFromDlq();
  
  // בדיקת ניקוי
  await cleanupOldAlerts();
  
  console.log('Tests completed');
}

// הפעלת הבדיקות אם הקוד רץ בסביבת בדיקה
if (process.env.NODE_ENV === 'test') {
  runTests();
}
