export function isProductionHealthReady(health) {
  return health !== null && typeof health === "object" &&
    health.status === "ready" &&
    health.codex?.status === "ready" &&
    health.codex?.state === "ready" &&
    health.codex?.authenticated === true &&
    health.codex?.protocolCompatible === true;
}
