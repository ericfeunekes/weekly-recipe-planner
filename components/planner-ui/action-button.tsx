import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { plannerActionVariants, type PlannerActionTone } from "./action-variants";

type PlannerActionButtonProps = React.ComponentProps<typeof Button> & {
  tone?: PlannerActionTone;
};

export function PlannerActionButton({
  className,
  tone = "primary",
  ...props
}: PlannerActionButtonProps) {
  const choice = plannerActionVariants[tone];
  return (
    <Button
      className={cn("planner-action-button", `planner-action-${tone}`, choice.className, className)}
      variant={choice.variant}
      {...props}
    />
  );
}

export function PlannerIconButton({
  className,
  tone = "quiet",
  ...props
}: PlannerActionButtonProps) {
  const choice = plannerActionVariants[tone];
  return (
    <Button
      className={cn(
        "planner-icon-button",
        `planner-action-${tone}`,
        choice.className,
        className,
      )}
      size="icon-lg"
      variant={choice.variant}
      {...props}
    />
  );
}
