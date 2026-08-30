import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { bearerMatches, loadOrCreateToken } from "./auth.js";
import { validateEmitItem } from "./protocol.js";
import { AttentionStore, ConflictError, NotFoundError } from "./store.js";

const MAX_BODY_BYTES = 32 * 1024;

export interface BrokerOptions {
  host?: "127.0.0.1";
  port?: number;
  token?: string;
  store?: AttentionStore;
}

export interface BrokerHandle {
  host: string;
  port: number;
  token: string;
  store: AttentionStore;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new HttpError(415, "content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function routeParts(url: string | undefined): string[] {
  return new URL(url ?? "/", "http://127.0.0.1").pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function assertLoopbackHost(request: IncomingMessage, port: number): void {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!request.headers.host || !allowed.has(request.headers.host.toLowerCase())) throw new HttpError(400, "invalid Host header");
  if (request.headers.origin) throw new HttpError(403, "browser origins are not accepted");
}

export async function startBroker(options: BrokerOptions = {}): Promise<BrokerHandle> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? await loadOrCreateToken();
  const store = options.store ?? new AttentionStore();
  let actualPort = options.port ?? 17_893;

  const server = createServer(async (request, response) => {
    try {
      assertLoopbackHost(request, actualPort);
      const parts = routeParts(request.url);
      if (request.method === "GET" && parts.join("/") === "health") {
        json(response, 200, { ok: true, protocol: "attention/1" });
        return;
      }
      if (!bearerMatches(request.headers.authorization, token)) throw new HttpError(401, "authentication required");
      if (request.method === "GET" && parts.join("/") === "v1/snapshot") {
        json(response, 200, store.snapshot());
        return;
      }
      if (request.method === "POST" && parts.join("/") === "v1/events") {
        const item = store.upsert(validateEmitItem(await readJson(request)));
        json(response, 202, { item, cursor: store.snapshot().cursor });
        return;
      }
      if (request.method === "POST" && parts.length === 5 && parts[0] === "v1" && parts[1] === "items" && parts[3] === "actions") {
        const body = await readJson(request) as Record<string, unknown>;
        if (!Number.isSafeInteger(body.version)) throw new HttpError(400, "version is required");
        const id = parts[2]!;
        const action = parts[4];
        const current = store.get(id);
        if (!current) throw new NotFoundError("item not found");
        if (current.version !== body.version) throw new ConflictError("item changed; refresh before acting");
        if (action === "dismiss") {
          json(response, 200, { item: store.resolve(id, body.version as number) });
          return;
        }
        if (action === "snooze") {
          if (current.available_actions && !current.available_actions.includes("snooze")) {
            throw new ConflictError("action is no longer available");
          }
          const durationMs = Number.isSafeInteger(body.duration_ms) ? Number(body.duration_ms) : 300_000;
          if (durationMs < 60_000 || durationMs > 86_400_000) throw new HttpError(400, "duration_ms must be 60000-86400000");
          json(response, 200, { item: store.snooze(id, body.version as number, durationMs) });
          return;
        }
        throw new HttpError(404, "unknown action");
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) json(response, error.status, { error: error.message });
      else if (error instanceof ConflictError) json(response, 409, { error: error.message });
      else if (error instanceof NotFoundError) json(response, 404, { error: error.message });
      else if (error instanceof Error) json(response, 400, { error: error.message });
      else json(response, 500, { error: "internal_error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 17_893, host, () => resolve());
  });
  actualPort = (server.address() as AddressInfo).port;
  return {
    host,
    port: actualPort,
    token,
    store,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
