import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Heuristic: does the specifier denote a filesystem path (relative or absolute)
 * rather than a bare package specifier like `"some-pkg"` / `"@scope/pkg"`?
 */
function isPathSpecifier(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith(".\\") ||
    spec.startsWith("..\\") ||
    spec.startsWith("/") ||
    spec.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(spec) // Windows drive path, e.g. C:\foo
  );
}

/**
 * Resolve an `externalModules` specifier for dynamic `import()`.
 *
 * A relative `import()` would resolve against THIS module's URL, not the config
 * file — so path specifiers are made absolute against `configDir` and converted
 * to a `file://` URL. Bare package specifiers are returned unchanged for the
 * module resolver to handle.
 */
export function resolveExternalSpecifier(specifier: string, configDir: string): string {
  if (!isPathSpecifier(specifier)) return specifier;
  const absolute = path.isAbsolute(specifier) ? specifier : path.resolve(configDir, specifier);
  return pathToFileURL(absolute).href;
}
