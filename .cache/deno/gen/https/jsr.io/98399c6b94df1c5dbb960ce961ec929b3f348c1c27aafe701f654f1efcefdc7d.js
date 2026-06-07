// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { normalizeGlob as posixNormalizeGlob } from "./posix/normalize_glob.ts";
import { normalizeGlob as windowsNormalizeGlob } from "./windows/normalize_glob.ts";
/**
 * Normalizes a glob string.
 *
 * Behaves like
 * {@linkcode https://jsr.io/@std/path/doc/~/normalize | normalize()}, but
 * doesn't collapse "**\/.." when `globstar` is true.
 *
 * @example Usage
 * ```ts
 * import { normalizeGlob } from "@std/path/normalize-glob";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(normalizeGlob("foo\\bar\\..\\baz"), "foo\\baz");
 *   assertEquals(normalizeGlob("foo\\**\\..\\bar\\..\\baz", { globstar: true }), "foo\\**\\..\\baz");
 * } else {
 *   assertEquals(normalizeGlob("foo/bar/../baz"), "foo/baz");
 *   assertEquals(normalizeGlob("foo/**\/../bar/../baz", { globstar: true }), "foo/**\/../baz");
 * }
 * ```
 *
 * @param glob Glob string to normalize.
 * @param options Glob options.
 * @returns The normalized glob string.
 */ export function normalizeGlob(glob, options = {}) {
  return isWindows ? windowsNormalizeGlob(glob, options) : posixNormalizeGlob(glob, options);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9ub3JtYWxpemVfZ2xvYi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgdHlwZSB7IEdsb2JPcHRpb25zIH0gZnJvbSBcIi4vX2NvbW1vbi9nbG9iX3RvX3JlZ19leHAudHNcIjtcbmltcG9ydCB7IGlzV2luZG93cyB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjE0L29zXCI7XG5pbXBvcnQgeyBub3JtYWxpemVHbG9iIGFzIHBvc2l4Tm9ybWFsaXplR2xvYiB9IGZyb20gXCIuL3Bvc2l4L25vcm1hbGl6ZV9nbG9iLnRzXCI7XG5pbXBvcnQge1xuICBub3JtYWxpemVHbG9iIGFzIHdpbmRvd3NOb3JtYWxpemVHbG9iLFxufSBmcm9tIFwiLi93aW5kb3dzL25vcm1hbGl6ZV9nbG9iLnRzXCI7XG5cbmV4cG9ydCB0eXBlIHsgR2xvYk9wdGlvbnMgfTtcblxuLyoqXG4gKiBOb3JtYWxpemVzIGEgZ2xvYiBzdHJpbmcuXG4gKlxuICogQmVoYXZlcyBsaWtlXG4gKiB7QGxpbmtjb2RlIGh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC9kb2Mvfi9ub3JtYWxpemUgfCBub3JtYWxpemUoKX0sIGJ1dFxuICogZG9lc24ndCBjb2xsYXBzZSBcIioqXFwvLi5cIiB3aGVuIGBnbG9ic3RhcmAgaXMgdHJ1ZS5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IG5vcm1hbGl6ZUdsb2IgfSBmcm9tIFwiQHN0ZC9wYXRoL25vcm1hbGl6ZS1nbG9iXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKG5vcm1hbGl6ZUdsb2IoXCJmb29cXFxcYmFyXFxcXC4uXFxcXGJhelwiKSwgXCJmb29cXFxcYmF6XCIpO1xuICogICBhc3NlcnRFcXVhbHMobm9ybWFsaXplR2xvYihcImZvb1xcXFwqKlxcXFwuLlxcXFxiYXJcXFxcLi5cXFxcYmF6XCIsIHsgZ2xvYnN0YXI6IHRydWUgfSksIFwiZm9vXFxcXCoqXFxcXC4uXFxcXGJhelwiKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGFzc2VydEVxdWFscyhub3JtYWxpemVHbG9iKFwiZm9vL2Jhci8uLi9iYXpcIiksIFwiZm9vL2JhelwiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKG5vcm1hbGl6ZUdsb2IoXCJmb28vKipcXC8uLi9iYXIvLi4vYmF6XCIsIHsgZ2xvYnN0YXI6IHRydWUgfSksIFwiZm9vLyoqXFwvLi4vYmF6XCIpO1xuICogfVxuICogYGBgXG4gKlxuICogQHBhcmFtIGdsb2IgR2xvYiBzdHJpbmcgdG8gbm9ybWFsaXplLlxuICogQHBhcmFtIG9wdGlvbnMgR2xvYiBvcHRpb25zLlxuICogQHJldHVybnMgVGhlIG5vcm1hbGl6ZWQgZ2xvYiBzdHJpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVHbG9iKFxuICBnbG9iOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdsb2JPcHRpb25zID0ge30sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gaXNXaW5kb3dzXG4gICAgPyB3aW5kb3dzTm9ybWFsaXplR2xvYihnbG9iLCBvcHRpb25zKVxuICAgIDogcG9zaXhOb3JtYWxpemVHbG9iKGdsb2IsIG9wdGlvbnMpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFHckMsU0FBUyxTQUFTLFFBQVEsK0JBQStCO0FBQ3pELFNBQVMsaUJBQWlCLGtCQUFrQixRQUFRLDRCQUE0QjtBQUNoRixTQUNFLGlCQUFpQixvQkFBb0IsUUFDaEMsOEJBQThCO0FBSXJDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F3QkMsR0FDRCxPQUFPLFNBQVMsY0FDZCxJQUFZLEVBQ1osVUFBdUIsQ0FBQyxDQUFDO0VBRXpCLE9BQU8sWUFDSCxxQkFBcUIsTUFBTSxXQUMzQixtQkFBbUIsTUFBTTtBQUMvQiJ9
// denoCacheMetadata=17112306295597814537,12633026236234923585