import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { inspectSession, recordProxyCall, usageKeyFor } from "./gate.js";
import { blockedResponse, modelFromRequest, parseProviderResponse, type ProxyProvider } from "./parse.js";

const BODY_LIMIT = 32 * 1024 * 1024;
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export interface ProxyListenOptions {
  provider: ProxyProvider;
  upstream: string;
  home: string;
  host?: string;
  port?: number;
  cwd?: string;
}

export interface RunningProxy {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Local reverse proxy. Any agent that can set an API base URL gets the same
 * cap and kill switch. The proxy binds to 127.0.0.1 unless host is set.
 * API keys are forwarded and never written to the ledger.
 */
export function startProxy(options: ProxyListenOptions): Promise<RunningProxy> {
  const upstream = new URL(options.upstream);
  const host = options.host ?? "127.0.0.1";
  const server = http.createServer((request, response) => {
    handle(request, response, options, upstream).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: `spendguard proxy: ${message}` } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ProxyListenOptions,
  upstream: URL,
): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > BODY_LIMIT) {
      response.writeHead(413, { "content-type": "text/plain" });
      response.end("spendguard proxy: request body exceeds 32MB");
      return;
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const sessionId = headerValue(request.headers["x-spendguard-session"]) || "proxy";
  const cwd = headerValue(request.headers["x-spendguard-project"]) || options.cwd || process.cwd();
  const gate = inspectSession({ home: options.home, sessionId, cwd });
  if (gate.action === "block") {
    const blocked = blockedResponse(options.provider, gate.message);
    response.writeHead(blocked.status, {
      "content-type": "application/json",
      "x-spendguard-action": "block",
      "x-spendguard-session": sessionId,
    });
    response.end(blocked.body);
    return;
  }

  const upstreamUrl = new URL(request.url ?? "/", upstream);
  const headers = forwardHeaders(request.headers, upstreamUrl);
  if (body.length > 0) headers["content-length"] = String(body.length);
  const transport = upstreamUrl.protocol === "https:" ? https : http;
  const upstreamRequest = transport.request(
    upstreamUrl,
    { method: request.method, headers },
    (upstreamResponse) => {
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamResponse.headers)) {
        if (!HOP.has(key.toLowerCase()) && value !== undefined) outHeaders[key] = value;
      }
      outHeaders["x-spendguard-action"] = gate.action;
      outHeaders["x-spendguard-session"] = sessionId;
      if (gate.action === "warn" && gate.message) outHeaders["x-spendguard-warning"] = oneLine(gate.message);
      response.writeHead(upstreamResponse.statusCode ?? 502, outHeaders);
      const responseChunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk: Buffer | string) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        responseChunks.push(buffer);
        response.write(buffer);
      });
      upstreamResponse.on("end", () => {
        const raw = Buffer.concat(responseChunks).toString("utf8");
        const requestModel = modelFromRequest(body.toString("utf8"), request.url ?? "");
        const parsed = parseProviderResponse(options.provider, raw, requestModel);
        if (parsed) {
          recordProxyCall({
            home: options.home,
            sessionId,
            cwd,
            ...(parsed.model ? { model: parsed.model } : {}),
            usage: parsed.usage,
            usageKey: usageKeyFor(sessionId, raw),
          });
        }
        response.end();
      });
    },
  );
  upstreamRequest.on("error", (error: NodeJS.ErrnoException) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: { message: `spendguard proxy upstream: ${error.message}` } }));
  });
  upstreamRequest.end(body);
}

function forwardHeaders(incoming: http.IncomingHttpHeaders, upstream: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (HOP.has(key.toLowerCase()) || value === undefined) continue;
    headers[key] = value;
  }
  headers.host = upstream.host;
  return headers;
}

function headerValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").replace(/[\r\n]+/g, "").slice(0, 200);
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 500);
}
