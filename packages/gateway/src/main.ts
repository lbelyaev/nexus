import { startGateway } from "./start.js";

startGateway().catch((err) => {
  console.error("[nexus] Fatal error:", err);
  process.exit(1);
});
