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
import {
  actionKey,
  idleKey,
  keyCard,
  occurrenceCount,
  recentOutcomeLabel,
  type SurfaceView,
} from "./render.js";
import type { AttentionAction, AttentionItem } from "./protocol.js";
import { AttentionStore, type Snapshot } from "./store.js";

type DeckMutation = Exclude<AttentionAction, "open">;

const SURFACE_VIEWS: readonly SurfaceView[] = ["NEEDS_ME", "ACTIVE", "RECENT"];
const SNOOZE_PRESETS = [
  { label: "5 MIN", keyLabel: "5M", durationMs: () => 5 * 60_000 },
  { label: "15 MIN", keyLabel: "15M", durationMs: () => 15 * 60_000 },
  { label: "1 HOUR", keyLabel: "1H", durationMs: () => 60 * 60_000 },
  {
    label: "TOMORROW",
    keyLabel: "TOMORROW",
    durationMs: (now = new Date()) => {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return Math.max(60_000, tomorrow.getTime() - now.getTime());
    },
  },
] as const;

type ExpandedSnapshot = Snapshot & Partial<{ active: AttentionItem[]; recent: AttentionItem[] }>;

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
  snapshot: ExpandedSnapshot = {
    protocol: "attention/1",
    cursor: 0,
    generated_at: new Date().toISOString(),
    items: [],
    active: [],
    recent: [],
  };
  selected = 0;
  detailPage = 0;
  selectedAction: DeckMutation = "snooze";
  snoozePreset = 0;
  view: SurfaceView = "NEEDS_ME";
  online = false;
  providerState: "connecting" | "connected" | "offline" = "connecting";

  constructor(
    readonly client: BrokerClient,
    readonly providerAction: (item: AttentionItem, action: "approve" | "deny", attemptId: string) => Promise<AttentionItem>,
  ) {}

  get item(): AttentionItem | undefined {
    return this.viewItems[this.selected];
  }

  get viewItems(): AttentionItem[] {
    if (this.view === "ACTIVE") return this.snapshot.active ?? [];
    if (this.view === "RECENT") return this.snapshot.recent ?? [];
    return this.snapshot.items;
  }

  get snooze(): (typeof SNOOZE_PRESETS)[number] {
    return SNOOZE_PRESETS[this.snoozePreset]!;
  }

  count(view: SurfaceView): number {
    if (view === "ACTIVE") return this.snapshot.active?.length ?? 0;
    if (view === "RECENT") return this.snapshot.recent?.length ?? 0;
    return this.snapshot.items.length;
  }

  async refresh(): Promise<void> {
    try {
      this.snapshot = await this.client.snapshot();
      this.online = true;
      if (this.selected >= this.viewItems.length) this.selected = Math.max(0, this.viewItems.length - 1);
      this.normalizeAction();
    } catch {
      this.online = false;
    }
    await Promise.all([keyAction.render(), encoderAction.render()]);
  }

  selectDelta(delta: number): void {
    const length = this.viewItems.length;
    if (length === 0) return;
    this.selected = (this.selected + Math.sign(delta) + length) % length;
    this.detailPage = 0;
    this.normalizeAction();
  }

  actions(item = this.item): AttentionAction[] {
    if (!item) return [];
    if (this.view !== "NEEDS_ME") return item.locator ? ["open"] : [];
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

  rotateSnooze(delta: number): void {
    const length = SNOOZE_PRESETS.length;
    this.snoozePreset = (this.snoozePreset + Math.sign(delta) + length) % length;
  }

  rotateView(delta: number): void {
    const current = SURFACE_VIEWS.indexOf(this.view);
    this.view = SURFACE_VIEWS[(current + Math.sign(delta) + SURFACE_VIEWS.length) % SURFACE_VIEWS.length]!;
    this.selected = 0;
    this.detailPage = 0;
    this.normalizeAction();
  }

  returnToNeedsMe(): void {
    this.view = "NEEDS_ME";
    this.selected = Math.min(this.selected, Math.max(0, this.snapshot.items.length - 1));
    this.detailPage = 0;
    this.normalizeAction();
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
    if (this.view !== "NEEDS_ME" || !this.snapshot.items.some((candidate) => candidate.id === item.id)) {
      throw new Error("mutating actions are only available in NEEDS ME");
    }
    if (!this.actions(item).includes(actionName)) throw new Error("action is not available for this item");
    if (actionName === "approve" || actionName === "deny") {
      await this.providerAction(item, actionName, randomUUID());
    } else {
      await this.client.action(item.id, actionName, item.version, actionName === "snooze" ? this.snooze.durationMs() : undefined);
    }
    await this.refresh();
  }
}

const store = new AttentionStore();
let surface: SurfaceCoordinator;
const codexAdapter = new CodexAttentionAdapter(store, {
  onError: (error) => {
    recordStartupFailure(error);
    surface.providerState = "offline";
    void surface.refresh();
  },
});
let broker: BrokerHandle | undefined;
try {
  broker = await startBroker({ store });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
}

surface = new SurfaceCoordinator(
  new BrokerClient(),
  (item, name, attemptId) => codexAdapter.execute(item, name, attemptId),
);
type HeldAction = { startedAt: number; itemId: string; version: number; action: "approve" | "deny" };
type HeldSnooze = { itemId: string; version: number; rotated: boolean };
const heldKeys = new Map<string, HeldAction>();
const heldDials = new Map<string, HeldAction>();
const heldSnoozeDials = new Map<string, HeldSnooze>();
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
      if (surface.viewItems[coordinates.column]) {
        surface.selected = coordinates.column;
        surface.normalizeAction();
      }
    } else if (coordinates.row === 1 && coordinates.column === 1 && surface.view === "NEEDS_ME" && surface.item?.available_actions?.includes("approve")) {
      this.capture(event.action.id, "approve");
      return;
    } else if (coordinates.row === 1 && coordinates.column === 2) {
      if (surface.view !== "NEEDS_ME") return;
      if (surface.item?.available_actions?.includes("deny")) {
        this.capture(event.action.id, "deny");
        return;
      }
      if (!surface.item?.available_actions && surface.item) await this.execute(event.action, "dismiss");
      return;
    } else if (coordinates.row === 1 && coordinates.column === 3) {
      if (surface.view !== "NEEDS_ME") return;
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
    if (surface.view !== "NEEDS_ME" || !item || item.action_status !== "ready") return;
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
        const item = surface.viewItems[coordinates.column];
        image = item
          ? keyCard(item, coordinates.column === surface.selected, now, surface.view)
          : idleKey(
              surface.viewItems.length === 0 && coordinates.column === 0,
              surface.providerState,
              surface.view === "ACTIVE" ? "NO ACTIVE" : surface.view === "RECENT" ? "NO RECENT" : "ALL CLEAR",
            );
      } else {
        const item = surface.item;
        const canMutate = surface.view === "NEEDS_ME";
        if (coordinates.column === 0) image = actionKey("OPEN", Boolean(item?.locator));
        else if (coordinates.column === 1) image = actionKey("APPROVE", canMutate && Boolean(item?.available_actions?.includes("approve")), "#75b798");
        else if (coordinates.column === 2) {
          const providerDeny = canMutate && Boolean(item?.available_actions?.includes("deny"));
          const genericDismiss = canMutate && Boolean(item && !item.available_actions);
          image = actionKey(providerDeny ? "DENY" : "DISMISS", providerDeny || genericDismiss, providerDeny ? "#ef6f6c" : "#7e8b96");
        } else {
          const canSnooze = canMutate && Boolean(item && (!item.available_actions || item.available_actions.includes("snooze")));
          image = actionKey("SNOOZE", canSnooze, "#58c4dd", surface.snooze.keyLabel);
        }
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
    else if (column === 2) {
      if (event.payload.pressed && surface.selectedAction === "snooze") {
        surface.rotateSnooze(event.payload.ticks);
        const held = heldSnoozeDials.get(event.action.id);
        if (held) held.rotated = true;
      } else surface.rotateAction(event.payload.ticks);
    } else if (column === 3) surface.rotateView(event.payload.ticks);
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
      } else if (surface.selectedAction === "snooze") {
        const item = surface.item;
        if (surface.view === "NEEDS_ME" && item && surface.actions(item).includes("snooze")) {
          heldSnoozeDials.set(event.action.id, { itemId: item.id, version: item.version, rotated: false });
        }
      } else await this.execute(event.action, surface.selectedAction);
    } else if (column === 3) surface.returnToNeedsMe();
    await Promise.all([keyAction.render(), this.render()]);
  }

  override async onDialUp(event: DialUpEvent): Promise<void> {
    const snooze = heldSnoozeDials.get(event.action.id);
    heldSnoozeDials.delete(event.action.id);
    if (snooze) {
      if (!snooze.rotated) await this.execute(event.action, "snooze", { id: snooze.itemId, version: snooze.version });
      return;
    }
    const held = heldDials.get(event.action.id);
    heldDials.delete(event.action.id);
    if (!held || Date.now() - held.startedAt < HOLD_MS) return;
    await this.execute(event.action, held.action, { id: held.itemId, version: held.version });
  }

  override async onTouchTap(event: TouchTapEvent): Promise<void> {
    const column = event.action.coordinates.column;
    if (column === 0 && surface.item?.locator) await streamDeck.system.openUrl(surface.item.locator.target);
  }

  async execute(source: DialAction, actionName: AttentionAction, captured?: { id: string; version: number }): Promise<void> {
    try {
      await surface.executeAction(actionName, captured);
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
        eyebrow = `${surface.view.replace("_", " ")} · ${surface.selected + 1}/${surface.viewItems.length}`;
        primary = item.project;
        const count = occurrenceCount(item);
        const state = surface.view === "RECENT" ? (recentOutcomeLabel(item) ?? item.state) : item.state;
        secondary = `${item.source.toUpperCase()} · ${item.freshness === "stale" ? "STALE" : state}${count && count > 1 ? ` · ×${count}` : ""}`;
      } else if (item && column === 1) {
        eyebrow = "WHY";
        const start = surface.detailPage * 34;
        primary = item.summary.slice(start, start + 34) || item.summary.slice(0, 34);
        const outcome = surface.view === "RECENT" ? recentOutcomeLabel(item) : undefined;
        secondary = outcome ? `${item.title} · ${outcome}` : item.title;
      } else if (item && column === 2) {
        const providerAction = surface.selectedAction === "approve" || surface.selectedAction === "deny";
        const canMutate = surface.view === "NEEDS_ME";
        eyebrow = canMutate ? (providerAction ? "ACTION · HOLD 0.75S" : "ACTION") : "ACTIONS LOCKED";
        primary = canMutate ? `${providerAction ? "HOLD " : ""}${surface.selectedAction.toUpperCase()}` : "OPEN ONLY";
        secondary = item.action_status === "sending"
          ? "SENDING"
          : surface.selectedAction === "snooze"
            ? `${surface.snooze.label} · HOLD+TURN`
            : providerAction
              ? "EXACT CODEX REQUEST"
              : "RESOLVE LOCALLY";
      } else if (column === 3) {
        eyebrow = "VIEW · TURN · PRESS HOME";
        primary = surface.view.replace("_", " ");
        secondary = `N ${surface.count("NEEDS_ME")} · A ${surface.count("ACTIVE")} · R ${surface.count("RECENT")}`;
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
