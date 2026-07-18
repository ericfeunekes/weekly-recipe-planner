"use client";

import { PlannerActionButton } from "@/components/planner-ui/action-button";

export function OfflineAuthorityNotice({
  message = "Editing is paused until the server reconnects.",
  onReconnect,
}: {
  message?: string;
  onReconnect: () => void;
}) {
  return (
    <div className="authority-banner warning" role="status">
      <span>{message}</span>
      <PlannerActionButton tone="secondary" type="button" onClick={onReconnect}>Reconnect</PlannerActionButton>
    </div>
  );
}
