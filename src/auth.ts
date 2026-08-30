import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultTokenPath(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".attention-deck");
  return join(base, "AttentionDeck", "auth-token");
}

export async function loadOrCreateToken(path = defaultTokenPath()): Promise<string> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (value.length >= 32) return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return (await readFile(path, "utf8")).trim();
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
