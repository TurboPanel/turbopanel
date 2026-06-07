// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { format as posixFormat } from "./posix/format.ts";
import { format as windowsFormat } from "./windows/format.ts";
/**
 * Generate a path from a {@linkcode ParsedPath} object. It does the
 * opposite of {@linkcode https://jsr.io/@std/path/doc/~/parse | parse()}.
 *
 * @example Usage
 * ```ts
 * import { format } from "@std/path/format";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(format({ dir: "C:\\path\\to", base: "script.ts" }), "C:\\path\\to\\script.ts");
 * } else {
 *   assertEquals(format({ dir: "/path/to/dir", base: "script.ts" }), "/path/to/dir/script.ts");
 * }
 * ```
 *
 * @param pathObject Object with path components.
 * @returns The formatted path.
 */ export function format(pathObject) {
  return isWindows ? windowsFormat(pathObject) : posixFormat(pathObject);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9mb3JtYXQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgaXNXaW5kb3dzIH0gZnJvbSBcImpzcjpAc3RkL2ludGVybmFsQF4xLjAuMTQvb3NcIjtcbmltcG9ydCB7IGZvcm1hdCBhcyBwb3NpeEZvcm1hdCB9IGZyb20gXCIuL3Bvc2l4L2Zvcm1hdC50c1wiO1xuaW1wb3J0IHsgZm9ybWF0IGFzIHdpbmRvd3NGb3JtYXQgfSBmcm9tIFwiLi93aW5kb3dzL2Zvcm1hdC50c1wiO1xuaW1wb3J0IHR5cGUgeyBQYXJzZWRQYXRoIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcblxuLyoqXG4gKiBHZW5lcmF0ZSBhIHBhdGggZnJvbSBhIHtAbGlua2NvZGUgUGFyc2VkUGF0aH0gb2JqZWN0LiBJdCBkb2VzIHRoZVxuICogb3Bwb3NpdGUgb2Yge0BsaW5rY29kZSBodHRwczovL2pzci5pby9Ac3RkL3BhdGgvZG9jL34vcGFyc2UgfCBwYXJzZSgpfS5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGZvcm1hdCB9IGZyb20gXCJAc3RkL3BhdGgvZm9ybWF0XCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgYXNzZXJ0RXF1YWxzKGZvcm1hdCh7IGRpcjogXCJDOlxcXFxwYXRoXFxcXHRvXCIsIGJhc2U6IFwic2NyaXB0LnRzXCIgfSksIFwiQzpcXFxccGF0aFxcXFx0b1xcXFxzY3JpcHQudHNcIik7XG4gKiB9IGVsc2Uge1xuICogICBhc3NlcnRFcXVhbHMoZm9ybWF0KHsgZGlyOiBcIi9wYXRoL3RvL2RpclwiLCBiYXNlOiBcInNjcmlwdC50c1wiIH0pLCBcIi9wYXRoL3RvL2Rpci9zY3JpcHQudHNcIik7XG4gKiB9XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gcGF0aE9iamVjdCBPYmplY3Qgd2l0aCBwYXRoIGNvbXBvbmVudHMuXG4gKiBAcmV0dXJucyBUaGUgZm9ybWF0dGVkIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXQocGF0aE9iamVjdDogUGFydGlhbDxQYXJzZWRQYXRoPik6IHN0cmluZyB7XG4gIHJldHVybiBpc1dpbmRvd3MgPyB3aW5kb3dzRm9ybWF0KHBhdGhPYmplY3QpIDogcG9zaXhGb3JtYXQocGF0aE9iamVjdCk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUFTLFNBQVMsUUFBUSwrQkFBK0I7QUFDekQsU0FBUyxVQUFVLFdBQVcsUUFBUSxvQkFBb0I7QUFDMUQsU0FBUyxVQUFVLGFBQWEsUUFBUSxzQkFBc0I7QUFHOUQ7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWtCQyxHQUNELE9BQU8sU0FBUyxPQUFPLFVBQStCO0VBQ3BELE9BQU8sWUFBWSxjQUFjLGNBQWMsWUFBWTtBQUM3RCJ9
// denoCacheMetadata=12442075197277274590,6786773197050888631