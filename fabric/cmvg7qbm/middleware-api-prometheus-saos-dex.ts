import { NextRequest, NextResponse } from "next/server";
import client from "prom-client";

// Initialize Prometheus metrics
const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "path", "status_code"],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "path"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const apiErrorsTotal = new client.Counter({
  name: "api_errors_total",
  help: "Total number of API errors",
  labelNames: ["error_type"],
});

const activeConnections = new client.Gauge({
  name: "active_connections",
  help: "Number of active connections",
});

const rateLimitHitsTotal = new client.Counter({
  name: "rate_limit_hits_total",
  help: "Total number of rate limit hits",
  labelNames: ["client_ip"],
});

// Register metrics
client.collectDefaultMetrics({ timeout: 5000 });

// Middleware to collect metrics
export async function metricsMiddleware(req: NextRequest, res: NextResponse) {
  const start = Date.now();
  const method = req.method;
  const path = req.nextUrl.pathname;

  // Increment active connections
  activeConnections.inc();

  try {
    const response = await res;
    const statusCode = response.status;

    // Record request count
    httpRequestsTotal.inc({ method, path, status_code: String(statusCode) });

    // Record request duration
    const duration = (Date.now() - start) / 1000;
    httpRequestDurationSeconds.observe({ method, path }, duration);

    // Record API errors (4xx and 5xx)
    if (statusCode >= 400) {
      let errorType = "server_error";
      if (statusCode >= 400 && statusCode < 500) {
        if (statusCode === 401 || statusCode === 403) errorType = "auth";
        else if (statusCode === 429) errorType = "rate_limit";
        else errorType = "validation";
      }
      apiErrorsTotal.inc({ error_type: errorType });
    }

    // Record rate limit hits (if 429)
    if (statusCode === 429) {
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
                       req.headers.get("x-real-ip") ||
                       req.ip ||
                       "unknown";
      rateLimitHitsTotal.inc({ client_ip: clientIp });
    }

    return response;
  } catch (error) {
    // Record server error
    apiErrorsTotal.inc({ error_type: "server_error" });
    throw error;
  } finally {
    // Decrement active connections
    activeConnections.dec();
  }
}

// Handler for /metrics endpoint
export async function GET() {
  try {
    const metrics = await client.register.metrics();
    return new NextResponse(metrics, {
      headers: {
        "Content-Type": client.register.contentType,
      },
    });
  } catch (err) {
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

// Export middleware and handler
export { metricsMiddleware as middleware };
