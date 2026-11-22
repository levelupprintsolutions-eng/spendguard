import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveHome(override?: string): string {
  if (override) return path.resolve(override);
  const fromEnv = process.env.SPENDGUARD_HOME;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".spendguard");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

export function pathUnder(parent: string, child: string): boolean {
  const root = path.resolve(parent);
  const candidate = path.resolve(child);
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function resolveExisting(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Best-effort exclusive lock. A lock older than 30s is treated as abandoned
 * so a crashed hook cannot wedge every later tool call.
 */
export function withLock<T>(dir: string, fn: () => T): T {
  ensureDir(dir);
  const lockPath = path.join(dir, ".lock");
  const started = Date.now();
  let fd: number | null = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > 10_000) {
        throw new Error("spendguard timed out waiting for its state lock");
      }
      const until = Date.now() + 20;
      while (Date.now() < until) {
        // Short wait. Hooks are synchronous and this rarely loops.
      }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Another waiter may already have replaced it.
    }
  }
}

export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
