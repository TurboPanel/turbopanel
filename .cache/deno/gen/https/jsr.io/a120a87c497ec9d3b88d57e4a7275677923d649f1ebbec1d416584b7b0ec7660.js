// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { toNamespacedPath as posixToNamespacedPath } from "./posix/to_namespaced_path.ts";
import { toNamespacedPath as windowsToNamespacedPath } from "./windows/to_namespaced_path.ts";
/**
 * Resolves path to a namespace path.  This is a no-op on
 * non-windows systems.
 *
 * @example Usage
 * ```ts
 * import { toNamespacedPath } from "@std/path/to-namespaced-path";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(toNamespacedPath("C:\\foo\\bar"), "\\\\?\\C:\\foo\\bar");
 * } else {
 *   assertEquals(toNamespacedPath("/foo/bar"), "/foo/bar");
 * }
 * ```
 *
 * @param path Path to resolve to namespace.
 * @returns The resolved namespace path.
 */ export function toNamespacedPath(path) {
  return isWindows ? windowsToNamespacedPath(path) : posixToNamespacedPath(path);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS90b19uYW1lc3BhY2VkX3BhdGgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgaXNXaW5kb3dzIH0gZnJvbSBcImpzcjpAc3RkL2ludGVybmFsQF4xLjAuMTQvb3NcIjtcbmltcG9ydCB7IHRvTmFtZXNwYWNlZFBhdGggYXMgcG9zaXhUb05hbWVzcGFjZWRQYXRoIH0gZnJvbSBcIi4vcG9zaXgvdG9fbmFtZXNwYWNlZF9wYXRoLnRzXCI7XG5pbXBvcnQgeyB0b05hbWVzcGFjZWRQYXRoIGFzIHdpbmRvd3NUb05hbWVzcGFjZWRQYXRoIH0gZnJvbSBcIi4vd2luZG93cy90b19uYW1lc3BhY2VkX3BhdGgudHNcIjtcblxuLyoqXG4gKiBSZXNvbHZlcyBwYXRoIHRvIGEgbmFtZXNwYWNlIHBhdGguICBUaGlzIGlzIGEgbm8tb3Agb25cbiAqIG5vbi13aW5kb3dzIHN5c3RlbXMuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyB0b05hbWVzcGFjZWRQYXRoIH0gZnJvbSBcIkBzdGQvcGF0aC90by1uYW1lc3BhY2VkLXBhdGhcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBhc3NlcnRFcXVhbHModG9OYW1lc3BhY2VkUGF0aChcIkM6XFxcXGZvb1xcXFxiYXJcIiksIFwiXFxcXFxcXFw/XFxcXEM6XFxcXGZvb1xcXFxiYXJcIik7XG4gKiB9IGVsc2Uge1xuICogICBhc3NlcnRFcXVhbHModG9OYW1lc3BhY2VkUGF0aChcIi9mb28vYmFyXCIpLCBcIi9mb28vYmFyXCIpO1xuICogfVxuICogYGBgXG4gKlxuICogQHBhcmFtIHBhdGggUGF0aCB0byByZXNvbHZlIHRvIG5hbWVzcGFjZS5cbiAqIEByZXR1cm5zIFRoZSByZXNvbHZlZCBuYW1lc3BhY2UgcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvTmFtZXNwYWNlZFBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGlzV2luZG93c1xuICAgID8gd2luZG93c1RvTmFtZXNwYWNlZFBhdGgocGF0aClcbiAgICA6IHBvc2l4VG9OYW1lc3BhY2VkUGF0aChwYXRoKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTLG9CQUFvQixxQkFBcUIsUUFBUSxnQ0FBZ0M7QUFDMUYsU0FBUyxvQkFBb0IsdUJBQXVCLFFBQVEsa0NBQWtDO0FBRTlGOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQkMsR0FDRCxPQUFPLFNBQVMsaUJBQWlCLElBQVk7RUFDM0MsT0FBTyxZQUNILHdCQUF3QixRQUN4QixzQkFBc0I7QUFDNUIifQ==
// denoCacheMetadata=3148808566387060736,4084093016622902593