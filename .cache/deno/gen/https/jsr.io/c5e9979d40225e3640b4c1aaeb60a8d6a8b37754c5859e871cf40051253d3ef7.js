// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { encodeWhitespace } from "../_common/to_file_url.ts";
import { isAbsolute } from "./is_absolute.ts";
/**
 * Converts a path string to a file URL.
 *
 * @example Usage
 * ```ts
 * import { toFileUrl } from "@std/path/posix/to-file-url";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(toFileUrl("/home/foo"), new URL("file:///home/foo"));
 * assertEquals(toFileUrl("/home/foo bar"), new URL("file:///home/foo%20bar"));
 * ```
 *
 * @param path The path to convert.
 * @returns The file URL.
 */ export function toFileUrl(path) {
  if (!isAbsolute(path)) {
    throw new TypeError(`Path must be absolute: received "${path}"`);
  }
  const url = new URL("file:///");
  url.pathname = encodeWhitespace(path.replace(/%/g, "%25").replace(/\\/g, "%5C"));
  return url;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC90b19maWxlX3VybC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBlbmNvZGVXaGl0ZXNwYWNlIH0gZnJvbSBcIi4uL19jb21tb24vdG9fZmlsZV91cmwudHNcIjtcbmltcG9ydCB7IGlzQWJzb2x1dGUgfSBmcm9tIFwiLi9pc19hYnNvbHV0ZS50c1wiO1xuXG4vKipcbiAqIENvbnZlcnRzIGEgcGF0aCBzdHJpbmcgdG8gYSBmaWxlIFVSTC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IHRvRmlsZVVybCB9IGZyb20gXCJAc3RkL3BhdGgvcG9zaXgvdG8tZmlsZS11cmxcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyh0b0ZpbGVVcmwoXCIvaG9tZS9mb29cIiksIG5ldyBVUkwoXCJmaWxlOi8vL2hvbWUvZm9vXCIpKTtcbiAqIGFzc2VydEVxdWFscyh0b0ZpbGVVcmwoXCIvaG9tZS9mb28gYmFyXCIpLCBuZXcgVVJMKFwiZmlsZTovLy9ob21lL2ZvbyUyMGJhclwiKSk7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gcGF0aCBUaGUgcGF0aCB0byBjb252ZXJ0LlxuICogQHJldHVybnMgVGhlIGZpbGUgVVJMLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdG9GaWxlVXJsKHBhdGg6IHN0cmluZyk6IFVSTCB7XG4gIGlmICghaXNBYnNvbHV0ZShwYXRoKSkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoYFBhdGggbXVzdCBiZSBhYnNvbHV0ZTogcmVjZWl2ZWQgXCIke3BhdGh9XCJgKTtcbiAgfVxuXG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoXCJmaWxlOi8vL1wiKTtcbiAgdXJsLnBhdGhuYW1lID0gZW5jb2RlV2hpdGVzcGFjZShcbiAgICBwYXRoLnJlcGxhY2UoLyUvZywgXCIlMjVcIikucmVwbGFjZSgvXFxcXC9nLCBcIiU1Q1wiKSxcbiAgKTtcbiAgcmV0dXJuIHVybDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsZ0JBQWdCLFFBQVEsNEJBQTRCO0FBQzdELFNBQVMsVUFBVSxRQUFRLG1CQUFtQjtBQUU5Qzs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUyxVQUFVLElBQVk7RUFDcEMsSUFBSSxDQUFDLFdBQVcsT0FBTztJQUNyQixNQUFNLElBQUksVUFBVSxDQUFDLGlDQUFpQyxFQUFFLEtBQUssQ0FBQyxDQUFDO0VBQ2pFO0VBRUEsTUFBTSxNQUFNLElBQUksSUFBSTtFQUNwQixJQUFJLFFBQVEsR0FBRyxpQkFDYixLQUFLLE9BQU8sQ0FBQyxNQUFNLE9BQU8sT0FBTyxDQUFDLE9BQU87RUFFM0MsT0FBTztBQUNUIn0=
// denoCacheMetadata=17758845652942694613,12991640322224729222