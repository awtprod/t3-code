import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useMemo } from "react";

import { NewThreadDraftLanding } from "../components/NewThreadDraftLanding";
import { NewThreadLinkView } from "../components/promptLinks/NewThreadLinkView";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

// The query is read raw: the router's own search parsing turns `prompt=123` into a number.
function NewThreadLinkRoute() {
  const search = useLocation({ select: (location) => location.searchStr });
  const parsed = useMemo(() => parseNewThreadLink(search), [search]);
  // A bare `/new` (the Command Center sidebar's "New thread" entry) starts a
  // draft in the most recently active project; links carry a query.
  if (search === "" || search === "?") {
    return <NewThreadDraftLanding pathname="/new" />;
  }
  if (!parsed.ok) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Could not open the link</EmptyTitle>
            <EmptyDescription>{parsed.error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }
  return <NewThreadLinkView key={search} link={parsed.value} />;
}

export const Route = createFileRoute("/_chat/new")({
  component: NewThreadLinkRoute,
});
