export const plannerActionVariants = {
  primary: { variant: "default", className: "min-h-11 rounded-sm" },
  secondary: { variant: "outline", className: "min-h-11 rounded-sm" },
  quiet: { variant: "ghost", className: "min-h-11 rounded-sm" },
  attention: { variant: "destructive", className: "min-h-11 rounded-sm" },
} as const;

export type PlannerActionTone = keyof typeof plannerActionVariants;
