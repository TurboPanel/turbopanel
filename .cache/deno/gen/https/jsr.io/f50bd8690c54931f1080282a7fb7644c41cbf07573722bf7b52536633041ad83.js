// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { relative as posixRelative } from "./posix/relative.ts";
import { relative as windowsRelative } from "./windows/relative.ts";
/**
 * Return the relative path from `from` to `to` based on current working
 * directory.
 *
 * @example Usage
 * ```ts
 * import { relative } from "@std/path/relative";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   const path = relative("C:\\foobar\\test\\aaa", "C:\\foobar\\impl\\bbb");
 *   assertEquals(path, "..\\..\\impl\\bbb");
 * } else {
 *   const path = relative("/data/foobar/test/aaa", "/data/foobar/impl/bbb");
 *   assertEquals(path, "../../impl/bbb");
 * }
 * ```
 *
 * @param from Path in current working directory.
 * @param to Path in current working directory.
 * @returns The relative path from `from` to `to`.
 */ export function relative(from, to) {
  return isWindows ? windowsRelative(from, to) : posixRelative(from, to);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9yZWxhdGl2ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBpc1dpbmRvd3MgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xNC9vc1wiO1xuaW1wb3J0IHsgcmVsYXRpdmUgYXMgcG9zaXhSZWxhdGl2ZSB9IGZyb20gXCIuL3Bvc2l4L3JlbGF0aXZlLnRzXCI7XG5pbXBvcnQgeyByZWxhdGl2ZSBhcyB3aW5kb3dzUmVsYXRpdmUgfSBmcm9tIFwiLi93aW5kb3dzL3JlbGF0aXZlLnRzXCI7XG5cbi8qKlxuICogUmV0dXJuIHRoZSByZWxhdGl2ZSBwYXRoIGZyb20gYGZyb21gIHRvIGB0b2AgYmFzZWQgb24gY3VycmVudCB3b3JraW5nXG4gKiBkaXJlY3RvcnkuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyByZWxhdGl2ZSB9IGZyb20gXCJAc3RkL3BhdGgvcmVsYXRpdmVcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBjb25zdCBwYXRoID0gcmVsYXRpdmUoXCJDOlxcXFxmb29iYXJcXFxcdGVzdFxcXFxhYWFcIiwgXCJDOlxcXFxmb29iYXJcXFxcaW1wbFxcXFxiYmJcIik7XG4gKiAgIGFzc2VydEVxdWFscyhwYXRoLCBcIi4uXFxcXC4uXFxcXGltcGxcXFxcYmJiXCIpO1xuICogfSBlbHNlIHtcbiAqICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKFwiL2RhdGEvZm9vYmFyL3Rlc3QvYWFhXCIsIFwiL2RhdGEvZm9vYmFyL2ltcGwvYmJiXCIpO1xuICogICBhc3NlcnRFcXVhbHMocGF0aCwgXCIuLi8uLi9pbXBsL2JiYlwiKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBmcm9tIFBhdGggaW4gY3VycmVudCB3b3JraW5nIGRpcmVjdG9yeS5cbiAqIEBwYXJhbSB0byBQYXRoIGluIGN1cnJlbnQgd29ya2luZyBkaXJlY3RvcnkuXG4gKiBAcmV0dXJucyBUaGUgcmVsYXRpdmUgcGF0aCBmcm9tIGBmcm9tYCB0byBgdG9gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVsYXRpdmUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGlzV2luZG93cyA/IHdpbmRvd3NSZWxhdGl2ZShmcm9tLCB0bykgOiBwb3NpeFJlbGF0aXZlKGZyb20sIHRvKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTLFlBQVksYUFBYSxRQUFRLHNCQUFzQjtBQUNoRSxTQUFTLFlBQVksZUFBZSxRQUFRLHdCQUF3QjtBQUVwRTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBcUJDLEdBQ0QsT0FBTyxTQUFTLFNBQVMsSUFBWSxFQUFFLEVBQVU7RUFDL0MsT0FBTyxZQUFZLGdCQUFnQixNQUFNLE1BQU0sY0FBYyxNQUFNO0FBQ3JFIn0=
// denoCacheMetadata=926956147482111020,11076283447169368534