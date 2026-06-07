// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { CHAR_DOT } from "../_common/constants.ts";
import { assertPath } from "../_common/assert_path.ts";
import { isPosixPathSeparator } from "./_util.ts";
import { fromFileUrl } from "./from_file_url.ts";
/**
 * Return the extension of the `path` with leading period.
 *
 * @example Usage
 * ```ts
 * import { extname } from "@std/path/posix/extname";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(extname("/home/user/Documents/file.ts"), ".ts");
 * assertEquals(extname("/home/user/Documents/"), "");
 * assertEquals(extname("/home/user/Documents/image.png"), ".png");
 * assertEquals(extname(new URL("file:///home/user/Documents/file.ts")), ".ts");
 * assertEquals(extname(new URL("file:///home/user/Documents/file.ts?a=b")), ".ts");
 * assertEquals(extname(new URL("file:///home/user/Documents/file.ts#header")), ".ts");
 * ```
 *
 * @example Working with URLs
 *
 * Only `URL` instances with the `file:` protocol are accepted. To process a
 * non-`file:` URL, pass it as a string or pass its `pathname` property.
 *
 * Note: This function doesn't automatically strip hash and query parts from
 * URLs. If your URL contains a hash or query, remove them before passing the
 * URL to the function. This can be done by passing the URL to `new URL(url)`,
 * and setting the `hash` and `search` properties to empty strings.
 *
 * ```ts
 * import { extname } from "@std/path/posix/extname";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(extname("https://deno.land/std/path/mod.ts"), ".ts");
 * assertEquals(extname("https://deno.land/std/path/mod.ts?a=b"), ".ts?a=b");
 * assertEquals(extname("https://deno.land/std/path/mod.ts#header"), ".ts#header");
 * assertEquals(extname(new URL("https://deno.land/std/path/mod.ts").pathname), ".ts");
 * ```
 *
 * @param path The path to get the extension from.
 * @returns The extension (ex. for `file.ts` returns `.ts`).
 * @throws {TypeError} If `path` is a `URL` instance whose protocol is not `file:`.
 */ export function extname(path) {
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  assertPath(path);
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find
  let preDotState = 0;
  for(let i = path.length - 1; i >= 0; --i){
    const code = path.charCodeAt(i);
    if (isPosixPathSeparator(code)) {
      // If we reached a path separator that was not part of a set of path
      // separators at the end of the string, stop now
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // extension
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CHAR_DOT) {
      // If this is our first dot, mark it as the start of our extension
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-path separator before our dot, so we should
      // have a good chance at having a non-empty extension
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || // We saw a non-dot character immediately before the dot
  preDotState === 0 || // The (right-most) trimmed path component is exactly '..'
  preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
    return "";
  }
  return path.slice(startDot, end);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9leHRuYW1lLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB7IENIQVJfRE9UIH0gZnJvbSBcIi4uL19jb21tb24vY29uc3RhbnRzLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnRQYXRoIH0gZnJvbSBcIi4uL19jb21tb24vYXNzZXJ0X3BhdGgudHNcIjtcbmltcG9ydCB7IGlzUG9zaXhQYXRoU2VwYXJhdG9yIH0gZnJvbSBcIi4vX3V0aWwudHNcIjtcbmltcG9ydCB7IGZyb21GaWxlVXJsIH0gZnJvbSBcIi4vZnJvbV9maWxlX3VybC50c1wiO1xuXG4vKipcbiAqIFJldHVybiB0aGUgZXh0ZW5zaW9uIG9mIHRoZSBgcGF0aGAgd2l0aCBsZWFkaW5nIHBlcmlvZC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGV4dG5hbWUgfSBmcm9tIFwiQHN0ZC9wYXRoL3Bvc2l4L2V4dG5hbWVcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhleHRuYW1lKFwiL2hvbWUvdXNlci9Eb2N1bWVudHMvZmlsZS50c1wiKSwgXCIudHNcIik7XG4gKiBhc3NlcnRFcXVhbHMoZXh0bmFtZShcIi9ob21lL3VzZXIvRG9jdW1lbnRzL1wiKSwgXCJcIik7XG4gKiBhc3NlcnRFcXVhbHMoZXh0bmFtZShcIi9ob21lL3VzZXIvRG9jdW1lbnRzL2ltYWdlLnBuZ1wiKSwgXCIucG5nXCIpO1xuICogYXNzZXJ0RXF1YWxzKGV4dG5hbWUobmV3IFVSTChcImZpbGU6Ly8vaG9tZS91c2VyL0RvY3VtZW50cy9maWxlLnRzXCIpKSwgXCIudHNcIik7XG4gKiBhc3NlcnRFcXVhbHMoZXh0bmFtZShuZXcgVVJMKFwiZmlsZTovLy9ob21lL3VzZXIvRG9jdW1lbnRzL2ZpbGUudHM/YT1iXCIpKSwgXCIudHNcIik7XG4gKiBhc3NlcnRFcXVhbHMoZXh0bmFtZShuZXcgVVJMKFwiZmlsZTovLy9ob21lL3VzZXIvRG9jdW1lbnRzL2ZpbGUudHMjaGVhZGVyXCIpKSwgXCIudHNcIik7XG4gKiBgYGBcbiAqXG4gKiBAZXhhbXBsZSBXb3JraW5nIHdpdGggVVJMc1xuICpcbiAqIE9ubHkgYFVSTGAgaW5zdGFuY2VzIHdpdGggdGhlIGBmaWxlOmAgcHJvdG9jb2wgYXJlIGFjY2VwdGVkLiBUbyBwcm9jZXNzIGFcbiAqIG5vbi1gZmlsZTpgIFVSTCwgcGFzcyBpdCBhcyBhIHN0cmluZyBvciBwYXNzIGl0cyBgcGF0aG5hbWVgIHByb3BlcnR5LlxuICpcbiAqIE5vdGU6IFRoaXMgZnVuY3Rpb24gZG9lc24ndCBhdXRvbWF0aWNhbGx5IHN0cmlwIGhhc2ggYW5kIHF1ZXJ5IHBhcnRzIGZyb21cbiAqIFVSTHMuIElmIHlvdXIgVVJMIGNvbnRhaW5zIGEgaGFzaCBvciBxdWVyeSwgcmVtb3ZlIHRoZW0gYmVmb3JlIHBhc3NpbmcgdGhlXG4gKiBVUkwgdG8gdGhlIGZ1bmN0aW9uLiBUaGlzIGNhbiBiZSBkb25lIGJ5IHBhc3NpbmcgdGhlIFVSTCB0byBgbmV3IFVSTCh1cmwpYCxcbiAqIGFuZCBzZXR0aW5nIHRoZSBgaGFzaGAgYW5kIGBzZWFyY2hgIHByb3BlcnRpZXMgdG8gZW1wdHkgc3RyaW5ncy5cbiAqXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgZXh0bmFtZSB9IGZyb20gXCJAc3RkL3BhdGgvcG9zaXgvZXh0bmFtZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKGV4dG5hbWUoXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvcGF0aC9tb2QudHNcIiksIFwiLnRzXCIpO1xuICogYXNzZXJ0RXF1YWxzKGV4dG5hbWUoXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvcGF0aC9tb2QudHM/YT1iXCIpLCBcIi50cz9hPWJcIik7XG4gKiBhc3NlcnRFcXVhbHMoZXh0bmFtZShcImh0dHBzOi8vZGVuby5sYW5kL3N0ZC9wYXRoL21vZC50cyNoZWFkZXJcIiksIFwiLnRzI2hlYWRlclwiKTtcbiAqIGFzc2VydEVxdWFscyhleHRuYW1lKG5ldyBVUkwoXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvcGF0aC9tb2QudHNcIikucGF0aG5hbWUpLCBcIi50c1wiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIGdldCB0aGUgZXh0ZW5zaW9uIGZyb20uXG4gKiBAcmV0dXJucyBUaGUgZXh0ZW5zaW9uIChleC4gZm9yIGBmaWxlLnRzYCByZXR1cm5zIGAudHNgKS5cbiAqIEB0aHJvd3Mge1R5cGVFcnJvcn0gSWYgYHBhdGhgIGlzIGEgYFVSTGAgaW5zdGFuY2Ugd2hvc2UgcHJvdG9jb2wgaXMgbm90IGBmaWxlOmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRuYW1lKHBhdGg6IHN0cmluZyB8IFVSTCk6IHN0cmluZyB7XG4gIGlmIChwYXRoIGluc3RhbmNlb2YgVVJMKSB7XG4gICAgcGF0aCA9IGZyb21GaWxlVXJsKHBhdGgpO1xuICB9XG4gIGFzc2VydFBhdGgocGF0aCk7XG5cbiAgbGV0IHN0YXJ0RG90ID0gLTE7XG4gIGxldCBzdGFydFBhcnQgPSAwO1xuICBsZXQgZW5kID0gLTE7XG4gIGxldCBtYXRjaGVkU2xhc2ggPSB0cnVlO1xuICAvLyBUcmFjayB0aGUgc3RhdGUgb2YgY2hhcmFjdGVycyAoaWYgYW55KSB3ZSBzZWUgYmVmb3JlIG91ciBmaXJzdCBkb3QgYW5kXG4gIC8vIGFmdGVyIGFueSBwYXRoIHNlcGFyYXRvciB3ZSBmaW5kXG4gIGxldCBwcmVEb3RTdGF0ZSA9IDA7XG4gIGZvciAobGV0IGkgPSBwYXRoLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgY29uc3QgY29kZSA9IHBhdGguY2hhckNvZGVBdChpKTtcbiAgICBpZiAoaXNQb3NpeFBhdGhTZXBhcmF0b3IoY29kZSkpIHtcbiAgICAgIC8vIElmIHdlIHJlYWNoZWQgYSBwYXRoIHNlcGFyYXRvciB0aGF0IHdhcyBub3QgcGFydCBvZiBhIHNldCBvZiBwYXRoXG4gICAgICAvLyBzZXBhcmF0b3JzIGF0IHRoZSBlbmQgb2YgdGhlIHN0cmluZywgc3RvcCBub3dcbiAgICAgIGlmICghbWF0Y2hlZFNsYXNoKSB7XG4gICAgICAgIHN0YXJ0UGFydCA9IGkgKyAxO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoZW5kID09PSAtMSkge1xuICAgICAgLy8gV2Ugc2F3IHRoZSBmaXJzdCBub24tcGF0aCBzZXBhcmF0b3IsIG1hcmsgdGhpcyBhcyB0aGUgZW5kIG9mIG91clxuICAgICAgLy8gZXh0ZW5zaW9uXG4gICAgICBtYXRjaGVkU2xhc2ggPSBmYWxzZTtcbiAgICAgIGVuZCA9IGkgKyAxO1xuICAgIH1cbiAgICBpZiAoY29kZSA9PT0gQ0hBUl9ET1QpIHtcbiAgICAgIC8vIElmIHRoaXMgaXMgb3VyIGZpcnN0IGRvdCwgbWFyayBpdCBhcyB0aGUgc3RhcnQgb2Ygb3VyIGV4dGVuc2lvblxuICAgICAgaWYgKHN0YXJ0RG90ID09PSAtMSkgc3RhcnREb3QgPSBpO1xuICAgICAgZWxzZSBpZiAocHJlRG90U3RhdGUgIT09IDEpIHByZURvdFN0YXRlID0gMTtcbiAgICB9IGVsc2UgaWYgKHN0YXJ0RG90ICE9PSAtMSkge1xuICAgICAgLy8gV2Ugc2F3IGEgbm9uLWRvdCBhbmQgbm9uLXBhdGggc2VwYXJhdG9yIGJlZm9yZSBvdXIgZG90LCBzbyB3ZSBzaG91bGRcbiAgICAgIC8vIGhhdmUgYSBnb29kIGNoYW5jZSBhdCBoYXZpbmcgYSBub24tZW1wdHkgZXh0ZW5zaW9uXG4gICAgICBwcmVEb3RTdGF0ZSA9IC0xO1xuICAgIH1cbiAgfVxuXG4gIGlmIChcbiAgICBzdGFydERvdCA9PT0gLTEgfHxcbiAgICBlbmQgPT09IC0xIHx8XG4gICAgLy8gV2Ugc2F3IGEgbm9uLWRvdCBjaGFyYWN0ZXIgaW1tZWRpYXRlbHkgYmVmb3JlIHRoZSBkb3RcbiAgICBwcmVEb3RTdGF0ZSA9PT0gMCB8fFxuICAgIC8vIFRoZSAocmlnaHQtbW9zdCkgdHJpbW1lZCBwYXRoIGNvbXBvbmVudCBpcyBleGFjdGx5ICcuLidcbiAgICAocHJlRG90U3RhdGUgPT09IDEgJiYgc3RhcnREb3QgPT09IGVuZCAtIDEgJiYgc3RhcnREb3QgPT09IHN0YXJ0UGFydCArIDEpXG4gICkge1xuICAgIHJldHVybiBcIlwiO1xuICB9XG4gIHJldHVybiBwYXRoLnNsaWNlKHN0YXJ0RG90LCBlbmQpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFEQUFxRDtBQUNyRCxxQ0FBcUM7QUFFckMsU0FBUyxRQUFRLFFBQVEsMEJBQTBCO0FBQ25ELFNBQVMsVUFBVSxRQUFRLDRCQUE0QjtBQUN2RCxTQUFTLG9CQUFvQixRQUFRLGFBQWE7QUFDbEQsU0FBUyxXQUFXLFFBQVEscUJBQXFCO0FBRWpEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1Q0MsR0FDRCxPQUFPLFNBQVMsUUFBUSxJQUFrQjtFQUN4QyxJQUFJLGdCQUFnQixLQUFLO0lBQ3ZCLE9BQU8sWUFBWTtFQUNyQjtFQUNBLFdBQVc7RUFFWCxJQUFJLFdBQVcsQ0FBQztFQUNoQixJQUFJLFlBQVk7RUFDaEIsSUFBSSxNQUFNLENBQUM7RUFDWCxJQUFJLGVBQWU7RUFDbkIseUVBQXlFO0VBQ3pFLG1DQUFtQztFQUNuQyxJQUFJLGNBQWM7RUFDbEIsSUFBSyxJQUFJLElBQUksS0FBSyxNQUFNLEdBQUcsR0FBRyxLQUFLLEdBQUcsRUFBRSxFQUFHO0lBQ3pDLE1BQU0sT0FBTyxLQUFLLFVBQVUsQ0FBQztJQUM3QixJQUFJLHFCQUFxQixPQUFPO01BQzlCLG9FQUFvRTtNQUNwRSxnREFBZ0Q7TUFDaEQsSUFBSSxDQUFDLGNBQWM7UUFDakIsWUFBWSxJQUFJO1FBQ2hCO01BQ0Y7TUFDQTtJQUNGO0lBQ0EsSUFBSSxRQUFRLENBQUMsR0FBRztNQUNkLG1FQUFtRTtNQUNuRSxZQUFZO01BQ1osZUFBZTtNQUNmLE1BQU0sSUFBSTtJQUNaO0lBQ0EsSUFBSSxTQUFTLFVBQVU7TUFDckIsa0VBQWtFO01BQ2xFLElBQUksYUFBYSxDQUFDLEdBQUcsV0FBVztXQUMzQixJQUFJLGdCQUFnQixHQUFHLGNBQWM7SUFDNUMsT0FBTyxJQUFJLGFBQWEsQ0FBQyxHQUFHO01BQzFCLHVFQUF1RTtNQUN2RSxxREFBcUQ7TUFDckQsY0FBYyxDQUFDO0lBQ2pCO0VBQ0Y7RUFFQSxJQUNFLGFBQWEsQ0FBQyxLQUNkLFFBQVEsQ0FBQyxLQUNULHdEQUF3RDtFQUN4RCxnQkFBZ0IsS0FDaEIsMERBQTBEO0VBQ3pELGdCQUFnQixLQUFLLGFBQWEsTUFBTSxLQUFLLGFBQWEsWUFBWSxHQUN2RTtJQUNBLE9BQU87RUFDVDtFQUNBLE9BQU8sS0FBSyxLQUFLLENBQUMsVUFBVTtBQUM5QiJ9
// denoCacheMetadata=8555452278991711356,4701913291043935638