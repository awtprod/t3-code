import type { EfficiencyRunDecision, EfficiencyTier, ThreadRoutingMode } from "@t3tools/contracts";
import { RouteIcon } from "lucide-react";
import { memo } from "react";

import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const TIER_LABELS: Readonly<Record<EfficiencyTier, string>> = {
  economy: "Economy",
  balanced: "Balanced",
  quality: "Quality",
};

type RoutingValue = "manual" | `auto:${EfficiencyTier}`;

const OPTIONS: ReadonlyArray<{
  readonly value: RoutingValue;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "manual", label: "Manual", description: "Every turn runs the model you picked." },
  ...(["economy", "balanced", "quality"] as const).map((tier) => ({
    value: `auto:${tier}` as const,
    label: `Auto · ${TIER_LABELS[tier]}`,
    description: `Efficiency routing picks the model for each turn, starting at ${TIER_LABELS[tier].toLowerCase()}.`,
  })),
];

function routingValue(mode: ThreadRoutingMode, tier: EfficiencyTier): RoutingValue {
  return mode === "auto" ? `auto:${tier}` : "manual";
}

/**
 * The composer's efficiency routing control: manual, or auto at a starting
 * tier. Shown only while efficiency routing is enabled in settings. Picking a
 * model in the model picker switches an auto thread back to manual.
 */
export const EfficiencyRoutingControl = memo(function EfficiencyRoutingControl(props: {
  mode: ThreadRoutingMode;
  tier: EfficiencyTier;
  latestDecision: EfficiencyRunDecision | null;
  size?: "sm" | "xs";
  hidden?: boolean;
  onChange: (mode: ThreadRoutingMode, tier: EfficiencyTier) => void;
}) {
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const value = routingValue(props.mode, props.tier);
  const current = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]!;
  const decision = props.latestDecision?.decision;
  const tooltip =
    decision === undefined
      ? current.description
      : `Last routed turn: ${decision.modelSelection.model} (${TIER_LABELS[decision.tier].toLowerCase()}, ${decision.source})`;

  return (
    <>
      <ComposerControlSeparator size={size} />
      <Tooltip>
        <Select
          open={open}
          onOpenChange={setOpen}
          value={value}
          onValueChange={(next) => {
            if (next === null || next === value) return;
            if (next === "manual") {
              props.onChange("manual", props.tier);
              return;
            }
            props.onChange("auto", next.slice("auto:".length) as EfficiencyTier);
          }}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                size={size}
                aria-label="Efficiency routing"
                data-efficiency-routing={value}
              />
            }
          >
            <ComposerControlIcon icon={RouteIcon} size={size} />
            <SelectValue data-composer-control-label>{current.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
            {OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                hideIndicator
                className="min-w-64"
              >
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="font-medium text-foreground">{option.label}</span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    </>
  );
});
