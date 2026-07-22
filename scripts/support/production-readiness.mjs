export function isProductionHealthReady(health) {
  return health !== null && typeof health === "object" &&
    health.status === "ready" &&
    health.web?.status === "ready" &&
    health.application?.status === "ready" &&
    health.application?.initialized === true &&
    health.store?.status === "ready" &&
    health.store?.quickCheck === "ok" &&
    health.codex?.status === "ready" &&
    health.codex?.state === "compatible" &&
    health.codex?.authenticated === true &&
    health.codex?.protocolCompatible === true &&
    health.globalCodex?.status === "ready";
}
