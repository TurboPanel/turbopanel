// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { join } from "./join.ts";
import { SEPARATOR } from "./constants.ts";
import { normalizeGlob } from "./normalize_glob.ts";
/**
 * Like join(), but doesn't collapse "**\/.." when `globstar` is true.
 *
 * @example Usage
 *
 * ```ts
 * import { joinGlobs } from "@std/path/windows/join-globs";
 * import { assertEquals } from "@std/assert";
 *
 * const joined = joinGlobs(["foo", "**", "bar"], { globstar: true });
 * assertEquals(joined, "foo\\**\\bar");
 * ```
 *
 * @param globs The globs to join.
 * @param options The options for glob pattern.
 * @returns The joined glob pattern.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL2pvaW5fZ2xvYnMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHR5cGUgeyBHbG9iT3B0aW9ucyB9IGZyb20gXCIuLi9fY29tbW9uL2dsb2JfdG9fcmVnX2V4cC50c1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCIuL2pvaW4udHNcIjtcbmltcG9ydCB7IFNFUEFSQVRPUiB9IGZyb20gXCIuL2NvbnN0YW50cy50c1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplR2xvYiB9IGZyb20gXCIuL25vcm1hbGl6ZV9nbG9iLnRzXCI7XG5cbmV4cG9ydCB0eXBlIHsgR2xvYk9wdGlvbnMgfTtcblxuLyoqXG4gKiBMaWtlIGpvaW4oKSwgYnV0IGRvZXNuJ3QgY29sbGFwc2UgXCIqKlxcLy4uXCIgd2hlbiBgZ2xvYnN0YXJgIGlzIHRydWUuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgam9pbkdsb2JzIH0gZnJvbSBcIkBzdGQvcGF0aC93aW5kb3dzL2pvaW4tZ2xvYnNcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGNvbnN0IGpvaW5lZCA9IGpvaW5HbG9icyhbXCJmb29cIiwgXCIqKlwiLCBcImJhclwiXSwgeyBnbG9ic3RhcjogdHJ1ZSB9KTtcbiAqIGFzc2VydEVxdWFscyhqb2luZWQsIFwiZm9vXFxcXCoqXFxcXGJhclwiKTtcbiAqIGBgYFxuICpcbiAqIEBwYXJhbSBnbG9icyBUaGUgZ2xvYnMgdG8gam9pbi5cbiAqIEBwYXJhbSBvcHRpb25zIFRoZSBvcHRpb25zIGZvciBnbG9iIHBhdHRlcm4uXG4gKiBAcmV0dXJucyBUaGUgam9pbmVkIGdsb2IgcGF0dGVybi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGpvaW5HbG9icyhcbiAgZ2xvYnM6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBQaWNrPEdsb2JPcHRpb25zLCBcImdsb2JzdGFyXCI+ID0ge30sXG4pOiBzdHJpbmcge1xuICBjb25zdCB7IGdsb2JzdGFyID0gZmFsc2UgfSA9IG9wdGlvbnM7XG4gIGlmICghZ2xvYnN0YXIgfHwgZ2xvYnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIGpvaW4oLi4uZ2xvYnMpO1xuICB9XG4gIGxldCBqb2luZWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgZm9yIChjb25zdCBnbG9iIG9mIGdsb2JzKSB7XG4gICAgY29uc3QgcGF0aCA9IGdsb2I7XG4gICAgaWYgKHBhdGgubGVuZ3RoID4gMCkge1xuICAgICAgaWYgKCFqb2luZWQpIGpvaW5lZCA9IHBhdGg7XG4gICAgICBlbHNlIGpvaW5lZCArPSBgJHtTRVBBUkFUT1J9JHtwYXRofWA7XG4gICAgfVxuICB9XG4gIGlmICgham9pbmVkKSByZXR1cm4gXCIuXCI7XG4gIHJldHVybiBub3JtYWxpemVHbG9iKGpvaW5lZCwgeyBnbG9ic3RhciB9KTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBR3JDLFNBQVMsSUFBSSxRQUFRLFlBQVk7QUFDakMsU0FBUyxTQUFTLFFBQVEsaUJBQWlCO0FBQzNDLFNBQVMsYUFBYSxRQUFRLHNCQUFzQjtBQUlwRDs7Ozs7Ozs7Ozs7Ozs7OztDQWdCQyxHQUNELE9BQU8sU0FBUyxVQUNkLEtBQWUsRUFDZixVQUF5QyxDQUFDLENBQUM7RUFFM0MsTUFBTSxFQUFFLFdBQVcsS0FBSyxFQUFFLEdBQUc7RUFDN0IsSUFBSSxDQUFDLFlBQVksTUFBTSxNQUFNLEtBQUssR0FBRztJQUNuQyxPQUFPLFFBQVE7RUFDakI7RUFDQSxJQUFJO0VBQ0osS0FBSyxNQUFNLFFBQVEsTUFBTztJQUN4QixNQUFNLE9BQU87SUFDYixJQUFJLEtBQUssTUFBTSxHQUFHLEdBQUc7TUFDbkIsSUFBSSxDQUFDLFFBQVEsU0FBUztXQUNqQixVQUFVLEdBQUcsWUFBWSxNQUFNO0lBQ3RDO0VBQ0Y7RUFDQSxJQUFJLENBQUMsUUFBUSxPQUFPO0VBQ3BCLE9BQU8sY0FBYyxRQUFRO0lBQUU7RUFBUztBQUMxQyJ9
// denoCacheMetadata=4568548573027943905,13305916013647905669