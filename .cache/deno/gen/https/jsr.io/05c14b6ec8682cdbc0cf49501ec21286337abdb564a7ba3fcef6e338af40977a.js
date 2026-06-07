// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertPath } from "../_common/assert_path.ts";
import { fromFileUrl } from "./from_file_url.ts";
import { normalize } from "./normalize.ts";
/**
 * Join all given a sequence of `paths`,then normalizes the resulting path.
 *
 * @example Usage
 * ```ts
 * import { join } from "@std/path/posix/join";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(join("/foo", "bar", "baz/asdf", "quux", ".."), "/foo/bar/baz/asdf");
 * assertEquals(join(new URL("file:///foo"), "bar", "baz/asdf", "quux", ".."), "/foo/bar/baz/asdf");
 * ```
 *
 * @example Working with URLs
 * ```ts
 * import { join } from "@std/path/posix/join";
 * import { assertEquals } from "@std/assert";
 *
 * const url = new URL("https://deno.land");
 * url.pathname = join("std", "path", "mod.ts");
 * assertEquals(url.href, "https://deno.land/std/path/mod.ts");
 *
 * url.pathname = join("//std", "path/", "/mod.ts");
 * assertEquals(url.href, "https://deno.land/std/path/mod.ts");
 * ```
 *
 * @param path The path to join. This can be string or file URL.
 * @param paths The paths to join.
 * @returns The joined path.
 */ export function join(path, ...paths) {
  if (path === undefined) return ".";
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  paths = path ? [
    path,
    ...paths
  ] : paths;
  paths.forEach((path)=>assertPath(path));
  const joined = paths.filter((path)=>path.length > 0).join("/");
  return joined === "" ? "." : normalize(joined);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9qb2luLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB7IGFzc2VydFBhdGggfSBmcm9tIFwiLi4vX2NvbW1vbi9hc3NlcnRfcGF0aC50c1wiO1xuaW1wb3J0IHsgZnJvbUZpbGVVcmwgfSBmcm9tIFwiLi9mcm9tX2ZpbGVfdXJsLnRzXCI7XG5pbXBvcnQgeyBub3JtYWxpemUgfSBmcm9tIFwiLi9ub3JtYWxpemUudHNcIjtcblxuLyoqXG4gKiBKb2luIGFsbCBnaXZlbiBhIHNlcXVlbmNlIG9mIGBwYXRoc2AsdGhlbiBub3JtYWxpemVzIHRoZSByZXN1bHRpbmcgcGF0aC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGpvaW4gfSBmcm9tIFwiQHN0ZC9wYXRoL3Bvc2l4L2pvaW5cIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhqb2luKFwiL2Zvb1wiLCBcImJhclwiLCBcImJhei9hc2RmXCIsIFwicXV1eFwiLCBcIi4uXCIpLCBcIi9mb28vYmFyL2Jhei9hc2RmXCIpO1xuICogYXNzZXJ0RXF1YWxzKGpvaW4obmV3IFVSTChcImZpbGU6Ly8vZm9vXCIpLCBcImJhclwiLCBcImJhei9hc2RmXCIsIFwicXV1eFwiLCBcIi4uXCIpLCBcIi9mb28vYmFyL2Jhei9hc2RmXCIpO1xuICogYGBgXG4gKlxuICogQGV4YW1wbGUgV29ya2luZyB3aXRoIFVSTHNcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBqb2luIH0gZnJvbSBcIkBzdGQvcGF0aC9wb3NpeC9qb2luXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCB1cmwgPSBuZXcgVVJMKFwiaHR0cHM6Ly9kZW5vLmxhbmRcIik7XG4gKiB1cmwucGF0aG5hbWUgPSBqb2luKFwic3RkXCIsIFwicGF0aFwiLCBcIm1vZC50c1wiKTtcbiAqIGFzc2VydEVxdWFscyh1cmwuaHJlZiwgXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvcGF0aC9tb2QudHNcIik7XG4gKlxuICogdXJsLnBhdGhuYW1lID0gam9pbihcIi8vc3RkXCIsIFwicGF0aC9cIiwgXCIvbW9kLnRzXCIpO1xuICogYXNzZXJ0RXF1YWxzKHVybC5ocmVmLCBcImh0dHBzOi8vZGVuby5sYW5kL3N0ZC9wYXRoL21vZC50c1wiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIGpvaW4uIFRoaXMgY2FuIGJlIHN0cmluZyBvciBmaWxlIFVSTC5cbiAqIEBwYXJhbSBwYXRocyBUaGUgcGF0aHMgdG8gam9pbi5cbiAqIEByZXR1cm5zIFRoZSBqb2luZWQgcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGpvaW4ocGF0aD86IFVSTCB8IHN0cmluZywgLi4ucGF0aHM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgaWYgKHBhdGggPT09IHVuZGVmaW5lZCkgcmV0dXJuIFwiLlwiO1xuICBpZiAocGF0aCBpbnN0YW5jZW9mIFVSTCkge1xuICAgIHBhdGggPSBmcm9tRmlsZVVybChwYXRoKTtcbiAgfVxuICBwYXRocyA9IHBhdGggPyBbcGF0aCwgLi4ucGF0aHNdIDogcGF0aHM7XG4gIHBhdGhzLmZvckVhY2goKHBhdGgpID0+IGFzc2VydFBhdGgocGF0aCkpO1xuICBjb25zdCBqb2luZWQgPSBwYXRocy5maWx0ZXIoKHBhdGgpID0+IHBhdGgubGVuZ3RoID4gMCkuam9pbihcIi9cIik7XG4gIHJldHVybiBqb2luZWQgPT09IFwiXCIgPyBcIi5cIiA6IG5vcm1hbGl6ZShqb2luZWQpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxVQUFVLFFBQVEsNEJBQTRCO0FBQ3ZELFNBQVMsV0FBVyxRQUFRLHFCQUFxQjtBQUNqRCxTQUFTLFNBQVMsUUFBUSxpQkFBaUI7QUFFM0M7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E0QkMsR0FDRCxPQUFPLFNBQVMsS0FBSyxJQUFtQixFQUFFLEdBQUcsS0FBZTtFQUMxRCxJQUFJLFNBQVMsV0FBVyxPQUFPO0VBQy9CLElBQUksZ0JBQWdCLEtBQUs7SUFDdkIsT0FBTyxZQUFZO0VBQ3JCO0VBQ0EsUUFBUSxPQUFPO0lBQUM7T0FBUztHQUFNLEdBQUc7RUFDbEMsTUFBTSxPQUFPLENBQUMsQ0FBQyxPQUFTLFdBQVc7RUFDbkMsTUFBTSxTQUFTLE1BQU0sTUFBTSxDQUFDLENBQUMsT0FBUyxLQUFLLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQztFQUM1RCxPQUFPLFdBQVcsS0FBSyxNQUFNLFVBQVU7QUFDekMifQ==
// denoCacheMetadata=1563695236284240634,6562948998520109884