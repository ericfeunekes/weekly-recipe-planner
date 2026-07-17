"use client";

import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { PlannerActionButton } from "@/components/planner-ui/action-button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
          <Tooltip><TooltipTrigger asChild><PlannerActionButton aria-label="More actions" tone="quiet"><MoreHorizontal /></PlannerActionButton></TooltipTrigger><TooltipContent>More actions</TooltipContent></Tooltip>
          <DropdownMenu><DropdownMenuTrigger asChild><PlannerActionButton tone="quiet">Menu</PlannerActionButton></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuGroup><DropdownMenuItem>Move meal</DropdownMenuItem><DropdownMenuItem>Mark leftovers</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
        </div>
      </section>
      <section className="grid gap-4 md:grid-cols-2" aria-label="Overlay controls">
        <Dialog><DialogTrigger asChild><PlannerActionButton tone="quiet">Open dialog</PlannerActionButton></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Recipe note</DialogTitle><DialogDescription>Dialogs retain an accessible title and description.</DialogDescription></DialogHeader><Textarea aria-label="Recipe note" placeholder="Add a note" /><PlannerActionButton onClick={() => toast.success("Note saved")}>Save note</PlannerActionButton></DialogContent></Dialog>
        <Sheet><SheetTrigger asChild><PlannerActionButton tone="quiet">Open drawer</PlannerActionButton></SheetTrigger><SheetContent><SheetHeader><SheetTitle>Cooking context</SheetTitle><SheetDescription>Sheet behavior is provided by the maintained primitive.</SheetDescription></SheetHeader></SheetContent></Sheet>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="scroll-title">
        <h2 id="scroll-title" className="font-medium">Scrollable instruction sample</h2>
        <ScrollArea className="h-32 rounded-sm border border-border bg-card p-3"><div className="flex flex-col gap-2 text-sm">{["Gather ingredients", "Heat pan", "Add aromatics", "Simmer sauce", "Finish and serve"].map((step, index) => <p key={step}><span className="mr-2 text-muted-foreground">{index + 1}.</span>{step}</p>)}</div></ScrollArea>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="loading-title">
        <h2 id="loading-title" className="font-medium">Loading state</h2>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </section>
    </main>
  );
}
