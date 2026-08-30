import { randomUUID } from "node:crypto";
import { BrokerClient } from "./client.js";
import { ATTENTION_STATES, type AttentionState, type EmitItem } from "./protocol.js";

function parseArgs(values: string[]): { command: string; options: Map<string, string> } {
  const [command = "help", ...rest] = values;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`expected --name value, received ${key ?? "end of input"}`);
    // npm on Windows can preserve cmd.exe caret escapes around forwarded quoted values.
    options.set(key.slice(2), value.replaceAll("^", ""));
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function help(): void {
  console.log(`attention-deck

  emit    --project NAME --state APPROVAL --title TEXT --summary TEXT [--source cli] [--session ID]
  list
  dismiss --id ITEM_ID --version N
  snooze  --id ITEM_ID --version N [--minutes 5]

Environment: ATTENTION_DECK_URL, ATTENTION_DECK_TOKEN_FILE`);
}

const { command, options } = parseArgs(process.argv.slice(2));
const client = new BrokerClient();

if (command === "emit") {
  const state = required(options, "state").toUpperCase() as AttentionState;
  if (!ATTENTION_STATES.includes(state)) throw new Error(`invalid state: ${state}`);
  const item: EmitItem = {
    protocol: "attention/1",
    event_id: options.get("event-id") ?? randomUUID(),
    source: options.get("source") ?? "cli",
    project: required(options, "project"),
    state,
    title: required(options, "title"),
    summary: required(options, "summary"),
  };
  const session = options.get("session");
  if (session) item.session = session;
  console.log(JSON.stringify(await client.emit(item), null, 2));
} else if (command === "list") {
  console.log(JSON.stringify(await client.snapshot(), null, 2));
} else if (command === "dismiss") {
  console.log(JSON.stringify(await client.action(required(options, "id"), "dismiss", Number(required(options, "version"))), null, 2));
} else if (command === "snooze") {
  const minutes = Number(options.get("minutes") ?? "5");
  console.log(JSON.stringify(await client.action(required(options, "id"), "snooze", Number(required(options, "version")), minutes * 60_000), null, 2));
} else {
  help();
  if (command !== "help") process.exitCode = 2;
}
