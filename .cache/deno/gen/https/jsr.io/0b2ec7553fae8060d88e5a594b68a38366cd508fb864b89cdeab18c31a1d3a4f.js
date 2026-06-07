// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isPosixPathSeparator } from "./_util.ts";
import { resolve } from "./resolve.ts";
import { assertArgs } from "../_common/relative.ts";
/**
 * Return the relative path from `from` to `to` based on current working directory.
 *
 * If `from` and `to` are the same, return an empty string.
 *
 * @example Usage
 * ```ts
 * import { relative } from "@std/path/posix/relative";
 * import { assertEquals } from "@std/assert";
 *
 * const path = relative("/data/orandea/test/aaa", "/data/orandea/impl/bbb");
 * assertEquals(path, "../../impl/bbb");
 * ```
 *
 * @param from The path to start from.
 * @param to The path to reach.
 * @returns The relative path.
 */ export function relative(from, to) {
  assertArgs(from, to);
  from = resolve(from);
  to = resolve(to);
  if (from === to) return "";
  // Trim any leading backslashes
  let fromStart = 1;
  const fromEnd = from.length;
  for(; fromStart < fromEnd; ++fromStart){
    if (!isPosixPathSeparator(from.charCodeAt(fromStart))) break;
  }
  const fromLen = fromEnd - fromStart;
  // Trim any leading backslashes
  let toStart = 1;
  const toEnd = to.length;
  for(; toStart < toEnd; ++toStart){
    if (!isPosixPathSeparator(to.charCodeAt(toStart))) break;
  }
  const toLen = toEnd - toStart;
  // Compare paths to find the longest common path from root
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for(; i <= length; ++i){
    if (i === length) {
      if (toLen > length) {
        if (isPosixPathSeparator(to.charCodeAt(toStart + i))) {
          // We get here if `from` is the exact base path for `to`.
          // For example: from='/foo/bar'; to='/foo/bar/baz'
          return to.slice(toStart + i + 1);
        } else if (i === 0) {
          // We get here if `from` is the root
          // For example: from='/'; to='/foo'
          return to.slice(toStart + i);
        }
      } else if (fromLen > length) {
        if (isPosixPathSeparator(from.charCodeAt(fromStart + i))) {
          // We get here if `to` is the exact base path for `from`.
          // For example: from='/foo/bar/baz'; to='/foo/bar'
          lastCommonSep = i;
        } else if (i === 0) {
          // We get here if `to` is the root.
          // For example: from='/foo'; to='/'
          lastCommonSep = 0;
        }
      }
      break;
    }
    const fromCode = from.charCodeAt(fromStart + i);
    const toCode = to.charCodeAt(toStart + i);
    if (fromCode !== toCode) break;
    else if (isPosixPathSeparator(fromCode)) lastCommonSep = i;
  }
  let out = "";
  // Generate the relative path based on the path difference between `to`
  // and `from`
  for(i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i){
    if (i === fromEnd || isPosixPathSeparator(from.charCodeAt(i))) {
      if (out.length === 0) out += "..";
      else out += "/..";
    }
  }
  // Lastly, append the rest of the destination (`to`) path that comes after
  // the common path parts
  if (out.length > 0) return out + to.slice(toStart + lastCommonSep);
  else {
    toStart += lastCommonSep;
    if (isPosixPathSeparator(to.charCodeAt(toStart))) ++toStart;
    return to.slice(toStart);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9yZWxhdGl2ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBpc1Bvc2l4UGF0aFNlcGFyYXRvciB9IGZyb20gXCIuL191dGlsLnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlIH0gZnJvbSBcIi4vcmVzb2x2ZS50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0QXJncyB9IGZyb20gXCIuLi9fY29tbW9uL3JlbGF0aXZlLnRzXCI7XG5cbi8qKlxuICogUmV0dXJuIHRoZSByZWxhdGl2ZSBwYXRoIGZyb20gYGZyb21gIHRvIGB0b2AgYmFzZWQgb24gY3VycmVudCB3b3JraW5nIGRpcmVjdG9yeS5cbiAqXG4gKiBJZiBgZnJvbWAgYW5kIGB0b2AgYXJlIHRoZSBzYW1lLCByZXR1cm4gYW4gZW1wdHkgc3RyaW5nLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgcmVsYXRpdmUgfSBmcm9tIFwiQHN0ZC9wYXRoL3Bvc2l4L3JlbGF0aXZlXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCBwYXRoID0gcmVsYXRpdmUoXCIvZGF0YS9vcmFuZGVhL3Rlc3QvYWFhXCIsIFwiL2RhdGEvb3JhbmRlYS9pbXBsL2JiYlwiKTtcbiAqIGFzc2VydEVxdWFscyhwYXRoLCBcIi4uLy4uL2ltcGwvYmJiXCIpO1xuICogYGBgXG4gKlxuICogQHBhcmFtIGZyb20gVGhlIHBhdGggdG8gc3RhcnQgZnJvbS5cbiAqIEBwYXJhbSB0byBUaGUgcGF0aCB0byByZWFjaC5cbiAqIEByZXR1cm5zIFRoZSByZWxhdGl2ZSBwYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVsYXRpdmUoZnJvbTogc3RyaW5nLCB0bzogc3RyaW5nKTogc3RyaW5nIHtcbiAgYXNzZXJ0QXJncyhmcm9tLCB0byk7XG5cbiAgZnJvbSA9IHJlc29sdmUoZnJvbSk7XG4gIHRvID0gcmVzb2x2ZSh0byk7XG5cbiAgaWYgKGZyb20gPT09IHRvKSByZXR1cm4gXCJcIjtcblxuICAvLyBUcmltIGFueSBsZWFkaW5nIGJhY2tzbGFzaGVzXG4gIGxldCBmcm9tU3RhcnQgPSAxO1xuICBjb25zdCBmcm9tRW5kID0gZnJvbS5sZW5ndGg7XG4gIGZvciAoOyBmcm9tU3RhcnQgPCBmcm9tRW5kOyArK2Zyb21TdGFydCkge1xuICAgIGlmICghaXNQb3NpeFBhdGhTZXBhcmF0b3IoZnJvbS5jaGFyQ29kZUF0KGZyb21TdGFydCkpKSBicmVhaztcbiAgfVxuICBjb25zdCBmcm9tTGVuID0gZnJvbUVuZCAtIGZyb21TdGFydDtcblxuICAvLyBUcmltIGFueSBsZWFkaW5nIGJhY2tzbGFzaGVzXG4gIGxldCB0b1N0YXJ0ID0gMTtcbiAgY29uc3QgdG9FbmQgPSB0by5sZW5ndGg7XG4gIGZvciAoOyB0b1N0YXJ0IDwgdG9FbmQ7ICsrdG9TdGFydCkge1xuICAgIGlmICghaXNQb3NpeFBhdGhTZXBhcmF0b3IodG8uY2hhckNvZGVBdCh0b1N0YXJ0KSkpIGJyZWFrO1xuICB9XG4gIGNvbnN0IHRvTGVuID0gdG9FbmQgLSB0b1N0YXJ0O1xuXG4gIC8vIENvbXBhcmUgcGF0aHMgdG8gZmluZCB0aGUgbG9uZ2VzdCBjb21tb24gcGF0aCBmcm9tIHJvb3RcbiAgY29uc3QgbGVuZ3RoID0gZnJvbUxlbiA8IHRvTGVuID8gZnJvbUxlbiA6IHRvTGVuO1xuICBsZXQgbGFzdENvbW1vblNlcCA9IC0xO1xuICBsZXQgaSA9IDA7XG4gIGZvciAoOyBpIDw9IGxlbmd0aDsgKytpKSB7XG4gICAgaWYgKGkgPT09IGxlbmd0aCkge1xuICAgICAgaWYgKHRvTGVuID4gbGVuZ3RoKSB7XG4gICAgICAgIGlmIChpc1Bvc2l4UGF0aFNlcGFyYXRvcih0by5jaGFyQ29kZUF0KHRvU3RhcnQgKyBpKSkpIHtcbiAgICAgICAgICAvLyBXZSBnZXQgaGVyZSBpZiBgZnJvbWAgaXMgdGhlIGV4YWN0IGJhc2UgcGF0aCBmb3IgYHRvYC5cbiAgICAgICAgICAvLyBGb3IgZXhhbXBsZTogZnJvbT0nL2Zvby9iYXInOyB0bz0nL2Zvby9iYXIvYmF6J1xuICAgICAgICAgIHJldHVybiB0by5zbGljZSh0b1N0YXJ0ICsgaSArIDEpO1xuICAgICAgICB9IGVsc2UgaWYgKGkgPT09IDApIHtcbiAgICAgICAgICAvLyBXZSBnZXQgaGVyZSBpZiBgZnJvbWAgaXMgdGhlIHJvb3RcbiAgICAgICAgICAvLyBGb3IgZXhhbXBsZTogZnJvbT0nLyc7IHRvPScvZm9vJ1xuICAgICAgICAgIHJldHVybiB0by5zbGljZSh0b1N0YXJ0ICsgaSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoZnJvbUxlbiA+IGxlbmd0aCkge1xuICAgICAgICBpZiAoaXNQb3NpeFBhdGhTZXBhcmF0b3IoZnJvbS5jaGFyQ29kZUF0KGZyb21TdGFydCArIGkpKSkge1xuICAgICAgICAgIC8vIFdlIGdldCBoZXJlIGlmIGB0b2AgaXMgdGhlIGV4YWN0IGJhc2UgcGF0aCBmb3IgYGZyb21gLlxuICAgICAgICAgIC8vIEZvciBleGFtcGxlOiBmcm9tPScvZm9vL2Jhci9iYXonOyB0bz0nL2Zvby9iYXInXG4gICAgICAgICAgbGFzdENvbW1vblNlcCA9IGk7XG4gICAgICAgIH0gZWxzZSBpZiAoaSA9PT0gMCkge1xuICAgICAgICAgIC8vIFdlIGdldCBoZXJlIGlmIGB0b2AgaXMgdGhlIHJvb3QuXG4gICAgICAgICAgLy8gRm9yIGV4YW1wbGU6IGZyb209Jy9mb28nOyB0bz0nLydcbiAgICAgICAgICBsYXN0Q29tbW9uU2VwID0gMDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNvbnN0IGZyb21Db2RlID0gZnJvbS5jaGFyQ29kZUF0KGZyb21TdGFydCArIGkpO1xuICAgIGNvbnN0IHRvQ29kZSA9IHRvLmNoYXJDb2RlQXQodG9TdGFydCArIGkpO1xuICAgIGlmIChmcm9tQ29kZSAhPT0gdG9Db2RlKSBicmVhaztcbiAgICBlbHNlIGlmIChpc1Bvc2l4UGF0aFNlcGFyYXRvcihmcm9tQ29kZSkpIGxhc3RDb21tb25TZXAgPSBpO1xuICB9XG5cbiAgbGV0IG91dCA9IFwiXCI7XG4gIC8vIEdlbmVyYXRlIHRoZSByZWxhdGl2ZSBwYXRoIGJhc2VkIG9uIHRoZSBwYXRoIGRpZmZlcmVuY2UgYmV0d2VlbiBgdG9gXG4gIC8vIGFuZCBgZnJvbWBcbiAgZm9yIChpID0gZnJvbVN0YXJ0ICsgbGFzdENvbW1vblNlcCArIDE7IGkgPD0gZnJvbUVuZDsgKytpKSB7XG4gICAgaWYgKGkgPT09IGZyb21FbmQgfHwgaXNQb3NpeFBhdGhTZXBhcmF0b3IoZnJvbS5jaGFyQ29kZUF0KGkpKSkge1xuICAgICAgaWYgKG91dC5sZW5ndGggPT09IDApIG91dCArPSBcIi4uXCI7XG4gICAgICBlbHNlIG91dCArPSBcIi8uLlwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIExhc3RseSwgYXBwZW5kIHRoZSByZXN0IG9mIHRoZSBkZXN0aW5hdGlvbiAoYHRvYCkgcGF0aCB0aGF0IGNvbWVzIGFmdGVyXG4gIC8vIHRoZSBjb21tb24gcGF0aCBwYXJ0c1xuICBpZiAob3V0Lmxlbmd0aCA+IDApIHJldHVybiBvdXQgKyB0by5zbGljZSh0b1N0YXJ0ICsgbGFzdENvbW1vblNlcCk7XG4gIGVsc2Uge1xuICAgIHRvU3RhcnQgKz0gbGFzdENvbW1vblNlcDtcbiAgICBpZiAoaXNQb3NpeFBhdGhTZXBhcmF0b3IodG8uY2hhckNvZGVBdCh0b1N0YXJ0KSkpICsrdG9TdGFydDtcbiAgICByZXR1cm4gdG8uc2xpY2UodG9TdGFydCk7XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsb0JBQW9C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
// denoCacheMetadata=6831794663784510560,3568362413281465455