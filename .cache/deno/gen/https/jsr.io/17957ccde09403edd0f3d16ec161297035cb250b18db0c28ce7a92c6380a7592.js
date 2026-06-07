// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { join } from "./join.ts";
import { SEPARATOR } from "./constants.ts";
import { normalizeGlob } from "./normalize_glob.ts";
/**
 * Like join(), but doesn't collapse "**\/.." when `globstar` is true.
 *
 * @example Usage
 * ```ts
 * import { joinGlobs } from "@std/path/posix/join-globs";
 * import { assertEquals } from "@std/assert";
 *
 * const path = joinGlobs(["foo", "bar", "**"], { globstar: true });
 * assertEquals(path, "foo/bar/**");
 * ```
 *
 * @param globs The globs to join.
 * @param options The options to use.
 * @returns The joined path.
 */ export function joinGlobs(globs, options = {}) {
  const { globstar = false } = options;
  if (!globstar || globs.length === 0) {
    return join(...globs);
  }
  let joined;
  for (const glob of globs){
    const path = glob;
    if (path.length > 0) {
      if (!joined) joined = path;
      else joined += `${SEPARATOR}${path}`;
    }
  }
  if (!joined) return ".";
  return normalizeGlob(joined, {
    globstar
  });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9qb2luX2dsb2JzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB0eXBlIHsgR2xvYk9wdGlvbnMgfSBmcm9tIFwiLi4vX2NvbW1vbi9nbG9iX3RvX3JlZ19leHAudHNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwiLi9qb2luLnRzXCI7XG5pbXBvcnQgeyBTRVBBUkFUT1IgfSBmcm9tIFwiLi9jb25zdGFudHMudHNcIjtcbmltcG9ydCB7IG5vcm1hbGl6ZUdsb2IgfSBmcm9tIFwiLi9ub3JtYWxpemVfZ2xvYi50c1wiO1xuXG5leHBvcnQgdHlwZSB7IEdsb2JPcHRpb25zIH07XG5cbi8qKlxuICogTGlrZSBqb2luKCksIGJ1dCBkb2Vzbid0IGNvbGxhcHNlIFwiKipcXC8uLlwiIHdoZW4gYGdsb2JzdGFyYCBpcyB0cnVlLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgam9pbkdsb2JzIH0gZnJvbSBcIkBzdGQvcGF0aC9wb3NpeC9qb2luLWdsb2JzXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCBwYXRoID0gam9pbkdsb2JzKFtcImZvb1wiLCBcImJhclwiLCBcIioqXCJdLCB7IGdsb2JzdGFyOiB0cnVlIH0pO1xuICogYXNzZXJ0RXF1YWxzKHBhdGgsIFwiZm9vL2Jhci8qKlwiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBnbG9icyBUaGUgZ2xvYnMgdG8gam9pbi5cbiAqIEBwYXJhbSBvcHRpb25zIFRoZSBvcHRpb25zIHRvIHVzZS5cbiAqIEByZXR1cm5zIFRoZSBqb2luZWQgcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGpvaW5HbG9icyhcbiAgZ2xvYnM6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBQaWNrPEdsb2JPcHRpb25zLCBcImdsb2JzdGFyXCI+ID0ge30sXG4pOiBzdHJpbmcge1xuICBjb25zdCB7IGdsb2JzdGFyID0gZmFsc2UgfSA9IG9wdGlvbnM7XG4gIGlmICghZ2xvYnN0YXIgfHwgZ2xvYnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIGpvaW4oLi4uZ2xvYnMpO1xuICB9XG4gIGxldCBqb2luZWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgZm9yIChjb25zdCBnbG9iIG9mIGdsb2JzKSB7XG4gICAgY29uc3QgcGF0aCA9IGdsb2I7XG4gICAgaWYgKHBhdGgubGVuZ3RoID4gMCkge1xuICAgICAgaWYgKCFqb2luZWQpIGpvaW5lZCA9IHBhdGg7XG4gICAgICBlbHNlIGpvaW5lZCArPSBgJHtTRVBBUkFUT1J9JHtwYXRofWA7XG4gICAgfVxuICB9XG4gIGlmICgham9pbmVkKSByZXR1cm4gXCIuXCI7XG4gIHJldHVybiBub3JtYWxpemVHbG9iKGpvaW5lZCwgeyBnbG9ic3RhciB9KTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBR3JDLFNBQVMsSUFBSSxRQUFRLFlBQVk7QUFDakMsU0FBUyxTQUFTLFFBQVEsaUJBQWlCO0FBQzNDLFNBQVMsYUFBYSxRQUFRLHNCQUFzQjtBQUlwRDs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsVUFDZCxLQUFlLEVBQ2YsVUFBeUMsQ0FBQyxDQUFDO0VBRTNDLE1BQU0sRUFBRSxXQUFXLEtBQUssRUFBRSxHQUFHO0VBQzdCLElBQUksQ0FBQyxZQUFZLE1BQU0sTUFBTSxLQUFLLEdBQUc7SUFDbkMsT0FBTyxRQUFRO0VBQ2pCO0VBQ0EsSUFBSTtFQUNKLEtBQUssTUFBTSxRQUFRLE1BQU87SUFDeEIsTUFBTSxPQUFPO0lBQ2IsSUFBSSxLQUFLLE1BQU0sR0FBRyxHQUFHO01BQ25CLElBQUksQ0FBQyxRQUFRLFNBQVM7V0FDakIsVUFBVSxHQUFHLFlBQVksTUFBTTtJQUN0QztFQUNGO0VBQ0EsSUFBSSxDQUFDLFFBQVEsT0FBTztFQUNwQixPQUFPLGNBQWMsUUFBUTtJQUFFO0VBQVM7QUFDMUMifQ==
// denoCacheMetadata=7142250352310725904,12978323072173432440