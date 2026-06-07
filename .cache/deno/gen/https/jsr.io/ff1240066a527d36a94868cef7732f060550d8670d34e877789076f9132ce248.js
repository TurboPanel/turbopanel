// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
/**
 * Test whether the given string is a glob.
 *
 * @example Usage
 * ```ts
 * import { isGlob } from "@std/path/is-glob";
 * import { assert } from "@std/assert";
 *
 * assert(!isGlob("foo/bar/../baz"));
 * assert(isGlob("foo/*ar/../baz"));
 * ```
 *
 * @param str String to test.
 * @returns `true` if the given string is a glob, otherwise `false`
 */ export function isGlob(str) {
  const chars = {
    "{": "}",
    "(": ")",
    "[": "]"
  };
  const regex = /\\(.)|(^!|\*|\?|[\].+)]\?|\[[^[\\\]]+\]|\{[^{\\}]+\}|\(\?[:!=][^\\)]+\)|\([^(|]+\|[^\\)]+\)|@\([^)]+\))/;
  if (str === "") {
    return false;
  }
  let match;
  while(match = regex.exec(str)){
    if (match[2]) return true;
    let idx = match.index + match[0].length;
    // if an open bracket/brace/paren is escaped,
    // set the index to the next closing character
    const open = match[1];
    const close = open ? chars[open] : null;
    if (open && close) {
      const n = str.indexOf(close, idx);
      if (n !== -1) {
        idx = n + 1;
      }
    }
    str = str.slice(idx);
  }
  return false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9pc19nbG9iLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbi8qKlxuICogVGVzdCB3aGV0aGVyIHRoZSBnaXZlbiBzdHJpbmcgaXMgYSBnbG9iLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgaXNHbG9iIH0gZnJvbSBcIkBzdGQvcGF0aC9pcy1nbG9iXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnQgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnQoIWlzR2xvYihcImZvby9iYXIvLi4vYmF6XCIpKTtcbiAqIGFzc2VydChpc0dsb2IoXCJmb28vKmFyLy4uL2JhelwiKSk7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gc3RyIFN0cmluZyB0byB0ZXN0LlxuICogQHJldHVybnMgYHRydWVgIGlmIHRoZSBnaXZlbiBzdHJpbmcgaXMgYSBnbG9iLCBvdGhlcndpc2UgYGZhbHNlYFxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNHbG9iKHN0cjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGNoYXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBcIntcIjogXCJ9XCIsIFwiKFwiOiBcIilcIiwgXCJbXCI6IFwiXVwiIH07XG4gIGNvbnN0IHJlZ2V4ID1cbiAgICAvXFxcXCguKXwoXiF8XFwqfFxcP3xbXFxdLispXVxcP3xcXFtbXltcXFxcXFxdXStcXF18XFx7W157XFxcXH1dK1xcfXxcXChcXD9bOiE9XVteXFxcXCldK1xcKXxcXChbXih8XStcXHxbXlxcXFwpXStcXCl8QFxcKFteKV0rXFwpKS87XG5cbiAgaWYgKHN0ciA9PT0gXCJcIikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcblxuICB3aGlsZSAoKG1hdGNoID0gcmVnZXguZXhlYyhzdHIpKSkge1xuICAgIGlmIChtYXRjaFsyXSkgcmV0dXJuIHRydWU7XG4gICAgbGV0IGlkeCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuXG4gICAgLy8gaWYgYW4gb3BlbiBicmFja2V0L2JyYWNlL3BhcmVuIGlzIGVzY2FwZWQsXG4gICAgLy8gc2V0IHRoZSBpbmRleCB0byB0aGUgbmV4dCBjbG9zaW5nIGNoYXJhY3RlclxuICAgIGNvbnN0IG9wZW4gPSBtYXRjaFsxXTtcbiAgICBjb25zdCBjbG9zZSA9IG9wZW4gPyBjaGFyc1tvcGVuXSA6IG51bGw7XG4gICAgaWYgKG9wZW4gJiYgY2xvc2UpIHtcbiAgICAgIGNvbnN0IG4gPSBzdHIuaW5kZXhPZihjbG9zZSwgaWR4KTtcbiAgICAgIGlmIChuICE9PSAtMSkge1xuICAgICAgICBpZHggPSBuICsgMTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzdHIgPSBzdHIuc2xpY2UoaWR4KTtcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsT0FBTyxTQUFTLE9BQU8sR0FBVztFQUNoQyxNQUFNLFFBQWdDO0lBQUUsS0FBSztJQUFLLEtBQUs7SUFBSyxLQUFLO0VBQUk7RUFDckUsTUFBTSxRQUNKO0VBRUYsSUFBSSxRQUFRLElBQUk7SUFDZCxPQUFPO0VBQ1Q7RUFFQSxJQUFJO0VBRUosTUFBUSxRQUFRLE1BQU0sSUFBSSxDQUFDLEtBQU87SUFDaEMsSUFBSSxLQUFLLENBQUMsRUFBRSxFQUFFLE9BQU87SUFDckIsSUFBSSxNQUFNLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxFQUFFLENBQUMsTUFBTTtJQUV2Qyw2Q0FBNkM7SUFDN0MsOENBQThDO0lBQzlDLE1BQU0sT0FBTyxLQUFLLENBQUMsRUFBRTtJQUNyQixNQUFNLFFBQVEsT0FBTyxLQUFLLENBQUMsS0FBSyxHQUFHO0lBQ25DLElBQUksUUFBUSxPQUFPO01BQ2pCLE1BQU0sSUFBSSxJQUFJLE9BQU8sQ0FBQyxPQUFPO01BQzdCLElBQUksTUFBTSxDQUFDLEdBQUc7UUFDWixNQUFNLElBQUk7TUFDWjtJQUNGO0lBRUEsTUFBTSxJQUFJLEtBQUssQ0FBQztFQUNsQjtFQUVBLE9BQU87QUFDVCJ9
// denoCacheMetadata=6961498100465483436,7844141512920272290