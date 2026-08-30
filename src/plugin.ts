import streamDeck, {
  action,
  type DialDownEvent,
  type DialRotateEvent,
  type DialUpEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { DialAction, KeyAction } from "@elgato/streamdeck";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startBroker, type BrokerHandle } from "./broker.js";
import { BrokerClient } from "./client.js";
import { CodexAttentionAdapter } from "./codex-adapter.js";
import { actionKey, idleKey, keyCard } from "./render.js";
import type { AttentionAction, AttentionItem } from "./protocol.js";
import { AttentionStore, type Snapshot } from "./store.js";

type DeckMutation = Exclude<AttentionAction, "open">;

function recordStartupFailure(reason: unknown): void {
  try {
    const logs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "logs");
    mkdirSync(logs, { recursive: true });
    const logPath = resolve(logs, "startup.log");
    try {
      if (statSync(logPath).size >= 256 * 1024) return;
    } catch {
      // The first startup failure creates the file.
    }
    const raw = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    const userProfile = process.env.USERPROFILE;
    const detail = raw
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(userProfile ? new RegExp(userProfile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : /$^/, "[USERPROFILE]")
      .slice(0, 16 * 1024);
    appendFileSync(logPath, `${new Date().toISOString()} ${detail}\n`, "utf8");
  } catch {
    // Stream Deck will still record the process exit if its plugin directory is unavailable.
  }
}

process.on("uncaughtException", (error) => {
  recordStartupFailure(error);
  process.exitCode = 1;
});
process.on("unhandledRejection", (error) => {
  recordStartupFailure(error);
  process.exitCode = 1;
});

class SurfaceCoordinator {
  snapshot: Snapshot = { protocol: "attention/1", cursor: 0, generated_at: new Date().toISOString(), items: [] };
  selected = 0;
  detailPage = 0;
  selectedAction: DeckMutation = "snooze";
  online = false;
  providerState: "connecting" | "connected" | "offline" = "connecting";

  constructor(
    readonly client: BrokerClient,
    readonly providerAction: (item: AttentionItem, action: "approve" | "deny", attemptId: string) => Promise<AttentionItem>,
  ) {}

  get item(): AttentionItem | undefined {
    return this.snapshot.items[this.selected];
  }

  async refresh(): Promise<void> {
    try {
      this.snapshot = await this.client.snapshot();
      this.online = true;
      if (this.selected >= this.snapshot.items.length) this.selected = Math.max(0, this.snapshot.items.length - 1);
      this.normalizeAction();
    } catch {
      this.online = false;
    }
    await Promise.all([keyAction.render(), encoderAction.render()]);
  }

  selectDelta(delta: number): void {
    const length = this.snapshot.items.length;
    if (length === 0) return;
    this.selected = (this.selected + Math.sign(delta) + length) % length;
    this.detailPage = 0;
    this.normalizeAction();
  }

  actions(item = this.item): AttentionAction[] {
    if (!item) return [];
    const declared = item.available_actions ? [...item.available_actions] : ["dismiss", "snooze"] as AttentionAction[];
    if (item.locator && !declared.includes("open")) declared.unshift("open");
    return declared;
  }

  normalizeAction(): void {
    const actions = this.actions().filter((name): name is DeckMutation => name !== "open");
    if (!actions.includes(this.selectedAction)) this.selectedAction = actions[0] ?? "snooze";
  }

  rotateAction(delta: number): void {
    const actions = this.actions().filter((name): name is DeckMutation => name !== "open");
    if (!actions.length) return;
    const current = Math.max(0, actions.indexOf(this.selectedAction));
    this.selectedAction = actions[(current + Math.sign(delta) + actions.length) % actions.length]!;
  }

  async executeAction(actionName: AttentionAction, captured?: { id: string; version: number }): Promise<void> {
    const item = captured ? this.snapshot.items.find((candidate) => candidate.id === captured.id) : this.item;
    if (!item) return;
    if (captured && item.version !== captured.version) throw new Error("item changed while confirming action");
    if (actionName === "open") {
      if (!item.locator) throw new Error("item has no trusted locator");
      await streamDeck.system.openUrl(item.locator.target);
      return;
    }
    if (actionName === "approve" || actionName === "deny") {
      await this.providerAction(item, actionName, randomUUID());
    } else {
      await this.client.action(item.id, actionName, item.version, actionName === "snooze" ? 300_000 : undefined);
    }
    await this.refresh();
  }
}

const store = new AttentionStore();
const codexAdapter = new CodexAttentionAdapter(store);
let broker: BrokerHandle | undefined;
try {
  broker = await startBroker({ store });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
}

const surface = new SurfaceCoordinator(
  new BrokerClient(),
  (item, name, attemptId) => codexAdapter.execute(item, name, attemptId),
);
type HeldAction = { startedAt: number; itemId: string; version: number; action: "approve" | "deny" };
const heldKeys = new Map<string, HeldAction>();
const heldDials = new Map<string, HeldAction>();
const HOLD_MS = 750;

@action({ UUID: "com.preflightstack.attention-deck.key" })
class AttentionKeyAction extends SingletonAction {
  override async onWillAppear(_event: WillAppearEvent): Promise<void> {
    await surface.refresh();
  }

  override async onKeyDown(event: KeyDownEvent): Promise<void> {
    const coordinates = event.action.coordinates;
    if (!coordinates) return;
    if (coordinates.row === 0 && coordinates.column < 4) {
      if (surface.snapshot.items[coordinates.column]) {
        surface.selected = coordinates.column;
        surface.normalizeAction();
      }
    } else if (coordinates.row === 1 && coordinates.column === 1 && surface.item?.available_actions?.includes("approve")) {
      this.capture(event.action.id, "approve");
      return;
    } else if (coordinates.row === 1 && coordinates.column === 2) {
      if (surface.item?.available_actions?.includes("deny")) {
        this.capture(event.action.id, "deny");
        return;
      }
      if (!surface.item?.available_actions && surface.item) await this.execute(event.action, "dismiss");
      return;
    } else if (coordinates.row === 1 && coordinates.column === 3) {
      await this.execute(event.action, "snooze");
      return;
    } else if (coordinates.row === 1 && coordinates.column === 0) {
      await this.execute(event.action, "open");
      return;
    }
    await Promise.all([this.render(), encoderAction.render()]);
  }

  override async onKeyUp(event: KeyUpEvent): Promise<void> {
    const held = heldKeys.get(event.action.id);
    heldKeys.delete(event.action.id);
    if (!held || Date.now() - held.startedAt < HOLD_MS) return;
    await this.execute(event.action, held.action, { id: held.itemId, version: held.version });
  }

  capture(actionId: string, name: "approve" | "deny"): void {
    const item = surface.item;
    if (!item || item.action_status !== "ready") return;
    heldKeys.set(actionId, { startedAt: Date.now(), itemId: item.id, version: item.version, action: name });
  }

  async execute(source: KeyAction, name: AttentionAction, captured?: { id: string; version: number }): Promise<void> {
    try {
      await surface.executeAction(name, captured);
      await source.showOk();
    } catch {
      await source.showAlert();
      await surface.refresh();
    }
  }

  async render(): Promise<void> {
    const now = new Date();
    for (const visible of this.actions) {
      if (!visible.isKey()) continue;
      const coordinates = visible.coordinates;
      if (!coordinates) continue;
      let image: string;
      if (coordinates.row === 0) {
        const item = surface.snapshot.items[coordinates.column];
        image = item
          ? keyCard(item, coordinates.column === surface.selected, now)
          : idleKey(surface.snapshot.items.length === 0 && coordinates.column === 0, surface.providerState);
      } else {
        const item = surface.item;
        if (coordinates.column === 0) image = actionKey("OPEN", Boolean(item?.locator));
        else if (coordinates.column === 1) image = actionKey("APPROVE", Boolean(item?.available_actions?.includes("approve")), "#75b798");
        else if (coordinates.column === 2) {
          const providerDeny = Boolean(item?.available_actions?.includes("deny"));
          const genericDismiss = Boolean(item && !item.available_actions);
          image = actionKey(providerDeny ? "DENY" : "DISMISS", providerDeny || genericDismiss, providerDeny ? "#ef6f6c" : "#7e8b96");
        } else image = actionKey("SNOOZE", Boolean(item && (!item.available_actions || item.available_actions.includes("snooze"))), "#58c4dd");
      }
      await visible.setImage(image);
    }
  }
}

@action({ UUID: "com.preflightstack.attention-deck.encoder" })
class AttentionEncoderAction extends SingletonAction {
  override async onWillAppear(_event: WillAppearEvent): Promise<void> {
    await surface.refresh();
  }

  override async onDialRotate(event: DialRotateEvent): Promise<void> {
    const column = event.action.coordinates.column;
    if (column === 0) surface.selectDelta(event.payload.ticks);
    else if (column === 1) surface.detailPage = Math.max(0, surface.detailPage + Math.sign(event.payload.ticks));
    else if (column === 2) surface.rotateAction(event.payload.ticks);
    await Promise.all([keyAction.render(), this.render()]);
  }

  override async onDialDown(event: DialDownEvent): Promise<void> {
    const column = event.action.coordinates.column;
    if (column === 0 && surface.item?.locator) await streamDeck.system.openUrl(surface.item.locator.target);
    else if (column === 1) surface.detailPage = 0;
    else if (column === 2) {
      if (surface.selectedAction === "approve" || surface.selectedAction === "deny") {
        const item = surface.item;
        if (item?.action_status === "ready") {
          heldDials.set(event.action.id, { startedAt: Date.now(), itemId: item.id, version: item.version, action: surface.selectedAction });
        }
      } else await this.execute(event.action);
    }
    await Promise.all([keyAction.render(), this.render()]);
  }

  override async onDialUp(event: DialUpEvent): Promise<void> {
    const held = heldDials.get(event.action.id);
    heldDials.delete(event.action.id);
    if (!held || Date.now() - held.startedAt < HOLD_MS) return;
    await this.execute(event.action, held);
  }

  override async onTouchTap(event: TouchTapEvent): Promise<void> {
    const column = event.action.coordinates.column;
    if (column === 2 && event.payload.hold) await this.execute(event.action);
    else if (column === 0 && surface.item?.locator) await streamDeck.system.openUrl(surface.item.locator.target);
  }

  async execute(source: DialAction, held?: HeldAction): Promise<void> {
    try {
      await surface.executeAction(held?.action ?? surface.selectedAction, held ? { id: held.itemId, version: held.version } : undefined);
    } catch {
      await source.showAlert();
      await surface.refresh();
    }
  }

  async render(): Promise<void> {
    for (const visible of this.actions) {
      if (!visible.isDial()) continue;
      const column = visible.coordinates.column;
      const item = surface.item;
      let eyebrow = "ATTENTION DECK";
      let primary = surface.online ? (surface.providerState === "connected" ? "NOTHING NEEDS YOU" : "CODEX OFFLINE") : "BROKER OFFLINE";
      let secondary = surface.online ? (surface.providerState === "connecting" ? "CONNECTING" : surface.providerState === "connected" ? "ALL CLEAR" : "ACTIONS LOCKED") : "RECONNECTING";
      if (item && column === 0) {
        eyebrow = `ITEM ${surface.selected + 1}/${surface.snapshot.items.length}`;
        primary = item.project;
        secondary = `${item.source.toUpperCase()} · ${item.freshness === "stale" ? "STALE" : item.state}`;
      } else if (item && column === 1) {
        eyebrow = "WHY";
        const start = surface.detailPage * 34;
        primary = item.summary.slice(start, start + 34) || item.summary.slice(0, 34);
        secondary = item.title;
      } else if (item && column === 2) {
        const providerAction = surface.selectedAction === "approve" || surface.selectedAction === "deny";
        eyebrow = providerAction ? "ACTION · HOLD 0.75S" : "ACTION";
        primary = `${providerAction ? "HOLD " : ""}${surface.selectedAction.toUpperCase()}`;
        secondary = item.action_status === "sending" ? "SENDING" : surface.selectedAction === "snooze" ? "SNOOZE 5 MIN" : providerAction ? "EXACT CODEX REQUEST" : "RESOLVE LOCALLY";
      } else if (item && column === 3) {
        eyebrow = "VIEW";
        primary = `NEEDS ME ${surface.snapshot.items.length}`;
        secondary = item.freshness === "stale" ? "SOURCE STALE" : "LIVE";
      }
      await visible.setFeedback({ eyebrow, primary, secondary });
    }
  }
}

const keyAction = new AttentionKeyAction();
const encoderAction = new AttentionEncoderAction();
streamDeck.actions.registerAction(keyAction);
streamDeck.actions.registerAction(encoderAction);
streamDeck.system.onSystemDidWakeUp(() => void surface.refresh());
await streamDeck.connect();
await surface.refresh();
if (broker) {
  codexAdapter.client.on("disconnected", () => {
    surface.providerState = "offline";
    void surface.refresh();
  });
  void codexAdapter.start().then(() => {
    surface.providerState = "connected";
    return surface.refresh();
  }).catch((error) => {
    surface.providerState = "offline";
    recordStartupFailure(error);
    return surface.refresh();
  });
}
setInterval(() => void surface.refresh(), 1_000).unref();

process.once("beforeExit", () => {
  codexAdapter.close();
  void broker?.close();
});
