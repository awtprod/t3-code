import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopTitlebarClearance } from "./DesktopTitlebarClearance";

vi.mock("~/env", () => ({ isElectron: true }));

describe("DesktopTitlebarClearance", () => {
  it("renders a dedicated native titlebar surface in Electron", () => {
    expect(renderToStaticMarkup(<DesktopTitlebarClearance />)).toContain(
      'data-slot="desktop-titlebar-clearance"',
    );
  });
});
