// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertArg } from "../_common/normalize.ts";
import { normalizeString } from "../_common/normalize_string.ts";
import { isPosixPathSeparator } from "./_util.ts";
import { fromFileUrl } from "./from_file_url.ts";
/**
 * Normalize the `path`, resolving `'..'` and `'.'` segments.
 * Note that resolving these segments does not necessarily mean that all will be eliminated.
 * A `'..'` at the top-level will be preserved, and an empty path is canonically `'.'`.
 *
 * @example Usage
 * ```ts
 * import { normalize } from "@std/path/posix/normalize";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(normalize("/foo/bar//baz/asdf/quux/.."), "/foo/bar/baz/asdf");
 * assertEquals(normalize(new URL("file:///foo/bar//baz/asdf/quux/..")), "/foo/bar/baz/asdf/");
 * ```
 *
 * @example Working with URLs
 *
 * Note: This function will remove the double slashes from a URL's scheme.
 * Hence, do not pass a full URL to this function. Instead, pass the pathname of
 * the URL.
 *
 * ```ts
 * import { normalize } from "@std/path/posix/normalize";
 * import { assertEquals } from "@std/assert";
 *
 * const url = new URL("https://deno.land");
 * url.pathname = normalize("//std//assert//.//mod.ts");
 * assertEquals(url.href, "https://deno.land/std/assert/mod.ts");
 *
 * url.pathname = normalize("std/assert/../async/retry.ts");
 * assertEquals(url.href, "https://deno.land/std/async/retry.ts");
 * ```
 *
 * @param path The path to normalize.
 * @returns The normalized path.
 */ export function normalize(path) {
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  assertArg(path);
  const isAbsolute = isPosixPathSeparator(path.charCodeAt(0));
  const trailingSeparator = isPosixPathSeparator(path.charCodeAt(path.length - 1));
  // Normalize the path
  path = normalizeString(path, !isAbsolute, "/", isPosixPathSeparator);
  if (path.length === 0 && !isAbsolute) path = ".";
  if (path.length > 0 && trailingSeparator) path += "/";
  if (isAbsolute) return `/${path}`;
  return path;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9ub3JtYWxpemUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgYXNzZXJ0QXJnIH0gZnJvbSBcIi4uL19jb21tb24vbm9ybWFsaXplLnRzXCI7XG5pbXBvcnQgeyBub3JtYWxpemVTdHJpbmcgfSBmcm9tIFwiLi4vX2NvbW1vbi9ub3JtYWxpemVfc3RyaW5nLnRzXCI7XG5pbXBvcnQgeyBpc1Bvc2l4UGF0aFNlcGFyYXRvciB9IGZyb20gXCIuL191dGlsLnRzXCI7XG5pbXBvcnQgeyBmcm9tRmlsZVVybCB9IGZyb20gXCIuL2Zyb21fZmlsZV91cmwudHNcIjtcblxuLyoqXG4gKiBOb3JtYWxpemUgdGhlIGBwYXRoYCwgcmVzb2x2aW5nIGAnLi4nYCBhbmQgYCcuJ2Agc2VnbWVudHMuXG4gKiBOb3RlIHRoYXQgcmVzb2x2aW5nIHRoZXNlIHNlZ21lbnRzIGRvZXMgbm90IG5lY2Vzc2FyaWx5IG1lYW4gdGhhdCBhbGwgd2lsbCBiZSBlbGltaW5hdGVkLlxuICogQSBgJy4uJ2AgYXQgdGhlIHRvcC1sZXZlbCB3aWxsIGJlIHByZXNlcnZlZCwgYW5kIGFuIGVtcHR5IHBhdGggaXMgY2Fub25pY2FsbHkgYCcuJ2AuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBub3JtYWxpemUgfSBmcm9tIFwiQHN0ZC9wYXRoL3Bvc2l4L25vcm1hbGl6ZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKG5vcm1hbGl6ZShcIi9mb28vYmFyLy9iYXovYXNkZi9xdXV4Ly4uXCIpLCBcIi9mb28vYmFyL2Jhei9hc2RmXCIpO1xuICogYXNzZXJ0RXF1YWxzKG5vcm1hbGl6ZShuZXcgVVJMKFwiZmlsZTovLy9mb28vYmFyLy9iYXovYXNkZi9xdXV4Ly4uXCIpKSwgXCIvZm9vL2Jhci9iYXovYXNkZi9cIik7XG4gKiBgYGBcbiAqXG4gKiBAZXhhbXBsZSBXb3JraW5nIHdpdGggVVJMc1xuICpcbiAqIE5vdGU6IFRoaXMgZnVuY3Rpb24gd2lsbCByZW1vdmUgdGhlIGRvdWJsZSBzbGFzaGVzIGZyb20gYSBVUkwncyBzY2hlbWUuXG4gKiBIZW5jZSwgZG8gbm90IHBhc3MgYSBmdWxsIFVSTCB0byB0aGlzIGZ1bmN0aW9uLiBJbnN0ZWFkLCBwYXNzIHRoZSBwYXRobmFtZSBvZlxuICogdGhlIFVSTC5cbiAqXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgbm9ybWFsaXplIH0gZnJvbSBcIkBzdGQvcGF0aC9wb3NpeC9ub3JtYWxpemVcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGNvbnN0IHVybCA9IG5ldyBVUkwoXCJodHRwczovL2Rlbm8ubGFuZFwiKTtcbiAqIHVybC5wYXRobmFtZSA9IG5vcm1hbGl6ZShcIi8vc3RkLy9hc3NlcnQvLy4vL21vZC50c1wiKTtcbiAqIGFzc2VydEVxdWFscyh1cmwuaHJlZiwgXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvYXNzZXJ0L21vZC50c1wiKTtcbiAqXG4gKiB1cmwucGF0aG5hbWUgPSBub3JtYWxpemUoXCJzdGQvYXNzZXJ0Ly4uL2FzeW5jL3JldHJ5LnRzXCIpO1xuICogYXNzZXJ0RXF1YWxzKHVybC5ocmVmLCBcImh0dHBzOi8vZGVuby5sYW5kL3N0ZC9hc3luYy9yZXRyeS50c1wiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIG5vcm1hbGl6ZS5cbiAqIEByZXR1cm5zIFRoZSBub3JtYWxpemVkIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemUocGF0aDogc3RyaW5nIHwgVVJMKTogc3RyaW5nIHtcbiAgaWYgKHBhdGggaW5zdGFuY2VvZiBVUkwpIHtcbiAgICBwYXRoID0gZnJvbUZpbGVVcmwocGF0aCk7XG4gIH1cbiAgYXNzZXJ0QXJnKHBhdGgpO1xuXG4gIGNvbnN0IGlzQWJzb2x1dGUgPSBpc1Bvc2l4UGF0aFNlcGFyYXRvcihwYXRoLmNoYXJDb2RlQXQoMCkpO1xuICBjb25zdCB0cmFpbGluZ1NlcGFyYXRvciA9IGlzUG9zaXhQYXRoU2VwYXJhdG9yKFxuICAgIHBhdGguY2hhckNvZGVBdChwYXRoLmxlbmd0aCAtIDEpLFxuICApO1xuXG4gIC8vIE5vcm1hbGl6ZSB0aGUgcGF0aFxuICBwYXRoID0gbm9ybWFsaXplU3RyaW5nKHBhdGgsICFpc0Fic29sdXRlLCBcIi9cIiwgaXNQb3NpeFBhdGhTZXBhcmF0b3IpO1xuXG4gIGlmIChwYXRoLmxlbmd0aCA9PT0gMCAmJiAhaXNBYnNvbHV0ZSkgcGF0aCA9IFwiLlwiO1xuICBpZiAocGF0aC5sZW5ndGggPiAwICYmIHRyYWlsaW5nU2VwYXJhdG9yKSBwYXRoICs9IFwiL1wiO1xuXG4gIGlmIChpc0Fic29sdXRlKSByZXR1cm4gYC8ke3BhdGh9YDtcbiAgcmV0dXJuIHBhdGg7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUFTLFNBQVMsUUFBUSwwQkFBMEI7QUFDcEQsU0FBUyxlQUFlLFFBQVEsaUNBQWlDO0FBQ2pFLFNBQVMsb0JBQW9CLFFBQVEsYUFBYTtBQUNsRCxTQUFTLFdBQVcsUUFBUSxxQkFBcUI7QUFFakQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQ0MsR0FDRCxPQUFPLFNBQVMsVUFBVSxJQUFrQjtFQUMxQyxJQUFJLGdCQUFnQixLQUFLO0lBQ3ZCLE9BQU8sWUFBWTtFQUNyQjtFQUNBLFVBQVU7RUFFVixNQUFNLGFBQWEscUJBQXFCLEtBQUssVUFBVSxDQUFDO0VBQ3hELE1BQU0sb0JBQW9CLHFCQUN4QixLQUFLLFVBQVUsQ0FBQyxLQUFLLE1BQU0sR0FBRztFQUdoQyxxQkFBcUI7RUFDckIsT0FBTyxnQkFBZ0IsTUFBTSxDQUFDLFlBQVksS0FBSztFQUUvQyxJQUFJLEtBQUssTUFBTSxLQUFLLEtBQUssQ0FBQyxZQUFZLE9BQU87RUFDN0MsSUFBSSxLQUFLLE1BQU0sR0FBRyxLQUFLLG1CQUFtQixRQUFRO0VBRWxELElBQUksWUFBWSxPQUFPLENBQUMsQ0FBQyxFQUFFLE1BQU07RUFDakMsT0FBTztBQUNUIn0=
// denoCacheMetadata=6527179021017909709,10191598978113819699