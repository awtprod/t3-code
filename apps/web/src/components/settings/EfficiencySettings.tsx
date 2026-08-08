"use client";

import { GaugeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EfficiencySettings, type EfficiencyTier } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { efficiencyPreviewEnvironment } from "../../state/efficiency";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const TIERS: ReadonlyArray<EfficiencyTier> = ["economy", "balanced", "quality"];

export function EfficiencySettingsPanel() {
  const efficiency = usePrimarySettings((settings) => settings.efficiency);
  const updateSettings = useUpdatePrimarySettings();
  const environment = usePrimaryEnvironment();
  const [json, setJson] = useState(() => JSON.stringify(efficiency, null, 2));
  useEffect(() => setJson(JSON.stringify(efficiency, null, 2)), [efficiency]);
  const previewCandidate =
    efficiency.candidates.find(
      (candidate) => candidate.enabled && candidate.tier === efficiency.defaultTier,
    ) ?? efficiency.candidates.find((candidate) => candidate.enabled);
  const previewInput = useMemo(
    () =>
      previewCandidate === undefined
        ? null
        : {
            modelSelection: {
              instanceId: previewCandidate.instanceId,
              model: previewCandidate.model,
              ...(previewCandidate.options === undefined
                ? {}
                : { options: previewCandidate.options }),
            },
            tier: efficiency.defaultTier,
            interactionMode: "default" as const,
            attachmentCount: 0,
          },
    [efficiency.defaultTier, previewCandidate],
  );
  const preview = useEnvironmentQuery(
    environment && previewInput
      ? efficiencyPreviewEnvironment({
          environmentId: environment.environmentId,
          input: previewInput,
        })
      : null,
  );

  const persist = async (next: typeof efficiency) => {
    if (!(await updateSettings({ efficiency: next }))) {
      toastManager.add({ title: "Efficiency settings were not saved", type: "error" });
      return false;
    }
    return true;
  };

  const importJson = async () => {
    try {
      const parsed = Schema.decodeUnknownSync(EfficiencySettings)(JSON.parse(json));
      if (await persist(parsed)) {
        setJson(JSON.stringify(parsed, null, 2));
        toastManager.add({ title: "Efficiency settings imported", type: "success" });
      }
    } catch (error) {
      toastManager.add({
        title: "That efficiency JSON is not valid",
        description: error instanceof Error ? error.message : String(error),
        type: "error",
      });
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Efficiency" icon={<GaugeIcon className="size-5" />}>
        <SettingsRow
          title="Automatic routing"
          description="Use deterministic tier rules to pick the smallest known model that fits each task. Existing tasks remain manual until Auto is selected."
          control={
            <Switch
              checked={efficiency.enabled}
              onCheckedChange={(enabled) => void persist({ ...efficiency, enabled })}
            />
          }
        />
        <SettingsRow
          title="Default tier"
          description="Economy prioritizes token use, Balanced raises reasoning, and Quality uses the strongest confirmed candidate."
          control={
            <Select
              value={efficiency.defaultTier}
              onValueChange={(value) =>
                value && void persist({ ...efficiency, defaultTier: value as EfficiencyTier })
              }
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {TIERS.map((tier) => (
                  <SelectItem key={tier} value={tier}>
                    {tier[0]!.toUpperCase() + tier.slice(1)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Context and tool guides">
        {TIERS.map((tier) => (
          <SettingsRow
            key={tier}
            title={tier[0]!.toUpperCase() + tier.slice(1)}
            description="Advisory thresholds only; they never interrupt a provider or compact automatically."
            control={
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`${tier} context threshold`}
                  className="w-20"
                  type="number"
                  min={1}
                  max={100}
                  value={efficiency.contextThresholds[tier]}
                  onChange={(event) =>
                    void persist({
                      ...efficiency,
                      contextThresholds: {
                        ...efficiency.contextThresholds,
                        [tier]: Math.max(1, Math.min(100, Number(event.target.value) || 1)),
                      },
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">%</span>
                <Input
                  aria-label={`${tier} tool warning`}
                  className="w-20"
                  type="number"
                  min={1}
                  value={efficiency.toolWarnings[tier]}
                  onChange={(event) =>
                    void persist({
                      ...efficiency,
                      toolWarnings: {
                        ...efficiency.toolWarnings,
                        [tier]: Math.max(1, Number(event.target.value) || 1),
                      },
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">tools</span>
              </div>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Decision preview">
        <SettingsRow
          title={`Default ${efficiency.defaultTier} route`}
          description="Resolved by the same server path used immediately before dispatch. Preview uses an interactive default-mode task with no attachments."
          control={
            <Button
              size="sm"
              variant="ghost"
              onClick={preview.refresh}
              disabled={preview.isPending}
            >
              {preview.isPending ? "Resolving…" : "Refresh"}
            </Button>
          }
        >
          <div className="px-1 pt-3 pb-3 text-sm">
            {preview.error ? (
              <div className="text-destructive">{preview.error}</div>
            ) : preview.data?.decision ? (
              <div className="grid gap-2 rounded-xl border border-border/60 bg-card/35 p-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">Effective model</div>
                  <div className="font-medium">
                    {preview.data.modelSelection.instanceId} · {preview.data.modelSelection.model}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Why</div>
                  <div className="font-medium">
                    {preview.data.decision.source}
                    {preview.data.decision.matchedRuleId
                      ? ` · ${preview.data.decision.matchedRuleId}`
                      : ""}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Context guide</div>
                  <div className="font-medium">
                    {preview.data.decision.contextThresholdPercent}%
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Tool warning</div>
                  <div className="font-medium">
                    {preview.data.decision.toolWarningThreshold} calls
                  </div>
                </div>
                {preview.data.decision.fallbackReason ? (
                  <div className="text-muted-foreground sm:col-span-2">
                    Fallback: {preview.data.decision.fallbackReason}
                  </div>
                ) : null}
              </div>
            ) : previewCandidate === undefined ? (
              <div className="text-muted-foreground">Enable at least one candidate to preview.</div>
            ) : efficiency.enabled ? (
              <div className="text-muted-foreground">No automatic decision is available.</div>
            ) : (
              <div className="text-muted-foreground">
                Enable automatic routing to resolve a preview.
              </div>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Candidates, rules, and experiments">
        <SettingsRow
          title="JSON editor"
          description="Export, tune, and re-import stable candidate IDs, provider/model mappings, metadata rules, and opt-in experiments. Unknown model strength is never guessed."
        >
          <div className="space-y-2 px-1 pt-3 pb-3">
            <Textarea
              className="min-h-80 font-mono text-xs"
              value={json}
              onChange={(event) => setJson(event.target.value)}
              spellCheck={false}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setJson(JSON.stringify(efficiency, null, 2))}>
                Export current
              </Button>
              <Button onClick={() => void importJson()}>Validate and import</Button>
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
