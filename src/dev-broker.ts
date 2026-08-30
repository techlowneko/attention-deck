import { startBroker } from "./broker.js";

const broker = await startBroker();
console.log(`Attention Deck broker listening on http://${broker.host}:${broker.port}`);
console.log("Authentication token is stored in the current user's local application data directory.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await broker.close();
    process.exit(0);
  });
}
