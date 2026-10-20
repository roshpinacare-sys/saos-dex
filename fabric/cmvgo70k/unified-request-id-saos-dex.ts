import { randomUUID } from 'node:crypto';

/**
 * correlation.ts — Unified Request ID utility for saos-dex
 * Generates UUID v4 correlation IDs and formats structured logs.
 * Backward compatible: if no ID provided, one is generated automatically.
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

export interface LogContext {
  correlationId: string;
  component: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  metadata?: Record<string, unknown>;
}

export function formatLog(ctx: LogContext): string {
  const timestamp = new Date().toISOString();
  const base = {
    timestamp,
    level: ctx.level.toUpperCase(),
    correlationId: ctx.correlationId,
    component: ctx.component,
    message: ctx.message,
    ...(ctx.metadata && { metadata: ctx.metadata }),
  };
  return JSON.stringify(base);
}

export function logWithCorrelation(ctx: LogContext): void {
  const formatted = formatLog(ctx);
  switch (ctx.level) {
    case 'error':
      console.error(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'debug':
      console.debug(formatted);
      break;
    default:
      console.log(formatted);
  }
}

/**
 * Creates a child correlation ID for sub-operations while maintaining
 * traceability to the parent operation.
 */
export function createChildCorrelationId(parentId: string, suffix: string): string {
  return `${parentId}-${suffix}`;
}
