import { describe, expect, it } from "vite-plus/test";

import { faviconUrlForOrigin } from "./favicon";

describe("faviconUrlForOrigin", () => {
  it("never sends private origin hostnames to the public provider", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1:3000/",
      "http://0.0.0.0:3000/",
      "http://devbox.example.test:3000/",
      "https://preview.example.test/",
      "http://printer.example.test/",
      "http://192.0.2.20:3000/",
      "http://[::]/",
      "http://[::ffff:192.0.2.20]/",
      "http://198.51.100.100:3000/",
      "https://devbox.example.test/",
      "http://192.0.2.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://240.0.0.1/",
      "http://[2001:db8::1]/",
      "http://[ff02::1]/",
      "http://app.test../",
      "https://preview.example.test../",
      "http://printer.example.test../",
      "https://devbox.example.test../",
      "http://127.0.0.1../",
      "http://127.1../",
      "http://10.1../",
      "http://172.16.1../",
      "http://192.168.1../",
    ]) {
      expect(faviconUrlForOrigin(url)).toBeNull();
    }
    expect(faviconUrlForOrigin("https://example.com/path", 32)).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    );
  });
});
