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

type JudgeTransport = EfficiencySettings["judge"]["transport"];
const JUDGE_TRANSPORTS: ReadonlyArray<{ value: JudgeTransport; label: string }> = [
  { value: "off", label: "Off" },
  { value: "typesafe", label: "TypeSafe" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
];

type SieveMode = EfficiencySettings["sieve"]["mode"];
const SIEVE_MODES: ReadonlyArray<{ value: SieveMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "shadow", label: "Shadow (log only)" },
  { value: "active", label: "Active (rewrite)" },
];

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

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

      <SettingsSection title="Judge">
        <SettingsRow
          title="Transport"
          description="A cheap model that answers typed questions with calibrated probabilities. Off keeps every feature deterministic. TypeSafe uses System One; OpenAI-compatible posts to a /chat/completions gateway."
          control={
            <Select
              value={efficiency.judge.transport}
              onValueChange={(value) =>
                value &&
                void persist({
                  ...efficiency,
                  judge: { ...efficiency.judge, transport: value as JudgeTransport },
                })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {JUDGE_TRANSPORTS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {efficiency.judge.transport === "openai-compatible" ? (
          <SettingsRow
            title="Base URL"
            description="The OpenAI-compatible endpoint. Defaults to the local gateway when left blank."
            control={
              <Input
                className="w-72"
                placeholder="http://127.0.0.1:8317/v1"
                value={efficiency.judge.baseUrl ?? ""}
                onChange={(event) => {
                  const next = event.target.value.trim();
                  void persist({
                    ...efficiency,
                    judge: {
                      ...efficiency.judge,
                      ...(next.length === 0 ? { baseUrl: undefined } : { baseUrl: next }),
                    },
                  });
                }}
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Model"
          description="The judge model. TypeSafe uses jev-latest; the gateway default is glm-5.3-flash."
          control={
            <Input
              className="w-56"
              value={efficiency.judge.model}
              onChange={(event) => {
                const next = event.target.value.trim();
                if (next.length === 0) return;
                void persist({
                  ...efficiency,
                  judge: { ...efficiency.judge, model: next },
                });
              }}
            />
          }
        />
        <SettingsRow
          title="API key env var"
          description="The NAME of the environment variable holding the API key — never the key itself."
          control={
            <Input
              className="w-56"
              value={efficiency.judge.apiKeyEnv}
              onChange={(event) => {
                const next = event.target.value.trim();
                if (next.length === 0) return;
                void persist({
                  ...efficiency,
                  judge: { ...efficiency.judge, apiKeyEnv: next },
                });
              }}
            />
          }
        />
        <SettingsRow
          title="Confidence-gated tier judgment"
          description="Ask the judge to rate task complexity on each auto-routed turn. The tier only changes when the judge is confident enough; rules always win."
          control={
            <Switch
              checked={efficiency.tierJudgment.enabled}
              onCheckedChange={(enabled) =>
                void persist({
                  ...efficiency,
                  tierJudgment: { ...efficiency.tierJudgment, enabled },
                })
              }
            />
          }
        />
        <SettingsRow
          title="Minimum confidence"
          description="A judgment overrides the static tier only when its confidence reaches this value (0–1)."
          control={
            <Input
              aria-label="minimum confidence"
              className="w-24"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={efficiency.tierJudgment.minConfidence}
              onChange={(event) =>
                void persist({
                  ...efficiency,
                  tierJudgment: {
                    ...efficiency.tierJudgment,
                    minConfidence: clamp01(Number(event.target.value) || 0),
                  },
                })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Tool-result sieve">
        <SettingsRow
          title="Mode"
          description="Hide tool-result blocks the judge is confident the task does not need. Shadow logs decisions without changing output; Active rewrites the result. Errors and uncertain blocks are always kept."
          control={
            <Select
              value={efficiency.sieve.mode}
              onValueChange={(value) =>
                value &&
                void persist({
                  ...efficiency,
                  sieve: { ...efficiency.sieve, mode: value as SieveMode },
                })
              }
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {SIEVE_MODES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Minimum result size"
          description="Only sieve tool results at least this many characters long."
          control={
            <div className="flex items-center gap-2">
              <Input
                aria-label="minimum result size"
                className="w-28"
                type="number"
                min={1}
                value={efficiency.sieve.minChars}
                onChange={(event) =>
                  void persist({
                    ...efficiency,
                    sieve: {
                      ...efficiency.sieve,
                      minChars: Math.max(1, Math.round(Number(event.target.value) || 1)),
                    },
                  })
                }
              />
              <span className="text-xs text-muted-foreground">chars</span>
            </div>
          }
        />
        <SettingsRow
          title="Drop / keep thresholds"
          description="Hide a block when P(needed) is below Drop; keep and gate errors at or above Keep. Drop must be below Keep."
          control={
            <div className="flex items-center gap-2">
              <Input
                aria-label="drop below"
                className="w-24"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={efficiency.sieve.dropBelow}
                onChange={(event) =>
                  void persist({
                    ...efficiency,
                    sieve: {
                      ...efficiency.sieve,
                      dropBelow: clamp01(Number(event.target.value) || 0),
                    },
                  })
                }
              />
              <span className="text-xs text-muted-foreground">/</span>
              <Input
                aria-label="keep above"
                className="w-24"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={efficiency.sieve.keepAbove}
                onChange={(event) =>
                  void persist({
                    ...efficiency,
                    sieve: {
                      ...efficiency.sieve,
                      keepAbove: clamp01(Number(event.target.value) || 0),
                    },
                  })
                }
              />
            </div>
          }
        />
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
