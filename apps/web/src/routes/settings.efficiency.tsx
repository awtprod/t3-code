import { createFileRoute } from "@tanstack/react-router";

import { EfficiencySettingsPanel } from "../components/settings/EfficiencySettings";

export const Route = createFileRoute("/settings/efficiency")({
  component: EfficiencySettingsPanel,
});
