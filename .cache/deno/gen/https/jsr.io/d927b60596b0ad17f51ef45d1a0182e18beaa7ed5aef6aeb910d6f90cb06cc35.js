// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { joinGlobs as posixJoinGlobs } from "./posix/join_globs.ts";
import { joinGlobs as windowsJoinGlobs } from "./windows/join_globs.ts";
/**
 * Joins a sequence of globs, then normalizes the resulting glob.
 *
 * Behaves like {@linkcode https://jsr.io/@std/path/doc/~/join | join()}, but
 * doesn't collapse `**\/..` when `globstar` is true.
 *
 * @example Usage
 * ```ts
 * import { joinGlobs } from "@std/path/join-globs";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(joinGlobs(["foo", "bar", "..", "baz"]), "foo\\baz");
 *   assertEquals(joinGlobs(["foo", "**", "bar", "..", "baz"], { globstar: true }), "foo\\**\\baz");
 * } else {
 *   assertEquals(joinGlobs(["foo", "bar", "..", "baz"]), "foo/baz");
 *   assertEquals(joinGlobs(["foo", "**", "bar", "..", "baz"], { globstar: true }), "foo/**\/baz");
 * }
 * ```
 *
 * @param globs Globs to be joined and normalized.
 * @param options Glob options.
 * @returns The joined and normalized glob string.
 */ export function joinGlobs(globs, options = {}) {
  return isWindows ? windowsJoinGlobs(globs, options) : posixJoinGlobs(globs, options);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9qb2luX2dsb2JzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB0eXBlIHsgR2xvYk9wdGlvbnMgfSBmcm9tIFwiLi9fY29tbW9uL2dsb2JfdG9fcmVnX2V4cC50c1wiO1xuaW1wb3J0IHsgaXNXaW5kb3dzIH0gZnJvbSBcImpzcjpAc3RkL2ludGVybmFsQF4xLjAuMTQvb3NcIjtcbmltcG9ydCB7IGpvaW5HbG9icyBhcyBwb3NpeEpvaW5HbG9icyB9IGZyb20gXCIuL3Bvc2l4L2pvaW5fZ2xvYnMudHNcIjtcbmltcG9ydCB7IGpvaW5HbG9icyBhcyB3aW5kb3dzSm9pbkdsb2JzIH0gZnJvbSBcIi4vd2luZG93cy9qb2luX2dsb2JzLnRzXCI7XG5cbmV4cG9ydCB0eXBlIHsgR2xvYk9wdGlvbnMgfTtcblxuLyoqXG4gKiBKb2lucyBhIHNlcXVlbmNlIG9mIGdsb2JzLCB0aGVuIG5vcm1hbGl6ZXMgdGhlIHJlc3VsdGluZyBnbG9iLlxuICpcbiAqIEJlaGF2ZXMgbGlrZSB7QGxpbmtjb2RlIGh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC9kb2Mvfi9qb2luIHwgam9pbigpfSwgYnV0XG4gKiBkb2Vzbid0IGNvbGxhcHNlIGAqKlxcLy4uYCB3aGVuIGBnbG9ic3RhcmAgaXMgdHJ1ZS5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGpvaW5HbG9icyB9IGZyb20gXCJAc3RkL3BhdGgvam9pbi1nbG9ic1wiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGFzc2VydEVxdWFscyhqb2luR2xvYnMoW1wiZm9vXCIsIFwiYmFyXCIsIFwiLi5cIiwgXCJiYXpcIl0pLCBcImZvb1xcXFxiYXpcIik7XG4gKiAgIGFzc2VydEVxdWFscyhqb2luR2xvYnMoW1wiZm9vXCIsIFwiKipcIiwgXCJiYXJcIiwgXCIuLlwiLCBcImJhelwiXSwgeyBnbG9ic3RhcjogdHJ1ZSB9KSwgXCJmb29cXFxcKipcXFxcYmF6XCIpO1xuICogfSBlbHNlIHtcbiAqICAgYXNzZXJ0RXF1YWxzKGpvaW5HbG9icyhbXCJmb29cIiwgXCJiYXJcIiwgXCIuLlwiLCBcImJhelwiXSksIFwiZm9vL2JhelwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKGpvaW5HbG9icyhbXCJmb29cIiwgXCIqKlwiLCBcImJhclwiLCBcIi4uXCIsIFwiYmF6XCJdLCB7IGdsb2JzdGFyOiB0cnVlIH0pLCBcImZvby8qKlxcL2JhelwiKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBnbG9icyBHbG9icyB0byBiZSBqb2luZWQgYW5kIG5vcm1hbGl6ZWQuXG4gKiBAcGFyYW0gb3B0aW9ucyBHbG9iIG9wdGlvbnMuXG4gKiBAcmV0dXJucyBUaGUgam9pbmVkIGFuZCBub3JtYWxpemVkIGdsb2Igc3RyaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gam9pbkdsb2JzKFxuICBnbG9iczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IEdsb2JPcHRpb25zID0ge30sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gaXNXaW5kb3dzXG4gICAgPyB3aW5kb3dzSm9pbkdsb2JzKGdsb2JzLCBvcHRpb25zKVxuICAgIDogcG9zaXhKb2luR2xvYnMoZ2xvYnMsIG9wdGlvbnMpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFHckMsU0FBUyxTQUFTLFFBQVEsK0JBQStCO0FBQ3pELFNBQVMsYUFBYSxjQUFjLFFBQVEsd0JBQXdCO0FBQ3BFLFNBQVMsYUFBYSxnQkFBZ0IsUUFBUSwwQkFBMEI7QUFJeEU7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBdUJDLEdBQ0QsT0FBTyxTQUFTLFVBQ2QsS0FBZSxFQUNmLFVBQXVCLENBQUMsQ0FBQztFQUV6QixPQUFPLFlBQ0gsaUJBQWlCLE9BQU8sV0FDeEIsZUFBZSxPQUFPO0FBQzVCIn0=
// denoCacheMetadata=6030434223733347173,10826891336222947746