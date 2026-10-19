import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import winston from "winston";

// Initialize logger
const logger = winston.createLogger({
  level: 'error',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'db_errors.log' })
  ]
});

// Metrics storage (in-memory for this example)
const dbErrorMetrics = {
  count: 0,
  lastError: null as string | null
};

// Function to send external alert
async function sendExternalAlert(error: string, urlHint: string): Promise<void> {
  try {
    const base = process.env.SAOS_CONTROL_CENTER_URL;
    if (!base) return;
    
    await fetch(`${base}/api/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "database_connection_error",
        timestamp: new Date().toISOString(),
        service_id: "saos-dex",
        error,
        url_hint,
        metrics: dbErrorMetrics
      }),
      signal: AbortSignal.timeout(3000)
    });
  } catch (alertError) {
    logger.warn("Failed to send external alert", { alertError });
  }
}

// Function to save metrics to database (if available)
async function saveMetricsToDb(error: string): Promise<void> {
  try {
    // In a real implementation, you would use your Prisma client here
    // This is a placeholder for the metrics storage functionality
    // await prisma.databaseError.create({
    //   data: {
    //     error_type: "CONNECTION_FAILURE",
    //     error_details: error,
    //     timestamp: new Date()
    //   }
    // });
    
    // Update in-memory metrics
    dbErrorMetrics.count++;
    dbErrorMetrics.lastError = error;
    
    logger.info("Database error metrics updated", { metrics: dbErrorMetrics });
  } catch (metricsError) {
    logger.warn("Failed to save metrics to database", { metricsError });
  }
}

const RAW_URL = process.env.DATABASE_URL ?? "";
const isDexOwnDb = /dex\.db(\?|$)/.test(RAW_URL) && !/custom\.db/.test(RAW_URL);

if (!isDexOwnDb) {
  const desc = RAW_URL === "" ? "(חסר — הגדר DATABASE_URL ב-.env של saos-dex)" : 
    /dex\.db/.test(RAW_URL) ? "(dex.db-קיים-אך-לא-עבר-את-הסינון)" : 
    /custom\.db/.test(RAW_URL) ? "(מצביע-על-האם-אסור)" : "(כתובת-לא-ידועה — לא-מוצגת)";
    
  const errorMessage = `[saos-dex] DATABASE_URL נדחה (fail-closed): המנוע רשאי לגעת רק ב-dex.db שלו — קיבל: ${desc}`;
  const timestamp = new Date().toISOString();
  const urlHint = createHash("sha256").update(RAW_URL).digest("hex").slice(0, 12);

  // Log the error
  logger.error(errorMessage, { timestamp, urlHint });

  // Save metrics
  void saveMetricsToDb(errorMessage);

  // Send external alert
  void sendExternalAlert(errorMessage, urlHint);

  // Local alert module (existing functionality)
  void (async () => {
    try {
      const { alertDatabaseConnectionFailure } = await import("./dex/alert");
      await alertDatabaseConnectionFailure({
        timestamp,
        errorType: "INVALID_DATABASE_URL",
        description: errorMessage,
        severity: "WARNING",
      });
    } catch (alertError) {
      logger.warn("Failed to trigger local database connection alert", { alertError });
    }
  })();

  throw new Error(errorMessage);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
