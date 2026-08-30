import { readFile } from "node:fs/promises";
import { defaultTokenPath } from "./auth.js";
import type { EmitItem } from "./protocol.js";
import type { Snapshot } from "./store.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error("broker response was too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export class BrokerClient {
  constructor(
    readonly baseUrl = process.env.ATTENTION_DECK_URL ?? "http://127.0.0.1:17893",
    readonly tokenPath = process.env.ATTENTION_DECK_TOKEN_FILE ?? defaultTokenPath(),
    readonly timeoutMs = 2_000,
  ) {}

  async snapshot(): Promise<Snapshot> {
    return this.#request("/v1/snapshot", { method: "GET" }) as Promise<Snapshot>;
  }

  async emit(item: EmitItem): Promise<unknown> {
    return this.#request("/v1/events", { method: "POST", body: JSON.stringify(item) });
  }

  async action(id: string, action: "dismiss" | "snooze", version: number, durationMs?: number): Promise<unknown> {
    return this.#request(`/v1/items/${encodeURIComponent(id)}/actions/${action}`, {
      method: "POST",
      body: JSON.stringify({
        version,
        ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      }),
    });
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const token = (await readFile(this.tokenPath, "utf8")).trim();
    if (token.length < 32 || token.length > 256) throw new Error("broker token is invalid");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const body = await boundedJson(response);
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
}
