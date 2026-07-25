import { createFileRoute } from "@tanstack/react-router";

import { DatabaseSettingsPanel } from "../components/settings/DatabaseSettings";

export const Route = createFileRoute("/settings/databases")({
  component: DatabaseSettingsPanel,
});
