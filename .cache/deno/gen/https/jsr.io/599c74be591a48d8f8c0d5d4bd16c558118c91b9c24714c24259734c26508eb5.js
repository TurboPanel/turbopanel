// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { toFileUrl as posixToFileUrl } from "./posix/to_file_url.ts";
import { toFileUrl as windowsToFileUrl } from "./windows/to_file_url.ts";
/**
 * Converts a path string to a file URL.
 *
 * @example Usage
 * ```ts
 * import { toFileUrl } from "@std/path/to-file-url";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(toFileUrl("\\home\\foo"), new URL("file:///home/foo"));
 *   assertEquals(toFileUrl("C:\\Users\\foo"), new URL("file:///C:/Users/foo"));
 *   assertEquals(toFileUrl("\\\\127.0.0.1\\home\\foo"), new URL("file://127.0.0.1/home/foo"));
 * } else {
 *   assertEquals(toFileUrl("/home/foo"), new URL("file:///home/foo"));
 * }
 * ```
 *
 * @param path Path to convert to file URL.
 * @returns The file URL equivalent to the path.
 */ export function toFileUrl(path) {
  return isWindows ? windowsToFileUrl(path) : posixToFileUrl(path);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS90b19maWxlX3VybC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBpc1dpbmRvd3MgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xNC9vc1wiO1xuaW1wb3J0IHsgdG9GaWxlVXJsIGFzIHBvc2l4VG9GaWxlVXJsIH0gZnJvbSBcIi4vcG9zaXgvdG9fZmlsZV91cmwudHNcIjtcbmltcG9ydCB7IHRvRmlsZVVybCBhcyB3aW5kb3dzVG9GaWxlVXJsIH0gZnJvbSBcIi4vd2luZG93cy90b19maWxlX3VybC50c1wiO1xuXG4vKipcbiAqIENvbnZlcnRzIGEgcGF0aCBzdHJpbmcgdG8gYSBmaWxlIFVSTC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IHRvRmlsZVVybCB9IGZyb20gXCJAc3RkL3BhdGgvdG8tZmlsZS11cmxcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBhc3NlcnRFcXVhbHModG9GaWxlVXJsKFwiXFxcXGhvbWVcXFxcZm9vXCIpLCBuZXcgVVJMKFwiZmlsZTovLy9ob21lL2Zvb1wiKSk7XG4gKiAgIGFzc2VydEVxdWFscyh0b0ZpbGVVcmwoXCJDOlxcXFxVc2Vyc1xcXFxmb29cIiksIG5ldyBVUkwoXCJmaWxlOi8vL0M6L1VzZXJzL2Zvb1wiKSk7XG4gKiAgIGFzc2VydEVxdWFscyh0b0ZpbGVVcmwoXCJcXFxcXFxcXDEyNy4wLjAuMVxcXFxob21lXFxcXGZvb1wiKSwgbmV3IFVSTChcImZpbGU6Ly8xMjcuMC4wLjEvaG9tZS9mb29cIikpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHRvRmlsZVVybChcIi9ob21lL2Zvb1wiKSwgbmV3IFVSTChcImZpbGU6Ly8vaG9tZS9mb29cIikpO1xuICogfVxuICogYGBgXG4gKlxuICogQHBhcmFtIHBhdGggUGF0aCB0byBjb252ZXJ0IHRvIGZpbGUgVVJMLlxuICogQHJldHVybnMgVGhlIGZpbGUgVVJMIGVxdWl2YWxlbnQgdG8gdGhlIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0ZpbGVVcmwocGF0aDogc3RyaW5nKTogVVJMIHtcbiAgcmV0dXJuIGlzV2luZG93cyA/IHdpbmRvd3NUb0ZpbGVVcmwocGF0aCkgOiBwb3NpeFRvRmlsZVVybChwYXRoKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTLGFBQWEsY0FBYyxRQUFRLHlCQUF5QjtBQUNyRSxTQUFTLGFBQWEsZ0JBQWdCLFFBQVEsMkJBQTJCO0FBRXpFOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUJDLEdBQ0QsT0FBTyxTQUFTLFVBQVUsSUFBWTtFQUNwQyxPQUFPLFlBQVksaUJBQWlCLFFBQVEsZUFBZTtBQUM3RCJ9
// denoCacheMetadata=14438791776785308497,5670359847365390083