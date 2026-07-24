import { DatabaseZapIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const DATABASE_PROVIDERS = [
  {
    id: "supabase",
    label: "Supabase",
    description:
      "Connect a Supabase project so agents can inspect schemas, run queries, and manage migrations.",
  },
] as const;

export function DatabaseSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Database Providers">
        {DATABASE_PROVIDERS.map((provider) => (
          <div
            key={provider.id}
            className="border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                    <DatabaseZapIcon className="size-4.5 text-[#3ecf8e]" aria-hidden />
                    <span
                      className="pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full bg-muted-foreground/35 ring-2 ring-background"
                      aria-hidden
                    />
                  </span>
                  <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                    {provider.label}
                  </span>
                  <Badge variant="warning" size="sm">
                    Coming Soon
                  </Badge>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground/80">
                  {provider.description}
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground/60">
                  OAuth, project-scoped access, and read-only mode will be available here.
                </p>
              </div>
              <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                <Switch
                  checked={false}
                  disabled
                  aria-label={`${provider.label} database availability`}
                />
              </div>
            </div>
          </div>
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
