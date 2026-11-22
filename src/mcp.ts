import { buildStatus, formatStatus } from "./status.js";
import { isRecord } from "./jsonutil.js";

const PROTOCOL = "2024-11-05";

export function handleMcpMessage(message: unknown, options: { home: string }): unknown | null {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorResponse(null, -32600, "Invalid Request");
  }
  const id = "id" in message ? message.id : undefined;
  if (id === undefined) return null;
  const method = message.method;
  if (method === "initialize") {
    const params = isRecord(message.params) ? message.params : {};
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: "spendguard", version: "0.1.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "spendguard_status",
            description:
              "Read the local spendguard budget and measured spend. This tool cannot raise a cap or clear the kill switch.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "Optional session id. Omit to list recorded sessions.",
                },
              },
            },
          },
        ],
      },
    };
  }
  if (method === "tools/call") {
    const params = isRecord(message.params) ? message.params : {};
    if (params.name !== "spendguard_status") {
      return errorResponse(id, -32602, `Unknown tool ${String(params.name)}`);
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
    const report = buildStatus({
      home: options.home,
      scan: false,
      ...(sessionId ? { sessionId } : {}),
    });
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: formatStatus(report) }] },
    };
  }
  return errorResponse(id, -32601, `Method not found: ${method}`);
}

export async function serveMcp(home: string): Promise<void> {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      let response: unknown | null = null;
      try {
        response = handleMcpMessage(JSON.parse(body) as unknown, { home });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = errorResponse(null, -32700, message);
      }
      if (response) writeFrame(response);
    }
  };
  process.stdin.on("data", onData);
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => resolve());
  });
}

function writeFrame(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function errorResponse(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
