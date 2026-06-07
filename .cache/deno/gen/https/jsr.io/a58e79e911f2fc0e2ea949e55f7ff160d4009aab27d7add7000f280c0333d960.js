// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
/**
 * Converts a path to a namespaced path. This function returns the path as is on posix.
 *
 * @example Usage
 * ```ts
 * import { toNamespacedPath } from "@std/path/posix/to-namespaced-path";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(toNamespacedPath("/home/foo"), "/home/foo");
 * ```
 *
 * @param path The path.
 * @returns The namespaced path.
 */ export function toNamespacedPath(path) {
  // Non-op on posix systems
  return path;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC90b19uYW1lc3BhY2VkX3BhdGgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuLyoqXG4gKiBDb252ZXJ0cyBhIHBhdGggdG8gYSBuYW1lc3BhY2VkIHBhdGguIFRoaXMgZnVuY3Rpb24gcmV0dXJucyB0aGUgcGF0aCBhcyBpcyBvbiBwb3NpeC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IHRvTmFtZXNwYWNlZFBhdGggfSBmcm9tIFwiQHN0ZC9wYXRoL3Bvc2l4L3RvLW5hbWVzcGFjZWQtcGF0aFwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKHRvTmFtZXNwYWNlZFBhdGgoXCIvaG9tZS9mb29cIiksIFwiL2hvbWUvZm9vXCIpO1xuICogYGBgXG4gKlxuICogQHBhcmFtIHBhdGggVGhlIHBhdGguXG4gKiBAcmV0dXJucyBUaGUgbmFtZXNwYWNlZCBwYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdG9OYW1lc3BhY2VkUGF0aChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICAvLyBOb24tb3Agb24gcG9zaXggc3lzdGVtc1xuICByZXR1cm4gcGF0aDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDOzs7Ozs7Ozs7Ozs7O0NBYUMsR0FDRCxPQUFPLFNBQVMsaUJBQWlCLElBQVk7RUFDM0MsMEJBQTBCO0VBQzFCLE9BQU87QUFDVCJ9
// denoCacheMetadata=13535912060827722251,13953918401902156403