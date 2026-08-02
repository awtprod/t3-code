"use client";

import {
  SALES_PROSPECT_STAGES,
  type SalesDraftRequest,
  type SalesProspect,
  type SalesProspectStage,
} from "@command-center/core";
import { ArrowRightIcon, MailIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetTitle,
} from "~/components/ui/sheet";

const STAGE_LABEL: Readonly<Record<SalesProspectStage, string>> = {
  researched: "Researched",
  qualified: "Qualified",
  drafted: "Drafted",
  contacted: "Contacted",
  replied: "Replied",
  call_booked: "Call booked",
  proposal_sent: "Proposal sent",
  won: "Won",
  nurture: "Nurture",
  lost: "Lost",
};

const NEXT_STAGE: Partial<Record<SalesProspectStage, SalesProspectStage>> = {
  researched: "qualified",
  qualified: "drafted",
  drafted: "contacted",
  contacted: "replied",
  replied: "call_booked",
  call_booked: "proposal_sent",
  proposal_sent: "won",
  nurture: "qualified",
};

export interface SalesPipelineBoardProps {
  readonly prospects: ReadonlyArray<SalesProspect>;
  readonly draftRequests: ReadonlyArray<SalesDraftRequest>;
  readonly loading?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly error?: string | null | undefined;
  readonly onRefresh: () => void;
  readonly onStageChange: (prospect: SalesProspect, stage: SalesProspectStage) => void;
  readonly onRequestDraft: (prospect: SalesProspect) => Promise<SalesDraftRequest | undefined>;
  readonly onDecideDraft: (
    request: SalesDraftRequest,
    decision: "approved" | "declined",
  ) => Promise<SalesDraftRequest | undefined>;
  readonly onCreateDraft: (request: SalesDraftRequest) => Promise<SalesDraftRequest | undefined>;
}

function ProspectCard({
  prospect,
  onOpen,
}: {
  readonly prospect: SalesProspect;
  readonly onOpen: () => void;
}) {
  return (
    <button
      className="w-full rounded-xl border bg-card p-3 text-left shadow-xs transition hover:border-foreground/20 hover:bg-accent/30"
      data-slot="sales-prospect-card"
      onClick={onOpen}
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm leading-tight">{prospect.channelName}</span>
        <Badge variant={prospect.fit.score >= 80 ? "success" : "secondary"}>
          {prospect.fit.score}
        </Badge>
      </div>
      <p className="mt-2 line-clamp-2 text-muted-foreground text-xs">{prospect.niche}</p>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span>{prospect.subscriberCount?.toLocaleString() ?? "—"} subs</span>
        <span className="font-medium">$300</span>
      </div>
    </button>
  );
}

export function SalesPipelineBoard(props: SalesPipelineBoardProps) {
  const [selected, setSelected] = useState<SalesProspect>();
  const [preview, setPreview] = useState<SalesDraftRequest>();
  const grouped = useMemo(
    () =>
      new Map(
        SALES_PROSPECT_STAGES.map((stage) => [
          stage,
          props.prospects.filter((prospect) => prospect.stage === stage),
        ]),
      ),
    [props.prospects],
  );
  const current =
    selected === undefined
      ? undefined
      : (props.prospects.find((prospect) => prospect.id === selected.id) ?? selected);
  const currentPreview =
    preview ??
    (current === undefined
      ? undefined
      : props.draftRequests.find((request) => request.prospectId === current.id));

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-slot="sales-pipeline">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-4 sm:px-6">
        <div>
          <h1 className="font-heading font-semibold text-lg">Sales pipeline</h1>
          <p className="text-muted-foreground text-xs">
            {props.prospects.length} prospects · ${(props.prospects.length * 300).toLocaleString()}{" "}
            potential
          </p>
        </div>
        <Button
          aria-label="Refresh prospects"
          onClick={props.onRefresh}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon />
        </Button>
      </header>

      {props.error ? (
        <div className="border-b bg-destructive/8 px-4 py-2 text-destructive text-sm">
          {props.error}
        </div>
      ) : null}

      <div className="hidden min-h-0 flex-1 overflow-x-auto overflow-y-hidden md:block">
        <div className="flex min-h-full w-max gap-3 p-4">
          {SALES_PROSPECT_STAGES.map((stage) => (
            <section className="w-64 shrink-0" key={stage}>
              <div className="mb-3 flex items-center justify-between px-1">
                <h2 className="font-medium text-sm">{STAGE_LABEL[stage]}</h2>
                <Badge variant="outline">{grouped.get(stage)?.length ?? 0}</Badge>
              </div>
              <div className="space-y-2 rounded-2xl bg-muted/40 p-2">
                {grouped.get(stage)?.map((prospect) => (
                  <ProspectCard
                    key={prospect.id}
                    onOpen={() => setSelected(prospect)}
                    prospect={prospect}
                  />
                ))}
                {(grouped.get(stage)?.length ?? 0) === 0 ? (
                  <div className="rounded-xl border border-dashed p-5 text-center text-muted-foreground text-xs">
                    No prospects
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 md:hidden">
        <div className="space-y-5 p-3">
          {SALES_PROSPECT_STAGES.map((stage) => {
            const prospects = grouped.get(stage) ?? [];
            if (prospects.length === 0) return null;
            return (
              <section key={stage}>
                <div className="mb-2 flex items-center justify-between px-1">
                  <h2 className="font-medium text-sm">{STAGE_LABEL[stage]}</h2>
                  <Badge variant="outline">{prospects.length}</Badge>
                </div>
                <div className="space-y-2">
                  {prospects.map((prospect) => (
                    <ProspectCard
                      key={prospect.id}
                      onOpen={() => setSelected(prospect)}
                      prospect={prospect}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {!props.loading && props.prospects.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              The next research run will add prospects here.
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            setSelected(undefined);
            setPreview(undefined);
          }
        }}
        open={current !== undefined}
      >
        <SheetContent side="right">
          {current ? (
            <>
              <SheetHeader>
                <SheetTitle>{current.channelName}</SheetTitle>
                <SheetDescription>
                  {STAGE_LABEL[current.stage]} · {current.niche}
                </SheetDescription>
              </SheetHeader>
              <SheetPanel className="space-y-6">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl bg-muted/50 p-3">
                    <div className="text-muted-foreground text-xs">Fit</div>
                    <div className="font-semibold">{current.fit.score}/100</div>
                  </div>
                  <div className="rounded-xl bg-muted/50 p-3">
                    <div className="text-muted-foreground text-xs">Opportunity</div>
                    <div className="font-semibold">$300</div>
                  </div>
                </div>
                <section>
                  <h3 className="mb-2 font-medium text-sm">Thumbnail audit</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {current.fit.thumbnailAudit}
                  </p>
                </section>
                <section>
                  <h3 className="mb-2 font-medium text-sm">Public business contact</h3>
                  <p className="text-sm">{current.contactEmail ?? "No email recorded"}</p>
                  <a
                    className="text-info text-xs hover:underline"
                    href={current.contactProvenance.sourceUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    View provenance
                  </a>
                </section>
                {currentPreview ? (
                  <section
                    className="space-y-3 rounded-2xl border p-4"
                    data-slot="sales-draft-preview"
                  >
                    <h3 className="font-medium text-sm">Gmail draft approval</h3>
                    <div className="text-xs">
                      <span className="text-muted-foreground">To: </span>
                      {currentPreview.recipient}
                    </div>
                    <div className="text-xs">
                      <span className="text-muted-foreground">Subject: </span>
                      {currentPreview.subject}
                    </div>
                    <pre className="whitespace-pre-wrap rounded-xl bg-muted/50 p-3 font-sans text-xs leading-relaxed">
                      {currentPreview.body}
                    </pre>
                    {currentPreview.status === "requested" ? (
                      <div className="flex gap-2">
                        <Button
                          disabled={props.busy}
                          onClick={() => {
                            void props
                              .onDecideDraft(currentPreview, "declined")
                              .then((value) => value && setPreview(value));
                          }}
                          variant="outline"
                        >
                          Decline
                        </Button>
                        <Button
                          disabled={props.busy}
                          onClick={() => {
                            void props
                              .onDecideDraft(currentPreview, "approved")
                              .then((value) => value && setPreview(value));
                          }}
                        >
                          Approve exact draft
                        </Button>
                      </div>
                    ) : null}
                    {currentPreview.status === "approved" || currentPreview.status === "failed" ? (
                      <Button
                        disabled={props.busy}
                        onClick={() => {
                          void props
                            .onCreateDraft(currentPreview)
                            .then((value) => value && setPreview(value));
                        }}
                      >
                        <MailIcon /> Create in Gmail
                      </Button>
                    ) : null}
                    {currentPreview.status === "created" ? (
                      <Badge variant="success">Draft created — send manually in Gmail</Badge>
                    ) : null}
                  </section>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {current.stage === "qualified" ? (
                    <Button
                      disabled={props.busy}
                      onClick={() => {
                        void props
                          .onRequestDraft(current)
                          .then((value) => value && setPreview(value));
                      }}
                    >
                      <MailIcon /> Prepare outreach
                    </Button>
                  ) : null}
                  {NEXT_STAGE[current.stage] && current.stage !== "qualified" ? (
                    <Button
                      disabled={props.busy}
                      onClick={() => props.onStageChange(current, NEXT_STAGE[current.stage]!)}
                    >
                      Move to {STAGE_LABEL[NEXT_STAGE[current.stage]!]} <ArrowRightIcon />
                    </Button>
                  ) : null}
                  {current.stage !== "won" && current.stage !== "lost" ? (
                    <Button
                      disabled={props.busy}
                      onClick={() => props.onStageChange(current, "lost")}
                      variant="outline"
                    >
                      Mark lost
                    </Button>
                  ) : null}
                </div>
                {current.nextAction ? (
                  <section className="rounded-2xl bg-muted/50 p-4">
                    <h3 className="font-medium text-sm">Next action</h3>
                    <p className="mt-1 text-muted-foreground text-sm">{current.nextAction}</p>
                    {current.nextActionAt ? (
                      <p className="mt-1 text-muted-foreground text-xs">
                        {new Date(current.nextActionAt).toLocaleString()}
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </SheetPanel>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
