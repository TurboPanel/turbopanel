// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertPath } from "../_common/assert_path.ts";
import { isPosixPathSeparator } from "./_util.ts";
/**
 * Verifies whether provided path is absolute.
 *
 * @example Usage
 * ```ts
 * import { isAbsolute } from "@std/path/posix/is-absolute";
 * import { assert, assertFalse } from "@std/assert";
 *
 * assert(isAbsolute("/home/user/Documents/"));
 * assertFalse(isAbsolute("home/user/Documents/"));
 * ```
 *
 * @param path The path to verify.
 * @returns Whether the path is absolute.
 */ export function isAbsolute(path) {
  assertPath(path);
  return path.length > 0 && isPosixPathSeparator(path.charCodeAt(0));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9pc19hYnNvbHV0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBhc3NlcnRQYXRoIH0gZnJvbSBcIi4uL19jb21tb24vYXNzZXJ0X3BhdGgudHNcIjtcbmltcG9ydCB7IGlzUG9zaXhQYXRoU2VwYXJhdG9yIH0gZnJvbSBcIi4vX3V0aWwudHNcIjtcblxuLyoqXG4gKiBWZXJpZmllcyB3aGV0aGVyIHByb3ZpZGVkIHBhdGggaXMgYWJzb2x1dGUuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBpc0Fic29sdXRlIH0gZnJvbSBcIkBzdGQvcGF0aC9wb3NpeC9pcy1hYnNvbHV0ZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0LCBhc3NlcnRGYWxzZSB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydChpc0Fic29sdXRlKFwiL2hvbWUvdXNlci9Eb2N1bWVudHMvXCIpKTtcbiAqIGFzc2VydEZhbHNlKGlzQWJzb2x1dGUoXCJob21lL3VzZXIvRG9jdW1lbnRzL1wiKSk7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gcGF0aCBUaGUgcGF0aCB0byB2ZXJpZnkuXG4gKiBAcmV0dXJucyBXaGV0aGVyIHRoZSBwYXRoIGlzIGFic29sdXRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNBYnNvbHV0ZShwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgYXNzZXJ0UGF0aChwYXRoKTtcbiAgcmV0dXJuIHBhdGgubGVuZ3RoID4gMCAmJiBpc1Bvc2l4UGF0aFNlcGFyYXRvcihwYXRoLmNoYXJDb2RlQXQoMCkpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxVQUFVLFFBQVEsNEJBQTRCO0FBQ3ZELFNBQVMsb0JBQW9CLFFBQVEsYUFBYTtBQUVsRDs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUyxXQUFXLElBQVk7RUFDckMsV0FBVztFQUNYLE9BQU8sS0FBSyxNQUFNLEdBQUcsS0FBSyxxQkFBcUIsS0FBSyxVQUFVLENBQUM7QUFDakUifQ==
// denoCacheMetadata=2828346766099635648,9617034318422704140