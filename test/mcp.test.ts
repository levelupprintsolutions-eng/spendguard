import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import "./env.js";
import { setBudget } from "../src/budget.js";
import { handleMcpMessage } from "../src/mcp.js";
import { isRecord } from "../src/jsonutil.js";

test("MCP status is read-only and reports the configured cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spendguard-mcp-"));
  setBudget(dir, { kind: "global-session" }, { usd: 4 });
  const init = handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, { home: dir });
  assert.ok(isRecord(init) && isRecord(init.result));
  assert.equal(isRecord(init.result.serverInfo) && init.result.serverInfo.name, "spendguard");
  const tools = handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { home: dir });
  assert.ok(isRecord(tools) && isRecord(tools.result) && Array.isArray(tools.result.tools));
  assert.equal(tools.result.tools.length, 1);
  assert.equal(tools.result.tools[0].name, "spendguard_status");
  const call = handleMcpMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spendguard_status", arguments: {} } },
    { home: dir },
  );
  assert.ok(isRecord(call) && isRecord(call.result) && Array.isArray(call.result.content));
  assert.match(String(call.result.content[0].text), /\$4\.0000/);
  const note = handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { home: dir });
  assert.equal(note, null);
});
