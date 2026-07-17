export const plannerActionVariants = {
  primary: { variant: "default", className: "rounded-sm" },
  quiet: { variant: "secondary", className: "rounded-sm" },
  attention: { variant: "destructive", className: "rounded-sm" },
} as const;

export type PlannerActionTone = keyof typeof plannerActionVariants;
