// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { CHAR_BACKWARD_SLASH, CHAR_COLON, CHAR_DOT, CHAR_QUESTION_MARK } from "../_common/constants.ts";
import { isWindowsDeviceRoot } from "./_util.ts";
import { resolve } from "./resolve.ts";
/**
 * Resolves path to a namespace path
 *
 * @example Usage
 * ```ts
 * import { toNamespacedPath } from "@std/path/windows/to-namespaced-path";
 * import { assertEquals } from "@std/assert";
 *
 * const namespaced = toNamespacedPath("C:\\foo\\bar");
 * assertEquals(namespaced, "\\\\?\\C:\\foo\\bar");
 * ```
 *
 * @param path The path to resolve to namespaced path
 * @returns The resolved namespaced path
 */ export function toNamespacedPath(path) {
  // Note: this will *probably* throw somewhere.
  if (typeof path !== "string") return path;
  if (path.length === 0) return "";
  const resolvedPath = resolve(path);
  if (resolvedPath.length >= 3) {
    if (resolvedPath.charCodeAt(0) === CHAR_BACKWARD_SLASH) {
      // Possible UNC root
      if (resolvedPath.charCodeAt(1) === CHAR_BACKWARD_SLASH) {
        const code = resolvedPath.charCodeAt(2);
        if (code !== CHAR_QUESTION_MARK && code !== CHAR_DOT) {
          // Matched non-long UNC root, convert the path to a long UNC path
          return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
        }
      }
    } else if (isWindowsDeviceRoot(resolvedPath.charCodeAt(0))) {
      // Possible device root
      if (resolvedPath.charCodeAt(1) === CHAR_COLON && resolvedPath.charCodeAt(2) === CHAR_BACKWARD_SLASH) {
        // Matched device root, convert the path to a long UNC path
        return `\\\\?\\${resolvedPath}`;
      }
    }
  }
  return path;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL3RvX25hbWVzcGFjZWRfcGF0aC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQge1xuICBDSEFSX0JBQ0tXQVJEX1NMQVNILFxuICBDSEFSX0NPTE9OLFxuICBDSEFSX0RPVCxcbiAgQ0hBUl9RVUVTVElPTl9NQVJLLFxufSBmcm9tIFwiLi4vX2NvbW1vbi9jb25zdGFudHMudHNcIjtcbmltcG9ydCB7IGlzV2luZG93c0RldmljZVJvb3QgfSBmcm9tIFwiLi9fdXRpbC50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gXCIuL3Jlc29sdmUudHNcIjtcblxuLyoqXG4gKiBSZXNvbHZlcyBwYXRoIHRvIGEgbmFtZXNwYWNlIHBhdGhcbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IHRvTmFtZXNwYWNlZFBhdGggfSBmcm9tIFwiQHN0ZC9wYXRoL3dpbmRvd3MvdG8tbmFtZXNwYWNlZC1wYXRoXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCBuYW1lc3BhY2VkID0gdG9OYW1lc3BhY2VkUGF0aChcIkM6XFxcXGZvb1xcXFxiYXJcIik7XG4gKiBhc3NlcnRFcXVhbHMobmFtZXNwYWNlZCwgXCJcXFxcXFxcXD9cXFxcQzpcXFxcZm9vXFxcXGJhclwiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIHJlc29sdmUgdG8gbmFtZXNwYWNlZCBwYXRoXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgbmFtZXNwYWNlZCBwYXRoXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b05hbWVzcGFjZWRQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIC8vIE5vdGU6IHRoaXMgd2lsbCAqcHJvYmFibHkqIHRocm93IHNvbWV3aGVyZS5cbiAgaWYgKHR5cGVvZiBwYXRoICE9PSBcInN0cmluZ1wiKSByZXR1cm4gcGF0aDtcbiAgaWYgKHBhdGgubGVuZ3RoID09PSAwKSByZXR1cm4gXCJcIjtcblxuICBjb25zdCByZXNvbHZlZFBhdGggPSByZXNvbHZlKHBhdGgpO1xuXG4gIGlmIChyZXNvbHZlZFBhdGgubGVuZ3RoID49IDMpIHtcbiAgICBpZiAocmVzb2x2ZWRQYXRoLmNoYXJDb2RlQXQoMCkgPT09IENIQVJfQkFDS1dBUkRfU0xBU0gpIHtcbiAgICAgIC8vIFBvc3NpYmxlIFVOQyByb290XG5cbiAgICAgIGlmIChyZXNvbHZlZFBhdGguY2hhckNvZGVBdCgxKSA9PT0gQ0hBUl9CQUNLV0FSRF9TTEFTSCkge1xuICAgICAgICBjb25zdCBjb2RlID0gcmVzb2x2ZWRQYXRoLmNoYXJDb2RlQXQoMik7XG4gICAgICAgIGlmIChjb2RlICE9PSBDSEFSX1FVRVNUSU9OX01BUksgJiYgY29kZSAhPT0gQ0hBUl9ET1QpIHtcbiAgICAgICAgICAvLyBNYXRjaGVkIG5vbi1sb25nIFVOQyByb290LCBjb252ZXJ0IHRoZSBwYXRoIHRvIGEgbG9uZyBVTkMgcGF0aFxuICAgICAgICAgIHJldHVybiBgXFxcXFxcXFw/XFxcXFVOQ1xcXFwke3Jlc29sdmVkUGF0aC5zbGljZSgyKX1gO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChpc1dpbmRvd3NEZXZpY2VSb290KHJlc29sdmVkUGF0aC5jaGFyQ29kZUF0KDApKSkge1xuICAgICAgLy8gUG9zc2libGUgZGV2aWNlIHJvb3RcblxuICAgICAgaWYgKFxuICAgICAgICByZXNvbHZlZFBhdGguY2hhckNvZGVBdCgxKSA9PT0gQ0hBUl9DT0xPTiAmJlxuICAgICAgICByZXNvbHZlZFBhdGguY2hhckNvZGVBdCgyKSA9PT0gQ0hBUl9CQUNLV0FSRF9TTEFTSFxuICAgICAgKSB7XG4gICAgICAgIC8vIE1hdGNoZWQgZGV2aWNlIHJvb3QsIGNvbnZlcnQgdGhlIHBhdGggdG8gYSBsb25nIFVOQyBwYXRoXG4gICAgICAgIHJldHVybiBgXFxcXFxcXFw/XFxcXCR7cmVzb2x2ZWRQYXRofWA7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBhdGg7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUNFLG1CQUFtQixFQUNuQixVQUFVLEVBQ1YsUUFBUSxFQUNSLGtCQUFrQixRQUNiLDBCQUEwQjtBQUNqQyxTQUFTLG1CQUFtQixRQUFRLGFBQWE7QUFDakQsU0FBUyxPQUFPLFFBQVEsZUFBZTtBQUV2Qzs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUyxpQkFBaUIsSUFBWTtFQUMzQyw4Q0FBOEM7RUFDOUMsSUFBSSxPQUFPLFNBQVMsVUFBVSxPQUFPO0VBQ3JDLElBQUksS0FBSyxNQUFNLEtBQUssR0FBRyxPQUFPO0VBRTlCLE1BQU0sZUFBZSxRQUFRO0VBRTdCLElBQUksYUFBYSxNQUFNLElBQUksR0FBRztJQUM1QixJQUFJLGFBQWEsVUFBVSxDQUFDLE9BQU8scUJBQXFCO01BQ3RELG9CQUFvQjtNQUVwQixJQUFJLGFBQWEsVUFBVSxDQUFDLE9BQU8scUJBQXFCO1FBQ3RELE1BQU0sT0FBTyxhQUFhLFVBQVUsQ0FBQztRQUNyQyxJQUFJLFNBQVMsc0JBQXNCLFNBQVMsVUFBVTtVQUNwRCxpRUFBaUU7VUFDakUsT0FBTyxDQUFDLFlBQVksRUFBRSxhQUFhLEtBQUssQ0FBQyxJQUFJO1FBQy9DO01BQ0Y7SUFDRixPQUFPLElBQUksb0JBQW9CLGFBQWEsVUFBVSxDQUFDLEtBQUs7TUFDMUQsdUJBQXVCO01BRXZCLElBQ0UsYUFBYSxVQUFVLENBQUMsT0FBTyxjQUMvQixhQUFhLFVBQVUsQ0FBQyxPQUFPLHFCQUMvQjtRQUNBLDJEQUEyRDtRQUMzRCxPQUFPLENBQUMsT0FBTyxFQUFFLGNBQWM7TUFDakM7SUFDRjtFQUNGO0VBRUEsT0FBTztBQUNUIn0=
// denoCacheMetadata=9867650277388693697,15877381863325560201