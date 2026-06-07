// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { normalize as posixNormalize } from "./posix/normalize.ts";
import { normalize as windowsNormalize } from "./windows/normalize.ts";
/**
 * Normalize the path, resolving `'..'` and `'.'` segments.
 *
 * Note: Resolving these segments does not necessarily mean that all will be
 * eliminated. A `'..'` at the top-level will be preserved, and an empty path is
 * canonically `'.'`.
 *
 * @example Usage
 * ```ts
 * import { normalize } from "@std/path/normalize";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(normalize("C:\\foo\\bar\\..\\baz\\quux"), "C:\\foo\\baz\\quux");
 *   assertEquals(normalize(new URL("file:///C:/foo/bar/../baz/quux")), "C:\\foo\\baz\\quux");
 * } else {
 *   assertEquals(normalize("/foo/bar/../baz/quux"), "/foo/baz/quux");
 *   assertEquals(normalize(new URL("file:///foo/bar/../baz/quux")), "/foo/baz/quux");
 * }
 * ```
 *
 * @param path Path to be normalized
 * @returns The normalized path.
 */ export function normalize(path) {
  return isWindows ? windowsNormalize(path) : posixNormalize(path);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9ub3JtYWxpemUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgaXNXaW5kb3dzIH0gZnJvbSBcImpzcjpAc3RkL2ludGVybmFsQF4xLjAuMTQvb3NcIjtcbmltcG9ydCB7IG5vcm1hbGl6ZSBhcyBwb3NpeE5vcm1hbGl6ZSB9IGZyb20gXCIuL3Bvc2l4L25vcm1hbGl6ZS50c1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplIGFzIHdpbmRvd3NOb3JtYWxpemUgfSBmcm9tIFwiLi93aW5kb3dzL25vcm1hbGl6ZS50c1wiO1xuLyoqXG4gKiBOb3JtYWxpemUgdGhlIHBhdGgsIHJlc29sdmluZyBgJy4uJ2AgYW5kIGAnLidgIHNlZ21lbnRzLlxuICpcbiAqIE5vdGU6IFJlc29sdmluZyB0aGVzZSBzZWdtZW50cyBkb2VzIG5vdCBuZWNlc3NhcmlseSBtZWFuIHRoYXQgYWxsIHdpbGwgYmVcbiAqIGVsaW1pbmF0ZWQuIEEgYCcuLidgIGF0IHRoZSB0b3AtbGV2ZWwgd2lsbCBiZSBwcmVzZXJ2ZWQsIGFuZCBhbiBlbXB0eSBwYXRoIGlzXG4gKiBjYW5vbmljYWxseSBgJy4nYC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IG5vcm1hbGl6ZSB9IGZyb20gXCJAc3RkL3BhdGgvbm9ybWFsaXplXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKG5vcm1hbGl6ZShcIkM6XFxcXGZvb1xcXFxiYXJcXFxcLi5cXFxcYmF6XFxcXHF1dXhcIiksIFwiQzpcXFxcZm9vXFxcXGJhelxcXFxxdXV4XCIpO1xuICogICBhc3NlcnRFcXVhbHMobm9ybWFsaXplKG5ldyBVUkwoXCJmaWxlOi8vL0M6L2Zvby9iYXIvLi4vYmF6L3F1dXhcIikpLCBcIkM6XFxcXGZvb1xcXFxiYXpcXFxccXV1eFwiKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGFzc2VydEVxdWFscyhub3JtYWxpemUoXCIvZm9vL2Jhci8uLi9iYXovcXV1eFwiKSwgXCIvZm9vL2Jhei9xdXV4XCIpO1xuICogICBhc3NlcnRFcXVhbHMobm9ybWFsaXplKG5ldyBVUkwoXCJmaWxlOi8vL2Zvby9iYXIvLi4vYmF6L3F1dXhcIikpLCBcIi9mb28vYmF6L3F1dXhcIik7XG4gKiB9XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gcGF0aCBQYXRoIHRvIGJlIG5vcm1hbGl6ZWRcbiAqIEByZXR1cm5zIFRoZSBub3JtYWxpemVkIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemUocGF0aDogc3RyaW5nIHwgVVJMKTogc3RyaW5nIHtcbiAgcmV0dXJuIGlzV2luZG93cyA/IHdpbmRvd3NOb3JtYWxpemUocGF0aCkgOiBwb3NpeE5vcm1hbGl6ZShwYXRoKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTLGFBQWEsY0FBYyxRQUFRLHVCQUF1QjtBQUNuRSxTQUFTLGFBQWEsZ0JBQWdCLFFBQVEseUJBQXlCO0FBQ3ZFOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCQyxHQUNELE9BQU8sU0FBUyxVQUFVLElBQWtCO0VBQzFDLE9BQU8sWUFBWSxpQkFBaUIsUUFBUSxlQUFlO0FBQzdEIn0=
// denoCacheMetadata=8316154879455383087,10074782111013783051