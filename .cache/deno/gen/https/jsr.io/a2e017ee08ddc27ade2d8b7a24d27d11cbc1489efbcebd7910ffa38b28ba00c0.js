// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { parse as posixParse } from "./posix/parse.ts";
import { parse as windowsParse } from "./windows/parse.ts";
/**
 * Return an object containing the parsed components of the path.
 *
 * Use {@linkcode https://jsr.io/@std/path/doc/~/format | format()} to reverse
 * the result.
 *
 * @example Usage
 * ```ts
 * import { parse } from "@std/path/parse";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   const parsedPathObj = parse("C:\\path\\to\\script.ts");
 *   assertEquals(parsedPathObj.root, "C:\\");
 *   assertEquals(parsedPathObj.dir, "C:\\path\\to");
 *   assertEquals(parsedPathObj.base, "script.ts");
 *   assertEquals(parsedPathObj.ext, ".ts");
 *   assertEquals(parsedPathObj.name, "script");
 * } else {
 *   const parsedPathObj = parse("/path/to/dir/script.ts");
 *   parsedPathObj.root; // "/"
 *   parsedPathObj.dir; // "/path/to/dir"
 *   parsedPathObj.base; // "script.ts"
 *   parsedPathObj.ext; // ".ts"
 *   parsedPathObj.name; // "script"
 * }
 * ```
 *
 * @param path Path to process
 * @returns An object with the parsed path components.
 */ export function parse(path) {
  return isWindows ? windowsParse(path) : posixParse(path);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wYXJzZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBpc1dpbmRvd3MgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xNC9vc1wiO1xuaW1wb3J0IHR5cGUgeyBQYXJzZWRQYXRoIH0gZnJvbSBcIi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHBhcnNlIGFzIHBvc2l4UGFyc2UgfSBmcm9tIFwiLi9wb3NpeC9wYXJzZS50c1wiO1xuaW1wb3J0IHsgcGFyc2UgYXMgd2luZG93c1BhcnNlIH0gZnJvbSBcIi4vd2luZG93cy9wYXJzZS50c1wiO1xuXG5leHBvcnQgdHlwZSB7IFBhcnNlZFBhdGggfSBmcm9tIFwiLi90eXBlcy50c1wiO1xuXG4vKipcbiAqIFJldHVybiBhbiBvYmplY3QgY29udGFpbmluZyB0aGUgcGFyc2VkIGNvbXBvbmVudHMgb2YgdGhlIHBhdGguXG4gKlxuICogVXNlIHtAbGlua2NvZGUgaHR0cHM6Ly9qc3IuaW8vQHN0ZC9wYXRoL2RvYy9+L2Zvcm1hdCB8IGZvcm1hdCgpfSB0byByZXZlcnNlXG4gKiB0aGUgcmVzdWx0LlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgcGFyc2UgfSBmcm9tIFwiQHN0ZC9wYXRoL3BhcnNlXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBpZiAoRGVuby5idWlsZC5vcyA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAqICAgY29uc3QgcGFyc2VkUGF0aE9iaiA9IHBhcnNlKFwiQzpcXFxccGF0aFxcXFx0b1xcXFxzY3JpcHQudHNcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXJzZWRQYXRoT2JqLnJvb3QsIFwiQzpcXFxcXCIpO1xuICogICBhc3NlcnRFcXVhbHMocGFyc2VkUGF0aE9iai5kaXIsIFwiQzpcXFxccGF0aFxcXFx0b1wiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKHBhcnNlZFBhdGhPYmouYmFzZSwgXCJzY3JpcHQudHNcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXJzZWRQYXRoT2JqLmV4dCwgXCIudHNcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXJzZWRQYXRoT2JqLm5hbWUsIFwic2NyaXB0XCIpO1xuICogfSBlbHNlIHtcbiAqICAgY29uc3QgcGFyc2VkUGF0aE9iaiA9IHBhcnNlKFwiL3BhdGgvdG8vZGlyL3NjcmlwdC50c1wiKTtcbiAqICAgcGFyc2VkUGF0aE9iai5yb290OyAvLyBcIi9cIlxuICogICBwYXJzZWRQYXRoT2JqLmRpcjsgLy8gXCIvcGF0aC90by9kaXJcIlxuICogICBwYXJzZWRQYXRoT2JqLmJhc2U7IC8vIFwic2NyaXB0LnRzXCJcbiAqICAgcGFyc2VkUGF0aE9iai5leHQ7IC8vIFwiLnRzXCJcbiAqICAgcGFyc2VkUGF0aE9iai5uYW1lOyAvLyBcInNjcmlwdFwiXG4gKiB9XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gcGF0aCBQYXRoIHRvIHByb2Nlc3NcbiAqIEByZXR1cm5zIEFuIG9iamVjdCB3aXRoIHRoZSBwYXJzZWQgcGF0aCBjb21wb25lbnRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2UocGF0aDogc3RyaW5nKTogUGFyc2VkUGF0aCB7XG4gIHJldHVybiBpc1dpbmRvd3MgPyB3aW5kb3dzUGFyc2UocGF0aCkgOiBwb3NpeFBhcnNlKHBhdGgpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxTQUFTLFFBQVEsK0JBQStCO0FBRXpELFNBQVMsU0FBUyxVQUFVLFFBQVEsbUJBQW1CO0FBQ3ZELFNBQVMsU0FBUyxZQUFZLFFBQVEscUJBQXFCO0FBSTNEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E4QkMsR0FDRCxPQUFPLFNBQVMsTUFBTSxJQUFZO0VBQ2hDLE9BQU8sWUFBWSxhQUFhLFFBQVEsV0FBVztBQUNyRCJ9
// denoCacheMetadata=13799598835225938873,13371123529717021733