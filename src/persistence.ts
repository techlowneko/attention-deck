import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;

export type PersistenceLoadResult =
  | { status: "missing" }
  | { status: "loaded"; value: unknown }
  | { status: "quarantined"; path: string; reason: string }
  | { status: "blocked"; reason: string };

export function defaultPersistencePath(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const base = localAppData || join(homedir(), "AppData", "Local");
  return join(base, "Preflight Stack", "Attention Deck", "state.json");
}

export class JsonFilePersistence {
  constructor(readonly path: string) {}

  load(): PersistenceLoadResult {
    if (!existsSync(this.path)) return { status: "missing" };
    try {
      if (statSync(this.path).size > MAX_STATE_FILE_BYTES) return this.#quarantine("state file exceeds the 8 MiB limit");
      const raw = readFileSync(this.path, "utf8");
      try {
        return { status: "loaded", value: JSON.parse(raw) as unknown };
      } catch {
        return this.#quarantine("state file contains invalid JSON");
      }
    } catch (error) {
      return { status: "blocked", reason: error instanceof Error ? error.message : "state file is unreadable" };
    }
  }

  save(value: unknown): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_FILE_BYTES) {
      throw new RangeError("persisted state exceeds the 8 MiB limit");
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  #quarantine(reason: string): PersistenceLoadResult {
    const quarantined = `${this.path}.corrupt-${randomUUID()}`;
    try {
      renameSync(this.path, quarantined);
      return { status: "quarantined", path: quarantined, reason };
    } catch (error) {
      return {
        status: "blocked",
        reason: `${reason}; quarantine failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }
}
