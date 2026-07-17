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
  return <Button className={cn(choice.className, className)} variant={choice.variant} {...props} />;
}
