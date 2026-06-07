// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { resolve as posixResolve } from "./posix/resolve.ts";
import { resolve as windowsResolve } from "./windows/resolve.ts";
/**
 * Resolves path segments into a path.
 *
 * @example Usage
 * ```ts
 * import { resolve } from "@std/path/resolve";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(resolve("C:\\foo", "bar", "baz"), "C:\\foo\\bar\\baz");
 *   assertEquals(resolve("C:\\foo", "C:\\bar", "baz"), "C:\\bar\\baz");
 * } else {
 *   assertEquals(resolve("/foo", "bar", "baz"), "/foo/bar/baz");
 *   assertEquals(resolve("/foo", "/bar", "baz"), "/bar/baz");
 * }
 * ```
 *
 * @param pathSegments Path segments to process to path.
 * @returns The resolved path.
 */ export function resolve(...pathSegments) {
  return isWindows ? windowsResolve(...pathSegments) : posixResolve(...pathSegments);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9yZXNvbHZlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB7IGlzV2luZG93cyB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjE0L29zXCI7XG5pbXBvcnQgeyByZXNvbHZlIGFzIHBvc2l4UmVzb2x2ZSB9IGZyb20gXCIuL3Bvc2l4L3Jlc29sdmUudHNcIjtcbmltcG9ydCB7IHJlc29sdmUgYXMgd2luZG93c1Jlc29sdmUgfSBmcm9tIFwiLi93aW5kb3dzL3Jlc29sdmUudHNcIjtcblxuLyoqXG4gKiBSZXNvbHZlcyBwYXRoIHNlZ21lbnRzIGludG8gYSBwYXRoLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gXCJAc3RkL3BhdGgvcmVzb2x2ZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGFzc2VydEVxdWFscyhyZXNvbHZlKFwiQzpcXFxcZm9vXCIsIFwiYmFyXCIsIFwiYmF6XCIpLCBcIkM6XFxcXGZvb1xcXFxiYXJcXFxcYmF6XCIpO1xuICogICBhc3NlcnRFcXVhbHMocmVzb2x2ZShcIkM6XFxcXGZvb1wiLCBcIkM6XFxcXGJhclwiLCBcImJhelwiKSwgXCJDOlxcXFxiYXJcXFxcYmF6XCIpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHJlc29sdmUoXCIvZm9vXCIsIFwiYmFyXCIsIFwiYmF6XCIpLCBcIi9mb28vYmFyL2JhelwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHJlc29sdmUoXCIvZm9vXCIsIFwiL2JhclwiLCBcImJhelwiKSwgXCIvYmFyL2JhelwiKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoU2VnbWVudHMgUGF0aCBzZWdtZW50cyB0byBwcm9jZXNzIHRvIHBhdGguXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmUoLi4ucGF0aFNlZ21lbnRzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBpc1dpbmRvd3NcbiAgICA/IHdpbmRvd3NSZXNvbHZlKC4uLnBhdGhTZWdtZW50cylcbiAgICA6IHBvc2l4UmVzb2x2ZSguLi5wYXRoU2VnbWVudHMpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxTQUFTLFFBQVEsK0JBQStCO0FBQ3pELFNBQVMsV0FBVyxZQUFZLFFBQVEscUJBQXFCO0FBQzdELFNBQVMsV0FBVyxjQUFjLFFBQVEsdUJBQXVCO0FBRWpFOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUJDLEdBQ0QsT0FBTyxTQUFTLFFBQVEsR0FBRyxZQUFzQjtFQUMvQyxPQUFPLFlBQ0gsa0JBQWtCLGdCQUNsQixnQkFBZ0I7QUFDdEIifQ==
// denoCacheMetadata=7979550836211385670,3877831010113765871