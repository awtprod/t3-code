import { createFileRoute } from "@tanstack/react-router";

import { EfficiencySettingsPanel } from "../components/settings/EfficiencySettings";

export const Route = createFileRoute("/_chat/settings/efficiency")({
  component: EfficiencySettingsPanel,
});
