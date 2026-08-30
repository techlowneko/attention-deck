import { createHash } from "node:crypto";
import { basename } from "node:path";
import { TextDecoder } from "node:util";
import { defaultTokenPath } from "./auth.js";
import { BrokerClient } from "./client.js";
import type { EmitItem } from "./protocol.js";

export const MAX_CODEX_HOOK_BYTES = 1024 * 1024;

interface EmitClient {
  emit(item: EmitItem): Promise<unknown>;
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function requiredIdentifier(input: Record<string, unknown>, name: "session_id" | "turn_id"): string | undefined {
  const value = input[name];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 160 ? normalized : undefined;
}

function projectLabel(cwd: unknown): string {
  if (typeof cwd !== "string" || !cwd.trim()) return "Codex";
  if (cwd.length > 4_096) return "Codex";
  const label = basename(cwd.trim()) || "Codex";
  return boundedText(label, 80) || "Codex";
}

export function codexStopEvent(value: unknown): EmitItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.hook_event_name !== "Stop") return undefined;
  if (input.stop_hook_active !== false) return undefined;
  const sessionId = requiredIdentifier(input, "session_id");
  const turnId = requiredIdentifier(input, "turn_id");
  if (!sessionId || !turnId) return undefined;

  const identity = createHash("sha256").update(`attention-deck-stop/1\0${sessionId}\0${turnId}`).digest("hex");
  const session = createHash("sha256").update(`attention-deck-session/1\0${sessionId}`).digest("hex");
  return {
    protocol: "attention/1",
    event_id: `codex-stop:${identity}`,
    source: "codex",
    project: projectLabel(input.cwd),
    session: `codex-session:${session}`,
    state: "REVIEW",
    title: "Codex turn ready",
    summary: "Open Codex to review.",
    priority: 1,
  };
}

export async function dispatchCodexStopHook(
  value: unknown,
  options: { client?: EmitClient } = {},
): Promise<boolean> {
  const event = codexStopEvent(value);
  if (!event) return false;
  await (options.client ?? new BrokerClient("http://127.0.0.1:17893", defaultTokenPath(), 750)).emit(event);
  return true;
}

export async function readCodexHookInput(stream: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CODEX_HOOK_BYTES) throw new Error("Codex hook input exceeded the size limit");
    chunks.push(buffer);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).trim();
  if (!text) throw new Error("Codex hook input was empty");
  return JSON.parse(text) as unknown;
}
