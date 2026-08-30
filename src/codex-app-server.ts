import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type JsonRpcId = string | number;

export interface RpcServerRequest {
  method: string;
  id: JsonRpcId;
  params: Record<string, unknown>;
}

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export class JsonlFramer {
  #buffer = "";

  constructor(readonly maxBytes = 5 * 1024 * 1024) {}

  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > this.maxBytes) {
      this.#buffer = "";
      throw new Error("Codex app-server JSONL frame exceeded the size limit");
    }
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CodexJsonLinePeer extends EventEmitter {
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextId = 1;

  constructor(readonly writeLine: (line: string) => void, readonly timeoutMs = 10_000) {
    super();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.writeLine(JSON.stringify({ method, id, params }));
    });
  }

  notify(method: string): void {
    this.writeLine(JSON.stringify({ method }));
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writeLine(JSON.stringify({ id, result }));
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.writeLine(JSON.stringify({ id, error: { code, message } }));
  }

  ingestLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("Codex app-server emitted invalid JSON"));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const envelope = message as Record<string, unknown>;
    const id = envelope.id;
    if ((typeof id === "string" || typeof id === "number") && !envelope.method) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (envelope.error && typeof envelope.error === "object") {
        pending.reject(new Error(JSON.stringify(envelope.error)));
      } else {
        pending.resolve(envelope.result);
      }
      return;
    }
    if (typeof envelope.method !== "string") return;
    const params = envelope.params && typeof envelope.params === "object" && !Array.isArray(envelope.params)
      ? envelope.params as Record<string, unknown>
      : {};
    if (typeof id === "string" || typeof id === "number") {
      this.emit("serverRequest", { method: envelope.method, id, params } satisfies RpcServerRequest);
    } else {
      this.emit("notification", { method: envelope.method, params } satisfies RpcNotification);
    }
  }

  failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export interface CodexThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  updatedAt?: number;
  status?: { type?: string; activeFlags?: string[] };
}

export interface CodexAppServerOptions {
  executable?: string;
  cwd?: string;
}

export class CodexAppServerClient extends EventEmitter {
  #child: ChildProcessWithoutNullStreams | undefined;
  #peer: CodexJsonLinePeer | undefined;
  #closing = false;
  readonly connectionEpoch = randomUUID();

  constructor(readonly options: CodexAppServerOptions = {}) {
    super();
  }

  async start(): Promise<void> {
    if (this.#child) return;
    const executable = this.options.executable ?? await discoverCodexExecutable();
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: this.options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    const peer = new CodexJsonLinePeer((line) => child.stdin.write(`${line}\n`));
    const framer = new JsonlFramer();
    this.#peer = peer;
    peer.on("serverRequest", (request) => this.emit("serverRequest", request));
    peer.on("notification", (notification) => this.emit("notification", notification));
    peer.on("protocolError", (error) => this.emit("protocolError", error));
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const line of framer.push(chunk)) peer.ingestLine(line);
      } catch (error) {
        this.emit("protocolError", error);
        child.kill();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("diagnostic", chunk.slice(-1_000)));
    child.once("error", (error) => peer.failPending(error));
    child.once("exit", (code, signal) => {
      this.#child = undefined;
      this.#peer = undefined;
      peer.failPending(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
      if (!this.#closing) this.emit("disconnected");
    });

    await peer.request("initialize", {
      clientInfo: { name: "attention_deck", title: "Attention Deck", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    peer.notify("initialized");
    this.emit("connected");
  }

  async listThreads(): Promise<CodexThreadSummary[]> {
    if (!this.#peer) throw new Error("Codex app-server is not connected");
    const result = await this.#peer.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
      archived: false,
    }) as { data?: CodexThreadSummary[] };
    return Array.isArray(result?.data) ? result.data : [];
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (!this.#peer) throw new Error("Codex app-server is not connected");
    this.#peer.respond(id, result);
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (!this.#peer) throw new Error("Codex app-server is not connected");
    this.#peer.respondError(id, code, message);
  }

  close(): void {
    this.#closing = true;
    this.#child?.kill();
    this.#child = undefined;
    this.#peer = undefined;
  }
}

export async function discoverCodexExecutable(): Promise<string> {
  const configured = process.env.ATTENTION_DECK_CODEX_EXECUTABLE;
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const installed = join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    try {
      await access(installed, constants.X_OK);
      return installed;
    } catch {
      // Fall through to PATH for nonstandard and development installations.
    }
  }
  return "codex";
}
