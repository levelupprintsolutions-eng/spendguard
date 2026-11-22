#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "src", "cli.js");

try {
  await import(pathToFileURL(entry).href);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("spendguard is not built yet. From the repo, run: npm install");
  console.error(message);
  process.exit(1);
}
