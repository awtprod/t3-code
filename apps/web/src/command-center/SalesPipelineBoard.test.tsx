import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { SalesPipelineBoard } from "./SalesPipelineBoard";

it("keeps pipeline actions clear of native desktop window controls", () => {
  const html = renderToStaticMarkup(
    <SalesPipelineBoard
      draftRequests={[]}
      onCreateDraft={vi.fn()}
      onDecideDraft={vi.fn()}
      onImport={vi.fn()}
      onRefresh={vi.fn()}
      onRequestDraft={vi.fn()}
      onStageChange={vi.fn()}
      prospects={[]}
    />,
  );

  expect(html).toContain('data-slot="sales-pipeline-header"');
  expect(html).toContain("var(--workspace-native-controls-inset)");
  expect(html).toContain('aria-label="Refresh prospects"');
  expect(html).toContain("Import ready");
});
