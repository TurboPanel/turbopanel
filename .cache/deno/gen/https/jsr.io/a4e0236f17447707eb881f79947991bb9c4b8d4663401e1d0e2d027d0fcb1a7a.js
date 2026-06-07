// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertArg } from "../_common/dirname.ts";
import { CHAR_COLON } from "../_common/constants.ts";
import { stripTrailingSeparators } from "../_common/strip_trailing_separators.ts";
import { isPathSeparator, isPosixPathSeparator, isWindowsDeviceRoot } from "./_util.ts";
import { fromFileUrl } from "./from_file_url.ts";
/**
 * Return the directory path of a `path`.
 *
 * @example Usage
 * ```ts
 * import { dirname } from "@std/path/windows/dirname";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(dirname("C:\\foo\\bar\\baz.ext"), "C:\\foo\\bar");
 * assertEquals(dirname(new URL("file:///C:/foo/bar/baz.ext")), "C:\\foo\\bar");
 * ```
 *
 * @param path The path to get the directory from.
 * @returns The directory path.
 * @throws {TypeError} If `path` is a `URL` instance whose protocol is not `file:`.
 */ export function dirname(path) {
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  assertArg(path);
  const len = path.length;
  let rootEnd = -1;
  let end = -1;
  let matchedSlash = true;
  let offset = 0;
  const code = path.charCodeAt(0);
  // Try to match a root
  if (len > 1) {
    if (isPathSeparator(code)) {
      // Possible UNC root
      rootEnd = offset = 1;
      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning
        let j = 2;
        let last = j;
        // Match 1 or more non-path separators
        for(; j < len; ++j){
          if (isPathSeparator(path.charCodeAt(j))) break;
        }
        if (j < len && j !== last) {
          // Matched!
          last = j;
          // Match 1 or more path separators
          for(; j < len; ++j){
            if (!isPathSeparator(path.charCodeAt(j))) break;
          }
          if (j < len && j !== last) {
            // Matched!
            last = j;
            // Match 1 or more non-path separators
            for(; j < len; ++j){
              if (isPathSeparator(path.charCodeAt(j))) break;
            }
            if (j === len) {
              // We matched a UNC root only
              return path;
            }
            if (j !== last) {
              // We matched a UNC root with leftovers
              // Offset by 1 to include the separator after the UNC root to
              // treat it as a "normal root" on top of a (UNC) root
              rootEnd = offset = j + 1;
            }
          }
        }
      }
    } else if (isWindowsDeviceRoot(code)) {
      // Possible device root
      if (path.charCodeAt(1) === CHAR_COLON) {
        rootEnd = offset = 2;
        if (len > 2) {
          if (isPathSeparator(path.charCodeAt(2))) rootEnd = offset = 3;
        }
      }
    }
  } else if (isPathSeparator(code)) {
    // `path` contains just a path separator, exit early to avoid
    // unnecessary work
    return path;
  }
  for(let i = len - 1; i >= offset; --i){
    if (isPathSeparator(path.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }
  if (end === -1) {
    if (rootEnd === -1) return ".";
    else end = rootEnd;
  }
  return stripTrailingSeparators(path.slice(0, end), isPosixPathSeparator);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL2Rpcm5hbWUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgYXNzZXJ0QXJnIH0gZnJvbSBcIi4uL19jb21tb24vZGlybmFtZS50c1wiO1xuaW1wb3J0IHsgQ0hBUl9DT0xPTiB9IGZyb20gXCIuLi9fY29tbW9uL2NvbnN0YW50cy50c1wiO1xuaW1wb3J0IHsgc3RyaXBUcmFpbGluZ1NlcGFyYXRvcnMgfSBmcm9tIFwiLi4vX2NvbW1vbi9zdHJpcF90cmFpbGluZ19zZXBhcmF0b3JzLnRzXCI7XG5pbXBvcnQge1xuICBpc1BhdGhTZXBhcmF0b3IsXG4gIGlzUG9zaXhQYXRoU2VwYXJhdG9yLFxuICBpc1dpbmRvd3NEZXZpY2VSb290LFxufSBmcm9tIFwiLi9fdXRpbC50c1wiO1xuaW1wb3J0IHsgZnJvbUZpbGVVcmwgfSBmcm9tIFwiLi9mcm9tX2ZpbGVfdXJsLnRzXCI7XG5cbi8qKlxuICogUmV0dXJuIHRoZSBkaXJlY3RvcnkgcGF0aCBvZiBhIGBwYXRoYC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGRpcm5hbWUgfSBmcm9tIFwiQHN0ZC9wYXRoL3dpbmRvd3MvZGlybmFtZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKGRpcm5hbWUoXCJDOlxcXFxmb29cXFxcYmFyXFxcXGJhei5leHRcIiksIFwiQzpcXFxcZm9vXFxcXGJhclwiKTtcbiAqIGFzc2VydEVxdWFscyhkaXJuYW1lKG5ldyBVUkwoXCJmaWxlOi8vL0M6L2Zvby9iYXIvYmF6LmV4dFwiKSksIFwiQzpcXFxcZm9vXFxcXGJhclwiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIGdldCB0aGUgZGlyZWN0b3J5IGZyb20uXG4gKiBAcmV0dXJucyBUaGUgZGlyZWN0b3J5IHBhdGguXG4gKiBAdGhyb3dzIHtUeXBlRXJyb3J9IElmIGBwYXRoYCBpcyBhIGBVUkxgIGluc3RhbmNlIHdob3NlIHByb3RvY29sIGlzIG5vdCBgZmlsZTpgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGlybmFtZShwYXRoOiBzdHJpbmcgfCBVUkwpOiBzdHJpbmcge1xuICBpZiAocGF0aCBpbnN0YW5jZW9mIFVSTCkge1xuICAgIHBhdGggPSBmcm9tRmlsZVVybChwYXRoKTtcbiAgfVxuICBhc3NlcnRBcmcocGF0aCk7XG5cbiAgY29uc3QgbGVuID0gcGF0aC5sZW5ndGg7XG4gIGxldCByb290RW5kID0gLTE7XG4gIGxldCBlbmQgPSAtMTtcbiAgbGV0IG1hdGNoZWRTbGFzaCA9IHRydWU7XG4gIGxldCBvZmZzZXQgPSAwO1xuICBjb25zdCBjb2RlID0gcGF0aC5jaGFyQ29kZUF0KDApO1xuXG4gIC8vIFRyeSB0byBtYXRjaCBhIHJvb3RcbiAgaWYgKGxlbiA+IDEpIHtcbiAgICBpZiAoaXNQYXRoU2VwYXJhdG9yKGNvZGUpKSB7XG4gICAgICAvLyBQb3NzaWJsZSBVTkMgcm9vdFxuXG4gICAgICByb290RW5kID0gb2Zmc2V0ID0gMTtcblxuICAgICAgaWYgKGlzUGF0aFNlcGFyYXRvcihwYXRoLmNoYXJDb2RlQXQoMSkpKSB7XG4gICAgICAgIC8vIE1hdGNoZWQgZG91YmxlIHBhdGggc2VwYXJhdG9yIGF0IGJlZ2lubmluZ1xuICAgICAgICBsZXQgaiA9IDI7XG4gICAgICAgIGxldCBsYXN0ID0gajtcbiAgICAgICAgLy8gTWF0Y2ggMSBvciBtb3JlIG5vbi1wYXRoIHNlcGFyYXRvcnNcbiAgICAgICAgZm9yICg7IGogPCBsZW47ICsraikge1xuICAgICAgICAgIGlmIChpc1BhdGhTZXBhcmF0b3IocGF0aC5jaGFyQ29kZUF0KGopKSkgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGogPCBsZW4gJiYgaiAhPT0gbGFzdCkge1xuICAgICAgICAgIC8vIE1hdGNoZWQhXG4gICAgICAgICAgbGFzdCA9IGo7XG4gICAgICAgICAgLy8gTWF0Y2ggMSBvciBtb3JlIHBhdGggc2VwYXJhdG9yc1xuICAgICAgICAgIGZvciAoOyBqIDwgbGVuOyArK2opIHtcbiAgICAgICAgICAgIGlmICghaXNQYXRoU2VwYXJhdG9yKHBhdGguY2hhckNvZGVBdChqKSkpIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoaiA8IGxlbiAmJiBqICE9PSBsYXN0KSB7XG4gICAgICAgICAgICAvLyBNYXRjaGVkIVxuICAgICAgICAgICAgbGFzdCA9IGo7XG4gICAgICAgICAgICAvLyBNYXRjaCAxIG9yIG1vcmUgbm9uLXBhdGggc2VwYXJhdG9yc1xuICAgICAgICAgICAgZm9yICg7IGogPCBsZW47ICsraikge1xuICAgICAgICAgICAgICBpZiAoaXNQYXRoU2VwYXJhdG9yKHBhdGguY2hhckNvZGVBdChqKSkpIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGogPT09IGxlbikge1xuICAgICAgICAgICAgICAvLyBXZSBtYXRjaGVkIGEgVU5DIHJvb3Qgb25seVxuICAgICAgICAgICAgICByZXR1cm4gcGF0aDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChqICE9PSBsYXN0KSB7XG4gICAgICAgICAgICAgIC8vIFdlIG1hdGNoZWQgYSBVTkMgcm9vdCB3aXRoIGxlZnRvdmVyc1xuXG4gICAgICAgICAgICAgIC8vIE9mZnNldCBieSAxIHRvIGluY2x1ZGUgdGhlIHNlcGFyYXRvciBhZnRlciB0aGUgVU5DIHJvb3QgdG9cbiAgICAgICAgICAgICAgLy8gdHJlYXQgaXQgYXMgYSBcIm5vcm1hbCByb290XCIgb24gdG9wIG9mIGEgKFVOQykgcm9vdFxuICAgICAgICAgICAgICByb290RW5kID0gb2Zmc2V0ID0gaiArIDE7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChpc1dpbmRvd3NEZXZpY2VSb290KGNvZGUpKSB7XG4gICAgICAvLyBQb3NzaWJsZSBkZXZpY2Ugcm9vdFxuXG4gICAgICBpZiAocGF0aC5jaGFyQ29kZUF0KDEpID09PSBDSEFSX0NPTE9OKSB7XG4gICAgICAgIHJvb3RFbmQgPSBvZmZzZXQgPSAyO1xuICAgICAgICBpZiAobGVuID4gMikge1xuICAgICAgICAgIGlmIChpc1BhdGhTZXBhcmF0b3IocGF0aC5jaGFyQ29kZUF0KDIpKSkgcm9vdEVuZCA9IG9mZnNldCA9IDM7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAoaXNQYXRoU2VwYXJhdG9yKGNvZGUpKSB7XG4gICAgLy8gYHBhdGhgIGNvbnRhaW5zIGp1c3QgYSBwYXRoIHNlcGFyYXRvciwgZXhpdCBlYXJseSB0byBhdm9pZFxuICAgIC8vIHVubmVjZXNzYXJ5IHdvcmtcbiAgICByZXR1cm4gcGF0aDtcbiAgfVxuXG4gIGZvciAobGV0IGkgPSBsZW4gLSAxOyBpID49IG9mZnNldDsgLS1pKSB7XG4gICAgaWYgKGlzUGF0aFNlcGFyYXRvcihwYXRoLmNoYXJDb2RlQXQoaSkpKSB7XG4gICAgICBpZiAoIW1hdGNoZWRTbGFzaCkge1xuICAgICAgICBlbmQgPSBpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gV2Ugc2F3IHRoZSBmaXJzdCBub24tcGF0aCBzZXBhcmF0b3JcbiAgICAgIG1hdGNoZWRTbGFzaCA9IGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIGlmIChlbmQgPT09IC0xKSB7XG4gICAgaWYgKHJvb3RFbmQgPT09IC0xKSByZXR1cm4gXCIuXCI7XG4gICAgZWxzZSBlbmQgPSByb290RW5kO1xuICB9XG4gIHJldHVybiBzdHJpcFRyYWlsaW5nU2VwYXJhdG9ycyhwYXRoLnNs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
// denoCacheMetadata=1798524356184322711,4428553655252086814