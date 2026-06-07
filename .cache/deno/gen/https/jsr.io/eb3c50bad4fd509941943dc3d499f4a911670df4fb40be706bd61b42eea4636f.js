// Copyright 2018-2026 the Deno authors. MIT license.
// Copyright the Browserify authors. MIT License.
// Ported mostly from https://github.com/browserify/path-browserify/
// This module is browser compatible.
/**
 * Utilities for working with OS-specific file paths.
 *
 * Functions from this module will automatically switch to support the path style
 * of the current OS, either `windows` for Microsoft Windows, or `posix` for
 * every other operating system, eg. Linux, MacOS, BSD etc.
 *
 * To use functions for a specific path style regardless of the current OS
 * import the modules from the platform sub directory instead.
 *
 * ## Basic Path Operations
 *
 * ```ts
 * import * as path from "@std/path";
 * import { assertEquals } from "@std/assert";
 *
 * // Get components of a path
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.basename("C:\\Users\\user\\file.txt"), "file.txt");
 *   assertEquals(path.dirname("C:\\Users\\user\\file.txt"), "C:\\Users\\user");
 *   assertEquals(path.extname("C:\\Users\\user\\file.txt"), ".txt");
 * } else {
 *   assertEquals(path.basename("/home/user/file.txt"), "file.txt");
 *   assertEquals(path.dirname("/home/user/file.txt"), "/home/user");
 *   assertEquals(path.extname("/home/user/file.txt"), ".txt");
 * }
 *
 * // Join path segments
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.join("C:\\", "Users", "docs", "file.txt"), "C:\\Users\\docs\\file.txt");
 * } else {
 *   assertEquals(path.join("/home", "user", "docs", "file.txt"), "/home/user/docs/file.txt");
 * }
 *
 * // Normalize a path
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.normalize("C:\\Users\\user\\..\\temp\\.\\file.txt"), "C:\\Users\\temp\\file.txt");
 * } else {
 *   assertEquals(path.normalize("/home/user/../temp/./file.txt"), "/home/temp/file.txt");
 * }
 *
 * // Resolve absolute path
 * if (Deno.build.os === "windows") {
 *   const resolved = path.resolve("C:\\foo", "docs", "file.txt");
 *   assertEquals(resolved, "C:\\foo\\docs\\file.txt");
 *   assertEquals(path.isAbsolute(resolved), true);
 * } else {
 *   const resolved = path.resolve("/foo", "docs", "file.txt");
 *   assertEquals(resolved, "/foo/docs/file.txt");
 *   assertEquals(path.isAbsolute(resolved), true);
 * }
 *
 * // Get relative path
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.relative("C:\\Users", "C:\\Users\\docs\\file.txt"), "docs\\file.txt");
 *   assertEquals(path.relative("C:\\Users", "D:\\Programs"), "D:\\Programs");
 * } else {
 *   assertEquals(path.relative("/home/user", "/home/user/docs/file.txt"), "docs/file.txt");
 *   assertEquals(path.relative("/home/user", "/var/data"), "../../var/data");
 * }
 * ```
 *
 * ## Path Parsing and Formatting
 *
 * ```ts
 * import * as path from "@std/path";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   const parsedWindows = path.parse("C:\\Users\\user\\file.txt");
 *   assertEquals(parsedWindows.root, "C:\\");
 *   assertEquals(parsedWindows.dir, "C:\\Users\\user");
 *   assertEquals(parsedWindows.base, "file.txt");
 *   assertEquals(parsedWindows.ext, ".txt");
 *   assertEquals(parsedWindows.name, "file");
 *
 *   // Format path from components (Windows)
 *   assertEquals(
 *     path.format({ dir: "C:\\Users\\user", base: "file.txt" }),
 *     "C:\\Users\\user\\file.txt"
 *   );
 * } else {
 *   const parsedPosix = path.parse("/home/user/file.txt");
 *   assertEquals(parsedPosix.root, "/");
 *   assertEquals(parsedPosix.dir, "/home/user");
 *   assertEquals(parsedPosix.base, "file.txt");
 *   assertEquals(parsedPosix.ext, ".txt");
 *   assertEquals(parsedPosix.name, "file");
 *
 *   // Format path from components (POSIX)
 *   assertEquals(
 *     path.format({ dir: "/home/user", base: "file.txt" }),
 *     "/home/user/file.txt"
 *   );
 * }
 * ```
 *
 * ## URL Conversion
 *
 * ```ts
 * import * as path from "@std/path";
 * import { assertEquals } from "@std/assert";
 *
 * // Convert between file URLs and paths
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.fromFileUrl("file:///C:/Users/user/file.txt"), "C:\\Users\\user\\file.txt");
 *   assertEquals(path.toFileUrl("C:\\Users\\user\\file.txt").href, "file:///C:/Users/user/file.txt");
 * } else {
 *   assertEquals(path.fromFileUrl("file:///home/user/file.txt"), "/home/user/file.txt");
 *   assertEquals(path.toFileUrl("/home/user/file.txt").href, "file:///home/user/file.txt");
 * }
 * ```
 *
 * ## Path Properties
 *
 * ```ts
 * import * as path from "@std/path";
 * import { assertEquals } from "@std/assert";
 *
 * // Check if path is absolute
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.isAbsolute("C:\\Users"), true);
 *   assertEquals(path.isAbsolute("\\\\Server\\share"), true);
 *   assertEquals(path.isAbsolute("C:relative\\path"), false);
 *   assertEquals(path.isAbsolute("..\\relative\\path"), false);
 * } else {
 *   assertEquals(path.isAbsolute("/home/user"), true);
 *   assertEquals(path.isAbsolute("./relative/path"), false);
 *   assertEquals(path.isAbsolute("../relative/path"), false);
 * }
 *
 * // Convert to namespaced path (Windows-specific)
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.toNamespacedPath("C:\\Users\\file.txt"), "\\\\?\\C:\\Users\\file.txt");
 *   assertEquals(path.toNamespacedPath("\\\\server\\share\\file.txt"), "\\\\?\\UNC\\server\\share\\file.txt");
 * } else {
 *   // On POSIX, toNamespacedPath returns the path unchanged
 *   assertEquals(path.toNamespacedPath("/home/user/file.txt"), "/home/user/file.txt");
 * }
 * ```
 *
 * ## Glob Pattern Utilities
 *
 * ```ts
 * import * as path from "@std/path";
 * import { assertEquals } from "@std/assert";
 *
 * // Check if a string is a glob pattern
 * assertEquals(path.isGlob("*.txt"), true);
 *
 * // Convert glob pattern to RegExp
 * const pattern = path.globToRegExp("*.txt");
 * assertEquals(pattern.test("file.txt"), true);
 *
 * // Join multiple glob patterns
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.joinGlobs(["src", "**\\*.ts"]), "src\\**\\*.ts");
 * } else {
 *   assertEquals(path.joinGlobs(["src", "**\/*.ts"]), "src/**\/*.ts");
 * }
 *
 * // Normalize a glob pattern
 * if (Deno.build.os === "windows") {
 *   assertEquals(path.normalizeGlob("src\\..\\**\\*.ts"), "**\\*.ts");
 * } else {
 *   assertEquals(path.normalizeGlob("src/../**\/*.ts"), "**\/*.ts");
 * }
 * ```
 *
 * For POSIX-specific functions:
 *
 * ```ts
 * import { fromFileUrl } from "@std/path/posix/from-file-url";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(fromFileUrl("file:///home/foo"), "/home/foo");
 * ```
 *
 * For Windows-specific functions:
 *
 * ```ts
 * import { fromFileUrl } from "@std/path/windows/from-file-url";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(fromFileUrl("file:///home/foo"), "\\home\\foo");
 * ```
 *
 * Functions for working with URLs can be found in
 * {@link ./doc/posix/~ | @std/path/posix}.
 *
 * @module
 */ export * from "./basename.ts";
export * from "./constants.ts";
export * from "./dirname.ts";
export * from "./extname.ts";
export * from "./format.ts";
export * from "./from_file_url.ts";
export * from "./is_absolute.ts";
export * from "./join.ts";
export * from "./normalize.ts";
export * from "./parse.ts";
export * from "./relative.ts";
export * from "./resolve.ts";
export * from "./to_file_url.ts";
export * from "./to_namespaced_path.ts";
export * from "./common.ts";
export * from "./types.ts";
export * from "./glob_to_regexp.ts";
export * from "./is_glob.ts";
export * from "./join_globs.ts";
export * from "./normalize_glob.ts";
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9tb2QudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIENvcHlyaWdodCB0aGUgQnJvd3NlcmlmeSBhdXRob3JzLiBNSVQgTGljZW5zZS5cbi8vIFBvcnRlZCBtb3N0bHkgZnJvbSBodHRwczovL2dpdGh1Yi5jb20vYnJvd3NlcmlmeS9wYXRoLWJyb3dzZXJpZnkvXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbi8qKlxuICogVXRpbGl0aWVzIGZvciB3b3JraW5nIHdpdGggT1Mtc3BlY2lmaWMgZmlsZSBwYXRocy5cbiAqXG4gKiBGdW5jdGlvbnMgZnJvbSB0aGlzIG1vZHVsZSB3aWxsIGF1dG9tYXRpY2FsbHkgc3dpdGNoIHRvIHN1cHBvcnQgdGhlIHBhdGggc3R5bGVcbiAqIG9mIHRoZSBjdXJyZW50IE9TLCBlaXRoZXIgYHdpbmRvd3NgIGZvciBNaWNyb3NvZnQgV2luZG93cywgb3IgYHBvc2l4YCBmb3JcbiAqIGV2ZXJ5IG90aGVyIG9wZXJhdGluZyBzeXN0ZW0sIGVnLiBMaW51eCwgTWFjT1MsIEJTRCBldGMuXG4gKlxuICogVG8gdXNlIGZ1bmN0aW9ucyBmb3IgYSBzcGVjaWZpYyBwYXRoIHN0eWxlIHJlZ2FyZGxlc3Mgb2YgdGhlIGN1cnJlbnQgT1NcbiAqIGltcG9ydCB0aGUgbW9kdWxlcyBmcm9tIHRoZSBwbGF0Zm9ybSBzdWIgZGlyZWN0b3J5IGluc3RlYWQuXG4gKlxuICogIyMgQmFzaWMgUGF0aCBPcGVyYXRpb25zXG4gKlxuICogYGBgdHNcbiAqIGltcG9ydCAqIGFzIHBhdGggZnJvbSBcIkBzdGQvcGF0aFwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogLy8gR2V0IGNvbXBvbmVudHMgb2YgYSBwYXRoXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguYmFzZW5hbWUoXCJDOlxcXFxVc2Vyc1xcXFx1c2VyXFxcXGZpbGUudHh0XCIpLCBcImZpbGUudHh0XCIpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5kaXJuYW1lKFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFxmaWxlLnR4dFwiKSwgXCJDOlxcXFxVc2Vyc1xcXFx1c2VyXCIpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5leHRuYW1lKFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFxmaWxlLnR4dFwiKSwgXCIudHh0XCIpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguYmFzZW5hbWUoXCIvaG9tZS91c2VyL2ZpbGUudHh0XCIpLCBcImZpbGUudHh0XCIpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5kaXJuYW1lKFwiL2hvbWUvdXNlci9maWxlLnR4dFwiKSwgXCIvaG9tZS91c2VyXCIpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5leHRuYW1lKFwiL2hvbWUvdXNlci9maWxlLnR4dFwiKSwgXCIudHh0XCIpO1xuICogfVxuICpcbiAqIC8vIEpvaW4gcGF0aCBzZWdtZW50c1xuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLmpvaW4oXCJDOlxcXFxcIiwgXCJVc2Vyc1wiLCBcImRvY3NcIiwgXCJmaWxlLnR4dFwiKSwgXCJDOlxcXFxVc2Vyc1xcXFxkb2NzXFxcXGZpbGUudHh0XCIpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguam9pbihcIi9ob21lXCIsIFwidXNlclwiLCBcImRvY3NcIiwgXCJmaWxlLnR4dFwiKSwgXCIvaG9tZS91c2VyL2RvY3MvZmlsZS50eHRcIik7XG4gKiB9XG4gKlxuICogLy8gTm9ybWFsaXplIGEgcGF0aFxuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLm5vcm1hbGl6ZShcIkM6XFxcXFVzZXJzXFxcXHVzZXJcXFxcLi5cXFxcdGVtcFxcXFwuXFxcXGZpbGUudHh0XCIpLCBcIkM6XFxcXFVzZXJzXFxcXHRlbXBcXFxcZmlsZS50eHRcIik7XG4gKiB9IGVsc2Uge1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5ub3JtYWxpemUoXCIvaG9tZS91c2VyLy4uL3RlbXAvLi9maWxlLnR4dFwiKSwgXCIvaG9tZS90ZW1wL2ZpbGUudHh0XCIpO1xuICogfVxuICpcbiAqIC8vIFJlc29sdmUgYWJzb2x1dGUgcGF0aFxuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGNvbnN0IHJlc29sdmVkID0gcGF0aC5yZXNvbHZlKFwiQzpcXFxcZm9vXCIsIFwiZG9jc1wiLCBcImZpbGUudHh0XCIpO1xuICogICBhc3NlcnRFcXVhbHMocmVzb2x2ZWQsIFwiQzpcXFxcZm9vXFxcXGRvY3NcXFxcZmlsZS50eHRcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLmlzQWJzb2x1dGUocmVzb2x2ZWQpLCB0cnVlKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGNvbnN0IHJlc29sdmVkID0gcGF0aC5yZXNvbHZlKFwiL2Zvb1wiLCBcImRvY3NcIiwgXCJmaWxlLnR4dFwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHJlc29sdmVkLCBcIi9mb28vZG9jcy9maWxlLnR4dFwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguaXNBYnNvbHV0ZShyZXNvbHZlZCksIHRydWUpO1xuICogfVxuICpcbiAqIC8vIEdldCByZWxhdGl2ZSBwYXRoXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgucmVsYXRpdmUoXCJDOlxcXFxVc2Vyc1wiLCBcIkM6XFxcXFVzZXJzXFxcXGRvY3NcXFxcZmlsZS50eHRcIiksIFwiZG9jc1xcXFxmaWxlLnR4dFwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgucmVsYXRpdmUoXCJDOlxcXFxVc2Vyc1wiLCBcIkQ6XFxcXFByb2dyYW1zXCIpLCBcIkQ6XFxcXFByb2dyYW1zXCIpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgucmVsYXRpdmUoXCIvaG9tZS91c2VyXCIsIFwiL2hvbWUvdXNlci9kb2NzL2ZpbGUudHh0XCIpLCBcImRvY3MvZmlsZS50eHRcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLnJlbGF0aXZlKFwiL2hvbWUvdXNlclwiLCBcIi92YXIvZGF0YVwiKSwgXCIuLi8uLi92YXIvZGF0YVwiKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqICMjIFBhdGggUGFyc2luZyBhbmQgRm9ybWF0dGluZ1xuICpcbiAqIGBgYHRzXG4gKiBpbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJAc3RkL3BhdGhcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBjb25zdCBwYXJzZWRXaW5kb3dzID0gcGF0aC5wYXJzZShcIkM6XFxcXFVzZXJzXFxcXHVzZXJcXFxcZmlsZS50eHRcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXJzZWRXaW5kb3dzLnJvb3QsIFwiQzpcXFxcXCIpO1xuICogICBhc3NlcnRFcXVhbHMocGFyc2VkV2luZG93cy5kaXIsIFwiQzpcXFxcVXNlcnNcXFxcdXNlclwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhcnNlZFdpbmRvd3MuYmFzZSwgXCJmaWxlLnR4dFwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhcnNlZFdpbmRvd3MuZXh0LCBcIi50eHRcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXJzZWRXaW5kb3dzLm5hbWUsIFwiZmlsZVwiKTtcbiAqXG4gKiAgIC8vIEZvcm1hdCBwYXRoIGZyb20gY29tcG9uZW50cyAoV2luZG93cylcbiAqICAgYXNzZXJ0RXF1YWxzKFxuICogICAgIHBhdGguZm9ybWF0KHsgZGlyOiBcIkM6XFxcXFVzZXJzXFxcXHVzZXJcIiwgYmFzZTogXCJmaWxlLnR4dFwiIH0pLFxuICogICAgIFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFxmaWxlLnR4dFwiXG4gKiAgICk7XG4gKiB9IGVsc2Uge1xuICogICBjb25zdCBwYXJzZWRQb3NpeCA9IHBhdGgucGFyc2UoXCIvaG9tZS91c2VyL2ZpbGUudHh0XCIpO1xuICogICBhc3NlcnRFcXVhbHMocGFyc2VkUG9zaXgucm9vdCwgXCIvXCIpO1xuICogICBhc3NlcnRFcXVhbHMocGFyc2VkUG9zaXguZGlyLCBcIi9ob21lL3VzZXJcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXJzZWRQb3NpeC5iYXNlLCBcImZpbGUudHh0XCIpO1xuICogICBhc3NlcnRFcXVhbHMocGFyc2VkUG9zaXguZXh0LCBcIi50eHRcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXJzZWRQb3NpeC5uYW1lLCBcImZpbGVcIik7XG4gKlxuICogICAvLyBGb3JtYXQgcGF0aCBmcm9tIGNvbXBvbmVudHMgKFBPU0lYKVxuICogICBhc3NlcnRFcXVhbHMoXG4gKiAgICAgcGF0aC5mb3JtYXQoeyBkaXI6IFwiL2hvbWUvdXNlclwiLCBiYXNlOiBcImZpbGUudHh0XCIgfSksXG4gKiAgICAgXCIvaG9tZS91c2VyL2ZpbGUudHh0XCJcbiAqICAgKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqICMjIFVSTCBDb252ZXJzaW9uXG4gKlxuICogYGBgdHNcbiAqIGltcG9ydCAqIGFzIHBhdGggZnJvbSBcIkBzdGQvcGF0aFwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogLy8gQ29udmVydCBiZXR3ZWVuIGZpbGUgVVJMcyBhbmQgcGF0aHNcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5mcm9tRmlsZVVybChcImZpbGU6Ly8vQzovVXNlcnMvdXNlci9maWxlLnR4dFwiKSwgXCJDOlxcXFxVc2Vyc1xcXFx1c2VyXFxcXGZpbGUudHh0XCIpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC50b0ZpbGVVcmwoXCJDOlxcXFxVc2Vyc1xcXFx1c2VyXFxcXGZpbGUudHh0XCIpLmhyZWYsIFwiZmlsZTovLy9DOi9Vc2Vycy91c2VyL2ZpbGUudHh0XCIpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguZnJvbUZpbGVVcmwoXCJmaWxlOi8vL2hvbWUvdXNlci9maWxlLnR4dFwiKSwgXCIvaG9tZS91c2VyL2ZpbGUudHh0XCIpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC50b0ZpbGVVcmwoXCIvaG9tZS91c2VyL2ZpbGUudHh0XCIpLmhyZWYsIFwiZmlsZTovLy9ob21lL3VzZXIvZmlsZS50eHRcIik7XG4gKiB9XG4gKiBgYGBcbiAqXG4gKiAjIyBQYXRoIFByb3BlcnRpZXNcbiAqXG4gKiBgYGB0c1xuICogaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwiQHN0ZC9wYXRoXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiAvLyBDaGVjayBpZiBwYXRoIGlzIGFic29sdXRlXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguaXNBYnNvbHV0ZShcIkM6XFxcXFVzZXJzXCIpLCB0cnVlKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguaXNBYnNvbHV0ZShcIlxcXFxcXFxcU2VydmVyXFxcXHNoYXJlXCIpLCB0cnVlKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguaXNBYnNvbHV0ZShcIkM6cmVsYXRpdmVcXFxccGF0aFwiKSwgZmFsc2UpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5pc0Fic29sdXRlKFwiLi5cXFxccmVsYXRpdmVcXFxccGF0aFwiKSwgZmFsc2UpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGguaXNBYnNvbHV0ZShcIi9ob21lL3VzZXJcIiksIHRydWUpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5pc0Fic29sdXRlKFwiLi9yZWxhdGl2ZS9wYXRoXCIpLCBmYWxzZSk7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLmlzQWJzb2x1dGUoXCIuLi9yZWxhdGl2ZS9wYXRoXCIpLCBmYWxzZSk7XG4gKiB9XG4gKlxuICogLy8gQ29udmVydCB0byBuYW1lc3BhY2VkIHBhdGggKFdpbmRvd3Mtc3BlY2lmaWMpXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgudG9OYW1lc3BhY2VkUGF0aChcIkM6XFxcXFVzZXJzXFxcXGZpbGUudHh0XCIpLCBcIlxcXFxcXFxcP1xcXFxDOlxcXFxVc2Vyc1xcXFxmaWxlLnR4dFwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgudG9OYW1lc3BhY2VkUGF0aChcIlxcXFxcXFxcc2VydmVyXFxcXHNoYXJlXFxcXGZpbGUudHh0XCIpLCBcIlxcXFxcXFxcP1xcXFxVTkNcXFxcc2VydmVyXFxcXHNoYXJlXFxcXGZpbGUudHh0XCIpO1xuICogfSBlbHNlIHtcbiAqICAgLy8gT24gUE9TSVgsIHRvTmFtZXNwYWNlZFBhdGggcmV0dXJucyB0aGUgcGF0aCB1bmNoYW5nZWRcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgudG9OYW1lc3BhY2VkUGF0aChcIi9ob21lL3VzZXIvZmlsZS50eHRcIiksIFwiL2hvbWUvdXNlci9maWxlLnR4dFwiKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqICMjIEdsb2IgUGF0dGVybiBVdGlsaXRpZXNcbiAqXG4gKiBgYGB0c1xuICogaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwiQHN0ZC9wYXRoXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiAvLyBDaGVjayBpZiBhIHN0cmluZyBpcyBhIGdsb2IgcGF0dGVyblxuICogYXNzZXJ0RXF1YWxzKHBhdGguaXNHbG9iKFwiKi50eHRcIiksIHRydWUpO1xuICpcbiAqIC8vIENvbnZlcnQgZ2xvYiBwYXR0ZXJuIHRvIFJlZ0V4cFxuICogY29uc3QgcGF0dGVybiA9IHBhdGguZ2xvYlRvUmVnRXhwKFwiKi50eHRcIik7XG4gKiBhc3NlcnRFcXVhbHMocGF0dGVybi50ZXN0KFwiZmlsZS50eHRcIiksIHRydWUpO1xuICpcbiAqIC8vIEpvaW4gbXVsdGlwbGUgZ2xvYiBwYXR0ZXJuc1xuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLmpvaW5HbG9icyhbXCJzcmNcIiwgXCIqKlxcXFwqLnRzXCJdKSwgXCJzcmNcXFxcKipcXFxcKi50c1wiKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLmpvaW5HbG9icyhbXCJzcmNcIiwgXCIqKlxcLyoudHNcIl0pLCBcInNyYy8qKlxcLyoudHNcIik7XG4gKiB9XG4gKlxuICogLy8gTm9ybWFsaXplIGEgZ2xvYiBwYXR0ZXJuXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgubm9ybWFsaXplR2xvYihcInNyY1xcXFwuLlxcXFwqKlxcXFwqLnRzXCIpLCBcIioqXFxcXCoudHNcIik7XG4gKiB9IGVsc2Uge1xuICogICBhc3NlcnRFcXVhbHMocGF0aC5ub3JtYWxpemVHbG9iKFwic3JjLy4uLyoqXFwvKi50c1wiKSwgXCIqKlxcLyoudHNcIik7XG4gKiB9XG4gKiBgYGBcbiAqXG4gKiBGb3IgUE9TSVgtc3BlY2lmaWMgZnVuY3Rpb25zOlxuICpcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBmcm9tRmlsZVVybCB9IGZyb20gXCJAc3RkL3BhdGgvcG9zaXgvZnJvbS1maWxlLXVybFwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKGZyb21GaWxlVXJsKFwiZmlsZTovLy9ob21lL2Zvb1wiKSwgXCIvaG9tZS9mb29cIik7XG4gKiBgYGBcbiAqXG4gKiBGb3IgV2luZG93cy1zcGVjaWZpYyBmdW5jdGlvbnM6XG4gKlxuICogYGBgdHNcbiAqIGltcG9ydCB7IGZyb21GaWxlVXJsIH0gZnJvbSBcIkBzdGQvcGF0aC93aW5kb3dzL2Zyb20tZmlsZS11cmxcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhmcm9tRmlsZVVybChcImZpbGU6Ly8vaG9tZS9mb29cIiksIFwiXFxcXGhvbWVcXFxcZm9vXCIpO1xuICogYGBgXG4gKlxuICogRnVuY3Rpb25zIGZvciB3b3JraW5nIHdpdGggVVJMcyBjYW4gYmUgZm91bmQgaW5cbiAqIHtAbGluayAuL2RvYy9wb3NpeC9+IHwgQHN0ZC9wYXRoL3Bvc2l4fS5cbiAqXG4gKiBAbW9kdWxlXG4gKi9cbmV4cG9ydCAqIGZyb20gXCIuL2Jhc2VuYW1lLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9jb25zdGFudHMudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2Rpcm5hbWUudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2V4dG5hbWUudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2Zvcm1hdC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vZnJvbV9maWxlX3VybC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vaXNfYWJzb2x1dGUudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL2pvaW4udHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL25vcm1hbGl6ZS50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vcGFyc2UudHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL3JlbGF0aXZlLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9yZXNvbHZlLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi90b19maWxlX3VybC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vdG9fbmFtZXNwYWNlZF9wYXRoLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9jb21tb24udHNcIjtcbmV4cG9ydCAqIGZyb20gXCIuL3R5cGVzLnRzXCI7XG5leHBvcnQgKiBmcm9tIFwiLi9nbG9iX3RvX3JlZ2V4cC50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vaXNfZ2xvYi50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vam9pbl9nbG9icy50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vbm9ybWFsaXplX2dsb2IudHNcIjtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQsaURBQWlEO0FBQ2pELG9FQUFvRTtBQUNwRSxxQ0FBcUM7QUFFckM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBK0xDLEdBQ0QsY0FBYyxnQkFBZ0I7QUFDOUIsY0FBYyxpQkFBaUI7QUFDL0IsY0FBYyxlQUFlO0FBQzdCLGNBQWMsZUFBZTtBQUM3QixjQUFjLGNBQWM7QUFDNUIsY0FBYyxxQkFBcUI7QUFDbkMsY0FBYyxtQkFBbUI7QUFDakMsY0FBYyxZQUFZO0FBQzFCLGNBQWMsaUJBQWlCO0FBQy9CLGNBQWMsYUFBYTtBQUMzQixjQUFjLGdCQUFnQjtBQUM5QixjQUFjLGVBQWU7QUFDN0IsY0FBYyxtQkFBbUI7QUFDakMsY0FBYywwQkFBMEI7QUFDeEMsY0FBYyxjQUFjO0FBQzVCLGNBQWMsYUFBYTtBQUMzQixjQUFjLHNCQUFzQjtBQUNwQyxjQUFjLGVBQWU7QUFDN0IsY0FBYyxrQkFBa0I7QUFDaEMsY0FBYyxzQkFBc0IifQ==
// denoCacheMetadata=503004396723988609,3847357021331719661