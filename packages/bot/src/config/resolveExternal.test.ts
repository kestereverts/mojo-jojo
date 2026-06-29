import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { resolveExternalSpecifier } from "./resolveExternal.ts";

describe("resolveExternalSpecifier", () => {
  test("relative path resolves against the config dir as a file:// URL", () => {
    expect(resolveExternalSpecifier("./modules/karma.ts", "/etc/bot")).toBe(
      pathToFileURL("/etc/bot/modules/karma.ts").href,
    );
  });

  test("parent-relative path resolves up from the config dir", () => {
    expect(resolveExternalSpecifier("../shared/mod.ts", "/etc/bot")).toBe(
      pathToFileURL("/etc/shared/mod.ts").href,
    );
  });

  test("absolute path becomes a file:// URL (config dir ignored)", () => {
    expect(resolveExternalSpecifier("/opt/mod.ts", "/etc/bot")).toBe(pathToFileURL("/opt/mod.ts").href);
  });

  test("bare package specifiers pass through unchanged", () => {
    expect(resolveExternalSpecifier("some-pkg", "/etc/bot")).toBe("some-pkg");
    expect(resolveExternalSpecifier("@scope/pkg", "/etc/bot")).toBe("@scope/pkg");
    expect(resolveExternalSpecifier("@scope/pkg/sub", "/etc/bot")).toBe("@scope/pkg/sub");
  });

  test("Windows-style backslash paths are treated as paths, not packages", () => {
    for (const spec of [".\\mod.ts", "..\\mod.ts", "\\abs\\mod.ts"]) {
      const out = resolveExternalSpecifier(spec, "/etc/bot");
      expect(out.startsWith("file://")).toBe(true);
      expect(out).not.toBe(spec);
    }
  });
});
