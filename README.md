# Cloudflared Proxy

A simple HTTP proxy that makes it easy to access Cloudflare Access protected resources from your local development environment. It eliminates the need for manual authentication by automatically managing token fetching, caching, and refresh using the `cloudflared` CLI.

## Motivation

When developing locally, you often need to access APIs or resources that are protected by Cloudflare Access. Normally, you'd have to:

1. Manually authenticate through the browser or via [cloudflared CLI](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
2. Extract authentication tokens and headers
3. Include them in every API request

This proxy eliminates that friction. Just run it in the background and make requests to `localhost:1111/curl/<your-protected-resource>` - the proxy handles all the Cloudflare Access authentication automatically, without having to pass any headers.

## Quick Start

Requires first installing [cloudflared](https://github.com/cloudflare/cloudflared?tab=readme-ov-file#installing-cloudflared).

```bash
# Install dependencies
pnpm install

# Start the proxy
pnpm proxy

# The proxy is now running on http://localhost:1111
```

## Usage

### Basic GET Request

```bash
curl "http://localhost:1111/curl/https://your-protected-api.com/endpoint"
```

### POST Request with JSON Body

```bash
curl -X POST "http://localhost:1111/curl/https://your-protected-api.com/endpoint" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

### From Your Application

```javascript
// Instead of dealing with Cloudflare Access tokens
const response = await fetch(
  "http://localhost:1111/curl/https://your-protected-api.com/data"
);
const data = await response.json();
```

### Health Check

```bash
curl http://localhost:1111/health
```

Returns proxy status, configuration, and cache information.

## How It Works

1. **Token Caching**: Automatically gets and caches Cloudflare Access tokens (configurable cache duration)
2. **Auto-Login**: If a token is expired, automatically triggers `cloudflared access login`
3. **Request Proxying**: Forwards your requests with proper authentication headers
4. **Retry Logic**: Automatically retries 5xx errors (configurable retry count)
5. **CORS Enabled**: Includes CORS headers for browser-based development
6. **Health Monitoring**: `/health` endpoint for service monitoring

## Requirements

- Node.js 18+
- `cloudflared` CLI tool installed and configured
- Access to Cloudflare Access protected resources

## Configuration

Create a `config.json` file to customize settings:

```json
{
  "port": 1111,
  "retryCount": 2,
  "cacheTimeoutMs": 3600000
}
```

- **port**: Server port (default: 1111)
- **retryCount**: Number of retries for 5xx errors (default: 2)
- **cacheTimeoutMs**: Token cache duration in milliseconds (default: 1 hour)

## Development

```bash
# Start with auto-reload on file changes
pnpm dev

# Format code
pnpm f

# Check formatting (used in CI)
pnpm format:check

# Type check
pnpm typecheck

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch
```

## Contribution

We welcome contributions! Please feel free to submit issues or pull requests on GitHub.
