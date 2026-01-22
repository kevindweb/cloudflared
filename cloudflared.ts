#!/usr/bin/env tsx
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execAsync = promisify(exec);

// Load configuration
export interface Config {
  port: number;
  retryCount: number;
  cacheTimeoutMs: number;
}

let config: Config;
try {
  config = JSON.parse(readFileSync("config.json", "utf-8"));
} catch {
  // Fallback defaults if config.json doesn't exist
  config = {
    port: 1111,
    retryCount: 2,
    cacheTimeoutMs: 3_600_000,
  };
}

export const JSON_HEADER = "application/json";
const TEXT_HEADER = "text/plain";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With",
};
const API_PROXY_PATH = "/curl";
const API_HEALTH_PATH = "/health";

// Token cache to avoid repeated cloudflared calls
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// Dependency injection for testing
interface Dependencies {
  fetch: typeof fetch;
  execCommand: (command: string) => Promise<string>;
}

const defaultDeps: Dependencies = {
  fetch: globalThis.fetch,
  execCommand: async (command: string): Promise<string> => {
    const { stdout, stderr } = await execAsync(command, {});
    if (stderr) {
      throw new Error(`Command failed: "${command}". Stderr: ${stderr}`);
    }
    return stdout.trim();
  },
};

/**
 * Get or refresh cloudflared access token for a host
 */
async function getAccessToken(
  url: string,
  deps: Dependencies = defaultDeps
): Promise<string> {
  const host = new URL(url).hostname;
  const cached = tokenCache.get(host);
  const now = Date.now();

  // Return cached token if still valid
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  try {
    console.log(`🔑 Getting access token for ${host}`);
    const token = await deps.execCommand(
      `cloudflared access token "${new URL(url).origin}"`
    );
    tokenCache.set(host, { token, expiresAt: now + config.cacheTimeoutMs });
    return token;
  } catch {
    // If token fails, try login first
    console.log(`🔐 Logging in to ${host}`);
    await deps.execCommand(`cloudflared access login "${new URL(url).origin}"`);
    const token = await deps.execCommand(
      `cloudflared access token "${new URL(url).origin}"`
    );
    tokenCache.set(host, { token, expiresAt: now + config.cacheTimeoutMs });
    return token;
  }
}

/**
 * Parse request body from stream using Buffers for performance
 * and encoding safety.
 */
async function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyChunks: Buffer[] = [];

    req.on("data", (chunk) => {
      if (chunk instanceof Buffer) {
        bodyChunks.push(chunk);
      } else {
        bodyChunks.push(Buffer.from(chunk));
      }
    });

    req.on("end", () => {
      try {
        const bodyBuffer = Buffer.concat(bodyChunks);
        resolve(bodyBuffer.toString("utf8"));
      } catch (error) {
        reject(new Error("Failed to process request body."));
      }
    });

    req.on("error", reject);
  });
}

/**
 * Extract target URL from request, ensuring it is well-formed and uses a safe protocol.
 */
function extractUrl(req: IncomingMessage): string | null {
  if (!req.url) return null;

  const fullUrl = new URL(req.url, `http://localhost:${config.port}`);
  let targetUrl = fullUrl.href.split("/curl/", 2)[1];
  if (targetUrl) {
    try {
      const url = new URL(targetUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        console.error(`Attempted proxy to forbidden protocol: ${url.protocol}`);
        return null;
      }

      if (!targetUrl.includes("?") && targetUrl.includes("&")) {
        // replace the first & with ?
        targetUrl = targetUrl.replace("&", "?");
      }
      return targetUrl;
    } catch (e) {
      console.error(`Malformed target URL provided: ${targetUrl} (${e})`);
      return null;
    }
  }

  return null;
}

/**
 * Send error response
 */
function sendError(res: ServerResponse, status: number, message: string): void {
  console.error(`❌ Error (${status}): ${message}`);
  res.writeHead(status, { "Content-Type": JSON_HEADER, ...CORS_HEADERS });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Perform HTTP request with retry logic for 5xx errors
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  deps: Dependencies = defaultDeps
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.retryCount; attempt++) {
    try {
      const response = await deps.fetch(url, init);

      // If it's a 5xx error and we have retries left, continue
      if (response.status >= 500 && attempt < config.retryCount) {
        console.log(
          `⚠️  5xx error (${response.status}), retrying... (${attempt + 1}/${config.retryCount})`
        );
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < config.retryCount) {
        console.log(
          `⚠️  Request failed, retrying... (${attempt + 1}/${config.retryCount})`
        );
        continue;
      }
    }
  }

  throw lastError || new Error("Request failed after retries");
}

/**
 * Handle proxy requests
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Dependencies = defaultDeps
): Promise<void> {
  try {
    const targetUrl = extractUrl(req);
    if (!targetUrl) {
      return sendError(res, 400, "Missing 'url' parameter");
    }

    console.log(`🌐 Proxying ${req.method} ${targetUrl}`);

    const token = await getAccessToken(targetUrl, deps);
    const headers = new Headers();

    // Copy relevant headers from original request
    for (const [key, value] of Object.entries(req.headers)) {
      if (value && !key.toLowerCase().startsWith("host")) {
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }

    // Add cloudflare access token
    headers.set("Cookie", `CF_Authorization=${token}`);

    const init: RequestInit = {
      method: req.method || "GET",
      headers,
    };

    // Add body for POST/PUT requests
    if (
      req.method === "POST" ||
      req.method === "PUT" ||
      req.method === "PATCH"
    ) {
      init.body = await parseBody(req);
      if (!headers.has("content-type")) {
        headers.set("Content-Type", JSON_HEADER);
      }
    }

    const response = await fetchWithRetry(targetUrl, init, deps);
    const responseText = await response.text();

    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || JSON_HEADER,
      ...CORS_HEADERS,
    });
    res.end(responseText);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendError(res, 500, message);
  }
}

/**
 * Handle health check endpoint
 */
function handleHealth(res: ServerResponse): void {
  const healthData = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    config: {
      port: config.port,
      retryCount: config.retryCount,
      cacheTimeoutMs: config.cacheTimeoutMs,
    },
    cache: {
      activeTokens: tokenCache.size,
    },
  };

  res.writeHead(200, {
    "Content-Type": JSON_HEADER,
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(healthData, null, 2));
}

/**
 * Handle CORS preflight requests
 */
function handleCorsPreFlight(res: ServerResponse): void {
  res.writeHead(200, CORS_HEADERS);
  res.end();
}

/**
 * Main request handler
 */
function requestListener(req: IncomingMessage, res: ServerResponse): void {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    console.log("🔄 Handling CORS preflight request");
    return handleCorsPreFlight(res);
  }

  if (req.url?.startsWith(API_PROXY_PATH)) {
    void handleRequest(req, res);
  } else if (req.url === API_HEALTH_PATH) {
    handleHealth(res);
  } else {
    res.writeHead(404, { "Content-Type": TEXT_HEADER });
    res.end("Not Found - Use /curl/<target_url> or /health");
  }
}

// Start server
const server = createServer(requestListener);

server.listen(config.port, () => {
  console.log(
    `✅ Cloudflared Proxy running on http://localhost:${config.port}`
  );
  console.log(`   Usage: http://localhost:${config.port}/curl/<target_url>`);
  console.log(
    `   Example: http://localhost:${config.port}/curl/https://example.com/api`
  );
});

server.on("error", (err) => {
  console.error("❌ Server startup error:", err);
});

// Handle process termination
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down cloudflared proxy...");
  server.close();
  process.exit(0);
});
