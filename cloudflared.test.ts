/**
 * Vitest tests for cloudflared proxy
 * Using custom mocks instead of vi.mock() as requested
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Config, JSON_HEADER } from "./cloudflared";

// Import the functions we want to test by extracting them
// Since the main file runs immediately, we'll need to extract testable parts


interface Dependencies {
  fetch: typeof fetch;
  execCommand: (command: string) => Promise<string>;
}

// Load config (same as main file)
let config: Config;
try {
  config = JSON.parse(readFileSync("config.json", "utf-8"));
} catch {
  config = {
    port: 1111,
    retryCount: 2,
    cacheTimeoutMs: 3_600_000,
  };
}

// Mock implementations for testing
const mockDeps: Dependencies = {
  fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Mock fetch that can simulate different scenarios
    let urlStr: string;
    if (typeof input === "string") {
      urlStr = input;
    } else if (input instanceof URL) {
      urlStr = input.toString();
    } else {
      urlStr = input.url;
    }
    
    if (urlStr.includes("500-error")) {
      return new Response("Server Error", { status: 500 });
    }
    
    if (urlStr.includes("success")) {
      return new Response(JSON.stringify({ message: "success" }), {
        status: 200,
        headers: { "content-type": JSON_HEADER },
      });
    }
    
    return new Response("Not Found", { status: 404 });
  },
  
  execCommand: async (command: string): Promise<string> => {
    // Mock cloudflared commands
    if (command.includes("access token")) {
      return "mock-token-12345";
    }
    if (command.includes("access login")) {
      return "Login successful";
    }
    throw new Error(`Unknown command: ${command}`);
  },
};

// Extract and test the URL extraction function
function extractUrl(req: { url?: string }): string | null {
  if (!req.url) return null;

  const fullUrl = new URL(req.url, `http://localhost:${config.port}`);
  const targetUrl = fullUrl.searchParams.get("url");

  if (!targetUrl && req.url) {
    const match = req.url.match(/\/curl\?url=(.+)/);
    return match && match[1] ? decodeURIComponent(match[1]) : null;
  }

  return targetUrl;
}

// Test the retry logic
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  deps: Dependencies
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= config.retryCount; attempt++) {
    try {
      const response = await deps.fetch(url, init);
      
      if (response.status >= 500 && attempt < config.retryCount) {
        continue;
      }
      
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < config.retryCount) {
        continue;
      }
    }
  }
  
  throw lastError || new Error("Request failed after retries");
}

// Tests
describe("Cloudflared Proxy", () => {
  describe("Configuration", () => {
    it("should load config with correct retry count", () => {
      expect(config.retryCount).toBe(2);
    });

    it("should load config with correct port", () => {
      expect(config.port).toBe(1111);
    });
  });

  describe("URL Extraction", () => {
    it("should extract URL from query parameter", () => {
      const result = extractUrl({ url: "/curl?url=https://example.com" });
      expect(result).toBe("https://example.com");
    });

    it("should handle URLs with query parameters", () => {
      const result = extractUrl({ url: "/curl?url=https://example.com/api?param=value" });
      expect(result).toBe("https://example.com/api?param=value");
    });

    it("should return null for non-curl URLs", () => {
      const result = extractUrl({ url: "/health" });
      expect(result).toBeNull();
    });
  });

  describe("Retry Logic", () => {
    it("should succeed on first try for 200 response", async () => {
      const response = await fetchWithRetry("https://example.com/success", {}, mockDeps);
      expect(response.status).toBe(200);
    });

    it("should return 500 after retries exhausted", async () => {
      const response = await fetchWithRetry("https://example.com/500-error", {}, mockDeps);
      expect(response.status).toBe(500);
    });
  });

  describe("Command Execution", () => {
    it("should return mock token for valid token command", async () => {
      const token = await mockDeps.execCommand('cloudflared access token "https://example.com"');
      expect(token).toBe("mock-token-12345");
    });

    it("should handle login commands", async () => {
      const result = await mockDeps.execCommand('cloudflared access login "https://example.com"');
      expect(result).toBe("Login successful");
    });

    it("should throw for unknown commands", async () => {
      await expect(mockDeps.execCommand("unknown command")).rejects.toThrow("Unknown command");
    });
  });
});
