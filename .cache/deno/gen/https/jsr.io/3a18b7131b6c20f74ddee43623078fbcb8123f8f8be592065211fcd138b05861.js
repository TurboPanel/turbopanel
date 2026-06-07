// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { _format, assertArg } from "../_common/format.ts";
/**
 * Generate a path from `ParsedPath` object.
 *
 * @example Usage
 * ```ts
 * import { format } from "@std/path/posix/format";
 * import { assertEquals } from "@std/assert";
 *
 * const path = format({
 *   root: "/",
 *   dir: "/path/dir",
 *   base: "file.txt",
 *   ext: ".txt",
 *   name: "file"
 * });
 * assertEquals(path, "/path/dir/file.txt");
 * ```
 *
 * @param pathObject The path object to format.
 * @returns The formatted path.
 */ export function format(pathObject) {
  assertArg(pathObject);
  return _format("/", pathObject);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9mb3JtYXQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgX2Zvcm1hdCwgYXNzZXJ0QXJnIH0gZnJvbSBcIi4uL19jb21tb24vZm9ybWF0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IFBhcnNlZFBhdGggfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuLyoqXG4gKiBHZW5lcmF0ZSBhIHBhdGggZnJvbSBgUGFyc2VkUGF0aGAgb2JqZWN0LlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgZm9ybWF0IH0gZnJvbSBcIkBzdGQvcGF0aC9wb3NpeC9mb3JtYXRcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGNvbnN0IHBhdGggPSBmb3JtYXQoe1xuICogICByb290OiBcIi9cIixcbiAqICAgZGlyOiBcIi9wYXRoL2RpclwiLFxuICogICBiYXNlOiBcImZpbGUudHh0XCIsXG4gKiAgIGV4dDogXCIudHh0XCIsXG4gKiAgIG5hbWU6IFwiZmlsZVwiXG4gKiB9KTtcbiAqIGFzc2VydEVxdWFscyhwYXRoLCBcIi9wYXRoL2Rpci9maWxlLnR4dFwiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoT2JqZWN0IFRoZSBwYXRoIG9iamVjdCB0byBmb3JtYXQuXG4gKiBAcmV0dXJucyBUaGUgZm9ybWF0dGVkIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXQocGF0aE9iamVjdDogUGFydGlhbDxQYXJzZWRQYXRoPik6IHN0cmluZyB7XG4gIGFzc2VydEFyZyhwYXRoT2JqZWN0KTtcbiAgcmV0dXJuIF9mb3JtYXQoXCIvXCIsIHBhdGhPYmplY3QpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxPQUFPLEVBQUUsU0FBUyxRQUFRLHVCQUF1QjtBQUcxRDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FvQkMsR0FDRCxPQUFPLFNBQVMsT0FBTyxVQUErQjtFQUNwRCxVQUFVO0VBQ1YsT0FBTyxRQUFRLEtBQUs7QUFDdEIifQ==
// denoCacheMetadata=14013591582764511836,3843939257943504146