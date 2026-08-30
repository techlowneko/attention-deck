const fs = require("node:fs");
const path = require("node:path");

import("./plugin.js").catch((error) => {
  const logs = path.resolve(__dirname, "..", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const logFile = path.join(logs, "startup.log");
  try {
    if (fs.statSync(logFile).size >= 256 * 1024) return;
  } catch {
    // The first startup failure creates the file.
  }
  const profile = process.env.USERPROFILE;
  const raw = error && error.stack ? error.stack : String(error);
  const detail = raw
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(profile ? new RegExp(profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : /$^/, "[USERPROFILE]")
    .slice(0, 16 * 1024);
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${detail}\n`, "utf8");
  process.exitCode = 1;
});
