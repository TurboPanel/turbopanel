// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { isAbsolute as posixIsAbsolute } from "./posix/is_absolute.ts";
import { isAbsolute as windowsIsAbsolute } from "./windows/is_absolute.ts";
/**
 * Verifies whether provided path is absolute.
 *
 * @example Usage
 * ```ts
 * import { isAbsolute } from "@std/path/is-absolute";
 * import { assert, assertFalse } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assert(isAbsolute("C:\\home\\foo"));
 *   assertFalse(isAbsolute("home\\foo"));
 * } else {
 *   assert(isAbsolute("/home/foo"));
 *   assertFalse(isAbsolute("home/foo"));
 * }
 * ```
 *
 * @param path Path to be verified as absolute.
 * @returns `true` if path is absolute, `false` otherwise
 */ export function isAbsolute(path) {
  return isWindows ? windowsIsAbsolute(path) : posixIsAbsolute(path);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9pc19hYnNvbHV0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBpc1dpbmRvd3MgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xNC9vc1wiO1xuaW1wb3J0IHsgaXNBYnNvbHV0ZSBhcyBwb3NpeElzQWJzb2x1dGUgfSBmcm9tIFwiLi9wb3NpeC9pc19hYnNvbHV0ZS50c1wiO1xuaW1wb3J0IHsgaXNBYnNvbHV0ZSBhcyB3aW5kb3dzSXNBYnNvbHV0ZSB9IGZyb20gXCIuL3dpbmRvd3MvaXNfYWJzb2x1dGUudHNcIjtcblxuLyoqXG4gKiBWZXJpZmllcyB3aGV0aGVyIHByb3ZpZGVkIHBhdGggaXMgYWJzb2x1dGUuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBpc0Fic29sdXRlIH0gZnJvbSBcIkBzdGQvcGF0aC9pcy1hYnNvbHV0ZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0LCBhc3NlcnRGYWxzZSB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBhc3NlcnQoaXNBYnNvbHV0ZShcIkM6XFxcXGhvbWVcXFxcZm9vXCIpKTtcbiAqICAgYXNzZXJ0RmFsc2UoaXNBYnNvbHV0ZShcImhvbWVcXFxcZm9vXCIpKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGFzc2VydChpc0Fic29sdXRlKFwiL2hvbWUvZm9vXCIpKTtcbiAqICAgYXNzZXJ0RmFsc2UoaXNBYnNvbHV0ZShcImhvbWUvZm9vXCIpKTtcbiAqIH1cbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFBhdGggdG8gYmUgdmVyaWZpZWQgYXMgYWJzb2x1dGUuXG4gKiBAcmV0dXJucyBgdHJ1ZWAgaWYgcGF0aCBpcyBhYnNvbHV0ZSwgYGZhbHNlYCBvdGhlcndpc2VcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQWJzb2x1dGUocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBpc1dpbmRvd3MgPyB3aW5kb3dzSXNBYnNvbHV0ZShwYXRoKSA6IHBvc2l4SXNBYnNvbHV0ZShwYXRoKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTLGNBQWMsZUFBZSxRQUFRLHlCQUF5QjtBQUN2RSxTQUFTLGNBQWMsaUJBQWlCLFFBQVEsMkJBQTJCO0FBRTNFOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUJDLEdBQ0QsT0FBTyxTQUFTLFdBQVcsSUFBWTtFQUNyQyxPQUFPLFlBQVksa0JBQWtCLFFBQVEsZ0JBQWdCO0FBQy9EIn0=
// denoCacheMetadata=7531390812282739049,6780546979858943547