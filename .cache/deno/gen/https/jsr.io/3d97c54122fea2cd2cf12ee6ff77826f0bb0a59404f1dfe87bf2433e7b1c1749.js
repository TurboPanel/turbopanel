// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { common as _common } from "./_common/common.ts";
import { SEPARATOR } from "./constants.ts";
/**
 * Determines the common path from a set of paths for the given OS.
 *
 * @param paths Paths to search for common path.
 * @returns The common path.
 *
 * @example Usage
 * ```ts
 * import { common } from "@std/path/common";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   const path = common([
 *     "C:\\deno\\std\\path\\mod.ts",
 *     "C:\\deno\\std\\fs\\mod.ts"
 *   ]);
 *   assertEquals(path, "C:\\deno\\std\\");
 * } else {
 *   const path = common([
 *     "./deno/std/path/mod.ts",
 *     "./deno/std/fs/mod.ts"
 *   ]);
 *   assertEquals(path, "./deno/std/");
 * }
 * ```
 */ export function common(paths) {
  return _common(paths, SEPARATOR);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9jb21tb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgY29tbW9uIGFzIF9jb21tb24gfSBmcm9tIFwiLi9fY29tbW9uL2NvbW1vbi50c1wiO1xuaW1wb3J0IHsgU0VQQVJBVE9SIH0gZnJvbSBcIi4vY29uc3RhbnRzLnRzXCI7XG5cbi8qKlxuICogRGV0ZXJtaW5lcyB0aGUgY29tbW9uIHBhdGggZnJvbSBhIHNldCBvZiBwYXRocyBmb3IgdGhlIGdpdmVuIE9TLlxuICpcbiAqIEBwYXJhbSBwYXRocyBQYXRocyB0byBzZWFyY2ggZm9yIGNvbW1vbiBwYXRoLlxuICogQHJldHVybnMgVGhlIGNvbW1vbiBwYXRoLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgY29tbW9uIH0gZnJvbSBcIkBzdGQvcGF0aC9jb21tb25cIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBjb25zdCBwYXRoID0gY29tbW9uKFtcbiAqICAgICBcIkM6XFxcXGRlbm9cXFxcc3RkXFxcXHBhdGhcXFxcbW9kLnRzXCIsXG4gKiAgICAgXCJDOlxcXFxkZW5vXFxcXHN0ZFxcXFxmc1xcXFxtb2QudHNcIlxuICogICBdKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhdGgsIFwiQzpcXFxcZGVub1xcXFxzdGRcXFxcXCIpO1xuICogfSBlbHNlIHtcbiAqICAgY29uc3QgcGF0aCA9IGNvbW1vbihbXG4gKiAgICAgXCIuL2Rlbm8vc3RkL3BhdGgvbW9kLnRzXCIsXG4gKiAgICAgXCIuL2Rlbm8vc3RkL2ZzL21vZC50c1wiXG4gKiAgIF0pO1xuICogICBhc3NlcnRFcXVhbHMocGF0aCwgXCIuL2Rlbm8vc3RkL1wiKTtcbiAqIH1cbiAqIGBgYFxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbW9uKHBhdGhzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBfY29tbW9uKHBhdGhzLCBTRVBBUkFUT1IpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxVQUFVLE9BQU8sUUFBUSxzQkFBc0I7QUFDeEQsU0FBUyxTQUFTLFFBQVEsaUJBQWlCO0FBRTNDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBeUJDLEdBQ0QsT0FBTyxTQUFTLE9BQU8sS0FBZTtFQUNwQyxPQUFPLFFBQVEsT0FBTztBQUN4QiJ9
// denoCacheMetadata=6503126669922224411,8308219936443758605