import type { AttentionItem, AttentionState } from "./protocol.js";

const COLORS: Record<AttentionState, string> = {
  APPROVAL: "#f2b84b",
  INPUT: "#58c4dd",
  FAILED: "#ef6f6c",
  REVIEW: "#a98be8",
  WORKING: "#78909c",
  DONE: "#75b798",
};

const GLYPHS: Record<AttentionState, string> = {
  APPROVAL: "LOCK",
  INPUT: "?",
  FAILED: "!",
  REVIEW: "EYE",
  WORKING: "...",
  DONE: "OK",
};

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

export function ageLabel(item: AttentionItem, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(item.first_seen_at)) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function keyCard(item: AttentionItem, selected: boolean, now = new Date()): string {
  const color = item.freshness === "stale" ? "#7f8994" : COLORS[item.state];
  const border = selected ? 6 : 3;
  const state = item.freshness === "stale" ? "STALE" : item.state;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="13" fill="#090c10"/>
    <rect x="${border / 2}" y="${border / 2}" width="${144 - border}" height="${144 - border}" rx="12" fill="none" stroke="${color}" stroke-width="${border}"/>
    <text x="13" y="23" fill="#9aa5b1" font-family="Arial,sans-serif" font-size="13" font-weight="700">${escapeXml(truncate(item.source.toUpperCase(), 12))}</text>
    <text x="131" y="23" text-anchor="end" fill="#c7d0d9" font-family="Arial,sans-serif" font-size="13">${ageLabel(item, now)}</text>
    <text x="72" y="63" text-anchor="middle" fill="${color}" font-family="Arial,sans-serif" font-size="15" font-weight="800">${GLYPHS[item.state]} ${state}</text>
    <text x="72" y="94" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="19" font-weight="700">${escapeXml(truncate(item.project, 12))}</text>
    <text x="72" y="119" text-anchor="middle" fill="#9aa5b1" font-family="Arial,sans-serif" font-size="12">${escapeXml(truncate(item.title, 18))}</text>
  </svg>`;
}

export function actionKey(label: string, enabled: boolean, accent = "#d8e0e8"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="13" fill="#090c10"/>
    <rect x="4" y="4" width="136" height="136" rx="11" fill="none" stroke="${enabled ? accent : "#242a31"}" stroke-width="3"/>
    <text x="72" y="78" text-anchor="middle" fill="${enabled ? "#f5f7fa" : "#58616b"}" font-family="Arial,sans-serif" font-size="18" font-weight="800">${escapeXml(label)}</text>
  </svg>`;
}

export function idleKey(primary: boolean, providerState: "connecting" | "connected" | "offline" = "connected"): string {
  const label = providerState === "connected" ? "ALL CLEAR" : providerState === "connecting" ? "CONNECTING" : "CODEX OFFLINE";
  return actionKey(primary ? label : "", primary, providerState === "offline" ? "#7f8994" : "#52616d");
}
