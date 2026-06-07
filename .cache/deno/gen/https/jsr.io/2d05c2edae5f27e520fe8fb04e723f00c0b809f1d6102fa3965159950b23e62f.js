// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { join as posixJoin } from "./posix/join.ts";
import { join as windowsJoin } from "./windows/join.ts";
/**
 * Joins a sequence of paths, then normalizes the resulting path.
 *
 * @example Usage
 * ```ts
 * import { join } from "@std/path/join";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(join("C:\\foo", "bar", "baz\\quux", "garply", ".."), "C:\\foo\\bar\\baz\\quux");
 *   assertEquals(join(new URL("file:///C:/foo"), "bar", "baz/asdf", "quux", ".."), "C:\\foo\\bar\\baz\\asdf");
 * } else {
 *   assertEquals(join("/foo", "bar", "baz/quux", "garply", ".."), "/foo/bar/baz/quux");
 *   assertEquals(join(new URL("file:///foo"), "bar", "baz/asdf", "quux", ".."), "/foo/bar/baz/asdf");
 * }
 * ```
 *
 * @param path The path to join. This can be string or file URL.
 * @param paths Paths to be joined and normalized.
 * @returns The joined and normalized path.
 */ export function join(path, ...paths) {
  return isWindows ? windowsJoin(path, ...paths) : posixJoin(path, ...paths);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9qb2luLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB7IGlzV2luZG93cyB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjE0L29zXCI7XG5pbXBvcnQgeyBqb2luIGFzIHBvc2l4Sm9pbiB9IGZyb20gXCIuL3Bvc2l4L2pvaW4udHNcIjtcbmltcG9ydCB7IGpvaW4gYXMgd2luZG93c0pvaW4gfSBmcm9tIFwiLi93aW5kb3dzL2pvaW4udHNcIjtcblxuLyoqXG4gKiBKb2lucyBhIHNlcXVlbmNlIG9mIHBhdGhzLCB0aGVuIG5vcm1hbGl6ZXMgdGhlIHJlc3VsdGluZyBwYXRoLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgam9pbiB9IGZyb20gXCJAc3RkL3BhdGgvam9pblwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGFzc2VydEVxdWFscyhqb2luKFwiQzpcXFxcZm9vXCIsIFwiYmFyXCIsIFwiYmF6XFxcXHF1dXhcIiwgXCJnYXJwbHlcIiwgXCIuLlwiKSwgXCJDOlxcXFxmb29cXFxcYmFyXFxcXGJhelxcXFxxdXV4XCIpO1xuICogICBhc3NlcnRFcXVhbHMoam9pbihuZXcgVVJMKFwiZmlsZTovLy9DOi9mb29cIiksIFwiYmFyXCIsIFwiYmF6L2FzZGZcIiwgXCJxdXV4XCIsIFwiLi5cIiksIFwiQzpcXFxcZm9vXFxcXGJhclxcXFxiYXpcXFxcYXNkZlwiKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGFzc2VydEVxdWFscyhqb2luKFwiL2Zvb1wiLCBcImJhclwiLCBcImJhei9xdXV4XCIsIFwiZ2FycGx5XCIsIFwiLi5cIiksIFwiL2Zvby9iYXIvYmF6L3F1dXhcIik7XG4gKiAgIGFzc2VydEVxdWFscyhqb2luKG5ldyBVUkwoXCJmaWxlOi8vL2Zvb1wiKSwgXCJiYXJcIiwgXCJiYXovYXNkZlwiLCBcInF1dXhcIiwgXCIuLlwiKSwgXCIvZm9vL2Jhci9iYXovYXNkZlwiKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIGpvaW4uIFRoaXMgY2FuIGJlIHN0cmluZyBvciBmaWxlIFVSTC5cbiAqIEBwYXJhbSBwYXRocyBQYXRocyB0byBiZSBqb2luZWQgYW5kIG5vcm1hbGl6ZWQuXG4gKiBAcmV0dXJucyBUaGUgam9pbmVkIGFuZCBub3JtYWxpemVkIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBqb2luKHBhdGg6IHN0cmluZyB8IFVSTCwgLi4ucGF0aHM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGlzV2luZG93cyA/IHdpbmRvd3NKb2luKHBhdGgsIC4uLnBhdGhzKSA6IHBvc2l4Sm9pbihwYXRoLCAuLi5wYXRocyk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUFTLFNBQVMsUUFBUSwrQkFBK0I7QUFDekQsU0FBUyxRQUFRLFNBQVMsUUFBUSxrQkFBa0I7QUFDcEQsU0FBUyxRQUFRLFdBQVcsUUFBUSxvQkFBb0I7QUFFeEQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBQ0QsT0FBTyxTQUFTLEtBQUssSUFBa0IsRUFBRSxHQUFHLEtBQWU7RUFDekQsT0FBTyxZQUFZLFlBQVksU0FBUyxTQUFTLFVBQVUsU0FBUztBQUN0RSJ9
// denoCacheMetadata=13174500794050381435,8864385767822293666