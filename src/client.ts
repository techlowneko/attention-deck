import { readFile } from "node:fs/promises";
import { defaultTokenPath } from "./auth.js";
import type { EmitItem } from "./protocol.js";
import type { Snapshot } from "./store.js";

export class BrokerClient {
  constructor(
    readonly baseUrl = process.env.ATTENTION_DECK_URL ?? "http://127.0.0.1:17893",
    readonly tokenPath = process.env.ATTENTION_DECK_TOKEN_FILE ?? defaultTokenPath(),
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const body = await response.json() as unknown;
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
}
