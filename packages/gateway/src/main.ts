import { startGateway } from "./start.js";

process.on("unhandledRejection", (reason) => {
  console.error("[nexus] Unhandled rejection (suppressed):", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[nexus] Uncaught exception (suppressed):", error);
});

startGateway().catch((err) => {
  console.error("[nexus] Fatal error:", err);
  process.exit(1);
});
