import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getStore } from "@netlify/blobs";

/** Netlify Blobs store for council sessions. Open a new client on every call. */
export const COUNCIL_STORE_NAME = "council-vote";

export interface CouncilStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Value plus a precondition token. etag is null when the key is absent. */
  getEtag?(key: string): Promise<{ value: string | null; etag: string | null }>;
  /**
   * Write only if the current etag still matches. null creates the key only
   * when it is absent. Returns false when the precondition fails.
   */
  compareAndSet?(key: string, value: string, etag: string | null): Promise<boolean>;
  /** One round trip for keys and their precondition tokens, when the store has them. */
  listEtags?(prefix: string): Promise<Array<{ key: string; etag: string }>>;
}

interface Versioned {
  value: string;
  etag: string;
}

export function memoryCouncilStore(): CouncilStore {
  const docs = new Map<string, Versioned>();
  let clock = 0;
  const etag = () => {
    clock += 1;
    return String(clock);
  };
  return {
    async get(key) {
      return docs.get(key)?.value ?? null;
    },
    async set(key, value) {
      docs.set(key, { value, etag: etag() });
    },
    async delete(key) {
      docs.delete(key);
    },
    async list(prefix) {
      return [...docs.keys()].filter((key) => key.startsWith(prefix));
    },
    async getEtag(key) {
      const found = docs.get(key);
      return found ? { value: found.value, etag: found.etag } : { value: null, etag: null };
    },
    async compareAndSet(key, value, match) {
      const found = docs.get(key);
      if (match === null) {
        if (found) return false;
      } else if (!found || found.etag !== match) {
        return false;
      }
      docs.set(key, { value, etag: etag() });
      return true;
    },
    async listEtags(prefix) {
      return [...docs.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, doc]) => ({ key, etag: doc.etag }));
    },
  };
}

const LOCAL_ROOT = path.join(process.cwd(), "data", "local", "council");

export function diskCouncilStore(root = LOCAL_ROOT): CouncilStore {
  const read = (key: string): { value: string | null; etag: string | null } => {
    const file = safeFile(root, key);
    if (!existsSync(file)) return { value: null, etag: null };
    const value = readFileSync(file, "utf8");
    return { value, etag: contentEtag(value) };
  };
  return {
    async get(key) {
      return read(key).value;
    },
    async set(key, value) {
      const file = safeFile(root, key);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, value);
    },
    async delete(key) {
      const file = safeFile(root, key);
      if (existsSync(file)) rmSync(file);
    },
    async list(prefix) {
      return walk(root)
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
        .filter((key) => key.startsWith(prefix));
    },
    async getEtag(key) {
      return read(key);
    },
    async compareAndSet(key, value, match) {
      const current = read(key);
      if (match === null) {
        if (current.value !== null) return false;
      } else if (current.etag !== match) {
        return false;
      }
      const file = safeFile(root, key);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, value);
      return true;
    },
    async listEtags(prefix) {
      return walk(root)
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, etag: contentEtag(readFileSync(safeFile(root, key), "utf8")) }));
    },
  };
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Class only. The message can carry store keys or request bodies, so it never goes to the log. */
export function blobFailureClass(error: unknown): string {
  const status = statusOf(error);
  if (status !== null) return `HTTP ${status}`;
  if (error instanceof Error && error.name) return error.name;
  return "unknown";
}

/** A warm instance's Blobs token. Retrying the same client cannot recover it. */
export function tokenExpired(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.includes("Token expired")) return false;
  const status = statusOf(error);
  return status === 401 || error.name === "BlobsInternalError";
}

export function isTransientBlobError(error: unknown): boolean {
  if (unconfigured(error)) return false;
  if (tokenExpired(error)) return false;
  if (error instanceof Error && error.message.startsWith("Refusing")) return false;
  const status = statusOf(error);
  if (status !== null) return TRANSIENT_STATUSES.has(status) || status >= 500;
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const name = error.name.toLowerCase();
  if (name.includes("timeout") || name.includes("abort") || name.includes("network")) return true;
  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("429")
  );
}

export interface RetryOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: "warn" | "error", line: string) => void;
  jitter?: () => number;
}

/** Two or three tries. The waits stay under a few hundred milliseconds, with a little jitter. */
export async function retryTransient<T>(op: string, run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((level, line) => (level === "warn" ? console.warn(line) : console.error(line)));
  const jitter = options.jitter ?? (() => Math.floor(Math.random() * 40));
  let last: unknown;
  for (let tryIndex = 0; tryIndex < attempts; tryIndex += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      const line = `council blob ${op} failed ${blobFailureClass(error)}`;
      if (tryIndex >= attempts - 1 || !isTransientBlobError(error)) {
        log("error", line);
        throw error;
      }
      log("warn", line);
      await sleep((tryIndex === 0 ? 40 : 90) + jitter());
    }
  }
  throw last;
}

interface CouncilBlobClient {
  get(key: string, options?: { type: "text" }): Promise<unknown>;
  set(key: string, value: string, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<{ modified: boolean }>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<{ blobs: Array<{ key: string; etag: string }> }>;
  getWithMetadata(key: string, options?: { type: "text" }): Promise<{ data?: unknown; etag?: string | null } | null>;
}

function defaultOpen(): CouncilBlobClient {
  return getStore({ name: COUNCIL_STORE_NAME, consistency: "strong" }) as CouncilBlobClient;
}

/**
 * A new client on every call. getStore captures the invocation's Blobs token,
 * and that token expires while a warm instance is still alive.
 */
export function councilStore(open: () => CouncilBlobClient = defaultOpen): CouncilStore {
  return createCouncilStore(open);
}

function createCouncilStore(open: () => CouncilBlobClient): CouncilStore {
  const disk = diskCouncilStore();
  const connect = (): CouncilBlobClient | null => {
    try {
      return open();
    } catch (error) {
      if (unconfigured(error)) return null;
      throw error;
    }
  };
  let remote = connect();
  const attempt = <T>(op: string, run: (client: CouncilBlobClient) => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    let refreshed = false;
    return retryTransient(op, async () => {
      if (!remote) return fallback();
      try {
        return await run(remote);
      } catch (error) {
        if (unconfigured(error)) {
          remote = null;
          return fallback();
        }
        if (!refreshed && tokenExpired(error)) {
          refreshed = true;
          console.warn(`council blob ${op} failed ${blobFailureClass(error)}`);
          remote = connect();
          if (!remote) return fallback();
          return run(remote);
        }
        throw error;
      }
    });
  };
  return {
    get(key) {
      return attempt("get", async (client) => {
        const value = await client.get(key, { type: "text" });
        return typeof value === "string" ? value : null;
      }, () => disk.get(key));
    },
    set(key, value) {
      return attempt("set", (client) => client.set(key, value).then(() => undefined), () => disk.set(key, value));
    },
    delete(key) {
      return attempt("delete", (client) => client.delete(key).then(() => undefined), () => disk.delete(key));
    },
    list(prefix) {
      return attempt("list", async (client) => {
        const result = await client.list({ prefix });
        return result.blobs.map((entry) => entry.key);
      }, () => disk.list(prefix));
    },
    getEtag(key) {
      return attempt("getEtag", async (client) => {
        const result = await client.getWithMetadata(key, { type: "text" });
        if (!result || typeof result.data !== "string") return { value: null, etag: null };
        return { value: result.data, etag: result.etag ?? null };
      }, () => disk.getEtag?.(key) ?? disk.get(key).then((value) => ({ value, etag: null })));
    },
    compareAndSet(key, value, match) {
      return attempt("compareAndSet", async (client) => {
        const result = match === null ? await client.set(key, value, { onlyIfNew: true }) : await client.set(key, value, { onlyIfMatch: match });
        return result.modified;
      }, () => disk.compareAndSet?.(key, value, match) ?? Promise.resolve(false));
    },
    listEtags(prefix) {
      return attempt("listEtags", async (client) => {
        const result = await client.list({ prefix });
        return result.blobs.map((entry) => ({ key: entry.key, etag: entry.etag }));
      }, () => disk.listEtags?.(prefix) ?? Promise.resolve([]));
    },
  };
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { status?: unknown; statusCode?: unknown };
  const raw = record.status ?? record.statusCode;
  return typeof raw === "number" ? raw : null;
}

function contentEtag(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function safeFile(root: string, key: string): string {
  if (!key || key.includes("..") || key.startsWith("/") || key.includes("\\")) {
    throw new Error("Refusing a council key that escapes the store");
  }
  const file = path.resolve(root, ...key.split("/"));
  const base = path.resolve(root);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) {
    throw new Error("Refusing a council key that escapes the store");
  }
  return file;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function unconfigured(error: unknown): boolean {
  return error instanceof Error && error.name === "MissingBlobsEnvironmentError";
}
