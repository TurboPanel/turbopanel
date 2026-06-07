// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertArg } from "../_common/normalize.ts";
import { CHAR_COLON } from "../_common/constants.ts";
import { normalizeString } from "../_common/normalize_string.ts";
import { isPathSeparator, isWindowsDeviceRoot } from "./_util.ts";
import { fromFileUrl } from "./from_file_url.ts";
/**
 * Normalize the `path`, resolving `'..'` and `'.'` segments.
 * Note that resolving these segments does not necessarily mean that all will be eliminated.
 * A `'..'` at the top-level will be preserved, and an empty path is canonically `'.'`.
 *
 * @example Usage
 * ```ts
 * import { normalize } from "@std/path/windows/normalize";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(normalize("C:\\foo\\..\\bar"), "C:\\bar");
 * assertEquals(normalize(new URL("file:///C:/foo/../bar")), "C:\\bar");
 * ```
 *
 * @param path The path to normalize
 * @returns The normalized path
 */ export function normalize(path) {
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  assertArg(path);
  const len = path.length;
  let rootEnd = 0;
  let device;
  let isAbsolute = false;
  const code = path.charCodeAt(0);
  // Try to match a root
  if (len > 1) {
    if (isPathSeparator(code)) {
      // Possible UNC root
      // If we started with a separator, we know we at least have an absolute
      // path of some kind (UNC or otherwise)
      isAbsolute = true;
      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning
        let j = 2;
        let last = j;
        // Match 1 or more non-path separators
        for(; j < len; ++j){
          if (isPathSeparator(path.charCodeAt(j))) break;
        }
        if (j < len && j !== last) {
          const firstPart = path.slice(last, j);
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
              // Return the normalized version of the UNC root since there
              // is nothing left to process
              return `\\\\${firstPart}\\${path.slice(last)}\\`;
            } else if (j !== last) {
              // We matched a UNC root with leftovers
              device = `\\\\${firstPart}\\${path.slice(last, j)}`;
              rootEnd = j;
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else if (isWindowsDeviceRoot(code)) {
      // Possible device root
      if (path.charCodeAt(1) === CHAR_COLON) {
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2) {
          if (isPathSeparator(path.charCodeAt(2))) {
            // Treat separator following drive name as an absolute path
            // indicator
            isAbsolute = true;
            rootEnd = 3;
          }
        }
      }
    }
  } else if (isPathSeparator(code)) {
    // `path` contains just a path separator, exit early to avoid unnecessary
    // work
    return "\\";
  }
  let tail;
  if (rootEnd < len) {
    tail = normalizeString(path.slice(rootEnd), !isAbsolute, "\\", isPathSeparator);
  } else {
    tail = "";
  }
  if (tail.length === 0 && !isAbsolute) tail = ".";
  if (tail.length > 0 && isPathSeparator(path.charCodeAt(len - 1))) {
    tail += "\\";
  }
  if (device === undefined) {
    if (isAbsolute) {
      if (tail.length > 0) return `\\${tail}`;
      else return "\\";
    }
    return tail;
  } else if (isAbsolute) {
    if (tail.length > 0) return `${device}\\${tail}`;
    else return `${device}\\`;
  }
  return device + tail;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL25vcm1hbGl6ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBhc3NlcnRBcmcgfSBmcm9tIFwiLi4vX2NvbW1vbi9ub3JtYWxpemUudHNcIjtcbmltcG9ydCB7IENIQVJfQ09MT04gfSBmcm9tIFwiLi4vX2NvbW1vbi9jb25zdGFudHMudHNcIjtcbmltcG9ydCB7IG5vcm1hbGl6ZVN0cmluZyB9IGZyb20gXCIuLi9fY29tbW9uL25vcm1hbGl6ZV9zdHJpbmcudHNcIjtcbmltcG9ydCB7IGlzUGF0aFNlcGFyYXRvciwgaXNXaW5kb3dzRGV2aWNlUm9vdCB9IGZyb20gXCIuL191dGlsLnRzXCI7XG5pbXBvcnQgeyBmcm9tRmlsZVVybCB9IGZyb20gXCIuL2Zyb21fZmlsZV91cmwudHNcIjtcblxuLyoqXG4gKiBOb3JtYWxpemUgdGhlIGBwYXRoYCwgcmVzb2x2aW5nIGAnLi4nYCBhbmQgYCcuJ2Agc2VnbWVudHMuXG4gKiBOb3RlIHRoYXQgcmVzb2x2aW5nIHRoZXNlIHNlZ21lbnRzIGRvZXMgbm90IG5lY2Vzc2FyaWx5IG1lYW4gdGhhdCBhbGwgd2lsbCBiZSBlbGltaW5hdGVkLlxuICogQSBgJy4uJ2AgYXQgdGhlIHRvcC1sZXZlbCB3aWxsIGJlIHByZXNlcnZlZCwgYW5kIGFuIGVtcHR5IHBhdGggaXMgY2Fub25pY2FsbHkgYCcuJ2AuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBub3JtYWxpemUgfSBmcm9tIFwiQHN0ZC9wYXRoL3dpbmRvd3Mvbm9ybWFsaXplXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRFcXVhbHMobm9ybWFsaXplKFwiQzpcXFxcZm9vXFxcXC4uXFxcXGJhclwiKSwgXCJDOlxcXFxiYXJcIik7XG4gKiBhc3NlcnRFcXVhbHMobm9ybWFsaXplKG5ldyBVUkwoXCJmaWxlOi8vL0M6L2Zvby8uLi9iYXJcIikpLCBcIkM6XFxcXGJhclwiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIG5vcm1hbGl6ZVxuICogQHJldHVybnMgVGhlIG5vcm1hbGl6ZWQgcGF0aFxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplKHBhdGg6IHN0cmluZyB8IFVSTCk6IHN0cmluZyB7XG4gIGlmIChwYXRoIGluc3RhbmNlb2YgVVJMKSB7XG4gICAgcGF0aCA9IGZyb21GaWxlVXJsKHBhdGgpO1xuICB9XG4gIGFzc2VydEFyZyhwYXRoKTtcblxuICBjb25zdCBsZW4gPSBwYXRoLmxlbmd0aDtcbiAgbGV0IHJvb3RFbmQgPSAwO1xuICBsZXQgZGV2aWNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBpc0Fic29sdXRlID0gZmFsc2U7XG4gIGNvbnN0IGNvZGUgPSBwYXRoLmNoYXJDb2RlQXQoMCk7XG5cbiAgLy8gVHJ5IHRvIG1hdGNoIGEgcm9vdFxuICBpZiAobGVuID4gMSkge1xuICAgIGlmIChpc1BhdGhTZXBhcmF0b3IoY29kZSkpIHtcbiAgICAgIC8vIFBvc3NpYmxlIFVOQyByb290XG5cbiAgICAgIC8vIElmIHdlIHN0YXJ0ZWQgd2l0aCBhIHNlcGFyYXRvciwgd2Uga25vdyB3ZSBhdCBsZWFzdCBoYXZlIGFuIGFic29sdXRlXG4gICAgICAvLyBwYXRoIG9mIHNvbWUga2luZCAoVU5DIG9yIG90aGVyd2lzZSlcbiAgICAgIGlzQWJzb2x1dGUgPSB0cnVlO1xuXG4gICAgICBpZiAoaXNQYXRoU2VwYXJhdG9yKHBhdGguY2hhckNvZGVBdCgxKSkpIHtcbiAgICAgICAgLy8gTWF0Y2hlZCBkb3VibGUgcGF0aCBzZXBhcmF0b3IgYXQgYmVnaW5uaW5nXG4gICAgICAgIGxldCBqID0gMjtcbiAgICAgICAgbGV0IGxhc3QgPSBqO1xuICAgICAgICAvLyBNYXRjaCAxIG9yIG1vcmUgbm9uLXBhdGggc2VwYXJhdG9yc1xuICAgICAgICBmb3IgKDsgaiA8IGxlbjsgKytqKSB7XG4gICAgICAgICAgaWYgKGlzUGF0aFNlcGFyYXRvcihwYXRoLmNoYXJDb2RlQXQoaikpKSBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBpZiAoaiA8IGxlbiAmJiBqICE9PSBsYXN0KSB7XG4gICAgICAgICAgY29uc3QgZmlyc3RQYXJ0ID0gcGF0aC5zbGljZShsYXN0LCBqKTtcbiAgICAgICAgICAvLyBNYXRjaGVkIVxuICAgICAgICAgIGxhc3QgPSBqO1xuICAgICAgICAgIC8vIE1hdGNoIDEgb3IgbW9yZSBwYXRoIHNlcGFyYXRvcnNcbiAgICAgICAgICBmb3IgKDsgaiA8IGxlbjsgKytqKSB7XG4gICAgICAgICAgICBpZiAoIWlzUGF0aFNlcGFyYXRvcihwYXRoLmNoYXJDb2RlQXQoaikpKSBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGogPCBsZW4gJiYgaiAhPT0gbGFzdCkge1xuICAgICAgICAgICAgLy8gTWF0Y2hlZCFcbiAgICAgICAgICAgIGxhc3QgPSBqO1xuICAgICAgICAgICAgLy8gTWF0Y2ggMSBvciBtb3JlIG5vbi1wYXRoIHNlcGFyYXRvcnNcbiAgICAgICAgICAgIGZvciAoOyBqIDwgbGVuOyArK2opIHtcbiAgICAgICAgICAgICAgaWYgKGlzUGF0aFNlcGFyYXRvcihwYXRoLmNoYXJDb2RlQXQoaikpKSBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChqID09PSBsZW4pIHtcbiAgICAgICAgICAgICAgLy8gV2UgbWF0Y2hlZCBhIFVOQyByb290IG9ubHlcbiAgICAgICAgICAgICAgLy8gUmV0dXJuIHRoZSBub3JtYWxpemVkIHZlcnNpb24gb2YgdGhlIFVOQyByb290IHNpbmNlIHRoZXJlXG4gICAgICAgICAgICAgIC8vIGlzIG5vdGhpbmcgbGVmdCB0byBwcm9jZXNzXG5cbiAgICAgICAgICAgICAgcmV0dXJuIGBcXFxcXFxcXCR7Zmlyc3RQYXJ0fVxcXFwke3BhdGguc2xpY2UobGFzdCl9XFxcXGA7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGogIT09IGxhc3QpIHtcbiAgICAgICAgICAgICAgLy8gV2UgbWF0Y2hlZCBhIFVOQyByb290IHdpdGggbGVmdG92ZXJzXG5cbiAgICAgICAgICAgICAgZGV2aWNlID0gYFxcXFxcXFxcJHtmaXJzdFBhcnR9XFxcXCR7cGF0aC5zbGljZShsYXN0LCBqKX1gO1xuICAgICAgICAgICAgICByb290RW5kID0gajtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJvb3RFbmQgPSAxO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoaXNXaW5kb3dzRGV2aWNlUm9vdChjb2RlKSkge1xuICAgICAgLy8gUG9zc2libGUgZGV2aWNlIHJvb3RcblxuICAgICAgaWYgKHBhdGguY2hhckNvZGVBdCgxKSA9PT0gQ0hBUl9DT0xPTikge1xuICAgICAgICBkZXZpY2UgPSBwYXRoLnNsaWNlKDAsIDIpO1xuICAgICAgICByb290RW5kID0gMjtcbiAgICAgICAgaWYgKGxlbiA+IDIpIHtcbiAgICAgICAgICBpZiAoaXNQYXRoU2VwYXJhdG9yKHBhdGguY2hhckNvZGVBdCgyKSkpIHtcbiAgICAgICAgICAgIC8vIFRyZWF0IHNlcGFyYXRvciBmb2xsb3dpbmcgZHJpdmUgbmFtZSBhcyBhbiBhYnNvbHV0ZSBwYXRoXG4gICAgICAgICAgICAvLyBpbmRpY2F0b3JcbiAgICAgICAgICAgIGlzQWJzb2x1dGUgPSB0cnVlO1xuICAgICAgICAgICAgcm9vdEVuZCA9IDM7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2UgaWYgKGlzUGF0aFNlcGFyYXRvcihjb2RlKSkge1xuICAgIC8vIGBwYXRoYCBjb250YWlucyBqdXN0IGEgcGF0aCBzZXBhcmF0b3IsIGV4aXQgZWFybHkgdG8gYXZvaWQgdW5uZWNlc3NhcnlcbiAgICAvLyB3b3JrXG4gICAgcmV0dXJuIFwiXFxcXFwiO1xuICB9XG5cbiAgbGV0IHRhaWw6IHN0cmluZztcbiAgaWYgKHJvb3RFbmQgPCBsZW4pIHtcbiAgICB0YWlsID0gbm9ybWFsaXplU3RyaW5nKFxuICAgICAgcGF0aC5zbGljZShyb290RW5kKSxcbiAgICAgICFpc0Fic29sdXRlLFxuICAgICAgXCJcXFxcXCIsXG4gICAgICBpc1BhdGhTZXBhcmF0b3IsXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICB0YWlsID0gXCJcIjtcbiAgfVxuICBpZiAodGFpbC5sZW5ndGggPT09IDAgJiYgIWlzQWJzb2x1dGUpIHRhaWwgPSBcIi5cIjtcbiAgaWYgKHRhaWwubGVuZ3RoID4gMCAmJiBpc1BhdGhTZXBhcmF0b3IocGF0aC5jaGFyQ29kZUF0KGxlbiAtIDEpKSkge1xuICAgIHRhaWwgKz0gXCJcXFxcXCI7XG4gIH1cbiAgaWYgKGRldmljZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKGlzQWJzb2x1dGUpIHtcbiAgICAgIGlmICh0YWlsLmxlbmd0aCA+IDApIHJldHVybiBgXFxcXCR7dGFpbH1gO1xuICAgICAgZWxzZSByZXR1cm4gXCJcXFxcXCI7XG4gICAgfVxuICAgIHJldHVybiB0YWlsO1xuICB9IGVsc2UgaWYgKGlzQWJzb2x1dGUpIHtcbiAgICBpZiAodGFpbC5sZW5ndGggPiAwKSByZXR1cm4gYCR7ZGV2aWNlfVxcXFwke3RhaWx9YDtcbiAgICBlbHNlIHJldHVybiBgJHtkZXZpY2V9XFxcXGA7XG4gIH1cbiAgcmV0dXJuIGRldmljZSArIHRhaWw7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUFTLFNBQVMsUUFBUSwwQkFBMEI7QUFDcEQsU0FBUyxVQUFVLFFBQVEsMEJBQTBCO0FBQ3JELFNBQVMsZUFB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
// denoCacheMetadata=15247605930835982270,13861736273394700525