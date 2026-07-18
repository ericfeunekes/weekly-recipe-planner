"use client";

import { PlannerActionButton } from "@/components/planner-ui/action-button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

export function UiFoundationFixture() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-background px-5 py-8 text-foreground">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">UI foundation fixture</p>
        <h1 className="text-3xl font-semibold tracking-tight">Household controls</h1>
        <p className="max-w-xl text-sm text-muted-foreground">An unlinked, read-only component fixture for accessibility and responsive proof.</p>
      </header>
      <Separator />
      <section className="flex flex-col gap-3" aria-labelledby="actions-title">
        <div className="flex items-center gap-2"><h2 id="actions-title" className="font-medium">Actions</h2><Badge variant="secondary">shared adapter</Badge></div>
        <div className="flex flex-wrap gap-2">
          <PlannerActionButton>Start cooking</PlannerActionButton>
          <PlannerActionButton tone="quiet">Save for later</PlannerActionButton>
          <PlannerActionButton tone="attention">End timer</PlannerActionButton>
          <PlannerActionButton disabled>Unavailable</PlannerActionButton>
        </div>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="scroll-title">
        <h2 id="scroll-title" className="font-medium">Scrollable instruction sample</h2>
        <ScrollArea aria-label="Instruction sample" className="h-32 rounded-sm border border-border bg-card p-3"><ol className="flex flex-col gap-2 text-sm">{["Gather ingredients", "Heat pan", "Add aromatics", "Simmer sauce", "Finish and serve"].map((step, index) => <li key={step}><button className="text-left underline-offset-4 hover:underline focus-visible:underline" type="button"><span className="mr-2 text-muted-foreground">{index + 1}.</span>{step}</button></li>)}</ol></ScrollArea>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="loading-title">
        <h2 id="loading-title" className="font-medium">Loading state</h2>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </section>
    </main>
  );
}
