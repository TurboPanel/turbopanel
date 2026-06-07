// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { normalize } from "./normalize.ts";
import { SEPARATOR_PATTERN } from "./constants.ts";
/**
 * Like normalize(), but doesn't collapse "**\/.." when `globstar` is true.
 *
 * @example Usage
 * ```ts
 * import { normalizeGlob } from "@std/path/posix/normalize-glob";
 * import { assertEquals } from "@std/assert";
 *
 * const path = normalizeGlob("foo/bar/../*", { globstar: true });
 * assertEquals(path, "foo/*");
 * ```
 *
 * @param glob The glob to normalize.
 * @param options The options to use.
 * @returns The normalized path.
 */ export function normalizeGlob(glob, options = {}) {
  const { globstar = false } = options;
  if (glob.match(/\0/g)) {
    throw new Error(`Glob contains invalid characters: "${glob}"`);
  }
  if (!globstar) {
    return normalize(glob);
  }
  const s = SEPARATOR_PATTERN.source;
  const badParentPattern = new RegExp(`(?<=(${s}|^)\\*\\*${s})\\.\\.(?=${s}|$)`, "g");
  return normalize(glob.replace(badParentPattern, "\0")).replace(/\0/g, "..");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9ub3JtYWxpemVfZ2xvYi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgdHlwZSB7IEdsb2JPcHRpb25zIH0gZnJvbSBcIi4uL19jb21tb24vZ2xvYl90b19yZWdfZXhwLnRzXCI7XG5pbXBvcnQgeyBub3JtYWxpemUgfSBmcm9tIFwiLi9ub3JtYWxpemUudHNcIjtcbmltcG9ydCB7IFNFUEFSQVRPUl9QQVRURVJOIH0gZnJvbSBcIi4vY29uc3RhbnRzLnRzXCI7XG5cbmV4cG9ydCB0eXBlIHsgR2xvYk9wdGlvbnMgfTtcblxuLyoqXG4gKiBMaWtlIG5vcm1hbGl6ZSgpLCBidXQgZG9lc24ndCBjb2xsYXBzZSBcIioqXFwvLi5cIiB3aGVuIGBnbG9ic3RhcmAgaXMgdHJ1ZS5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IG5vcm1hbGl6ZUdsb2IgfSBmcm9tIFwiQHN0ZC9wYXRoL3Bvc2l4L25vcm1hbGl6ZS1nbG9iXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCBwYXRoID0gbm9ybWFsaXplR2xvYihcImZvby9iYXIvLi4vKlwiLCB7IGdsb2JzdGFyOiB0cnVlIH0pO1xuICogYXNzZXJ0RXF1YWxzKHBhdGgsIFwiZm9vLypcIik7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gZ2xvYiBUaGUgZ2xvYiB0byBub3JtYWxpemUuXG4gKiBAcGFyYW0gb3B0aW9ucyBUaGUgb3B0aW9ucyB0byB1c2UuXG4gKiBAcmV0dXJucyBUaGUgbm9ybWFsaXplZCBwYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplR2xvYihcbiAgZ2xvYjogc3RyaW5nLFxuICBvcHRpb25zOiBQaWNrPEdsb2JPcHRpb25zLCBcImdsb2JzdGFyXCI+ID0ge30sXG4pOiBzdHJpbmcge1xuICBjb25zdCB7IGdsb2JzdGFyID0gZmFsc2UgfTogR2xvYk9wdGlvbnMgPSBvcHRpb25zO1xuICBpZiAoZ2xvYi5tYXRjaCgvXFwwL2cpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBHbG9iIGNvbnRhaW5zIGludmFsaWQgY2hhcmFjdGVyczogXCIke2dsb2J9XCJgKTtcbiAgfVxuICBpZiAoIWdsb2JzdGFyKSB7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZShnbG9iKTtcbiAgfVxuICBjb25zdCBzID0gU0VQQVJBVE9SX1BBVFRFUk4uc291cmNlO1xuICBjb25zdCBiYWRQYXJlbnRQYXR0ZXJuID0gbmV3IFJlZ0V4cChcbiAgICBgKD88PSgke3N9fF4pXFxcXCpcXFxcKiR7c30pXFxcXC5cXFxcLig/PSR7c318JClgLFxuICAgIFwiZ1wiLFxuICApO1xuICByZXR1cm4gbm9ybWFsaXplKGdsb2IucmVwbGFjZShiYWRQYXJlbnRQYXR0ZXJuLCBcIlxcMFwiKSkucmVwbGFjZSgvXFwwL2csIFwiLi5cIik7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUdyQyxTQUFTLFNBQVMsUUFBUSxpQkFBaUI7QUFDM0MsU0FBUyxpQkFBaUIsUUFBUSxpQkFBaUI7QUFJbkQ7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBQ0QsT0FBTyxTQUFTLGNBQ2QsSUFBWSxFQUNaLFVBQXlDLENBQUMsQ0FBQztFQUUzQyxNQUFNLEVBQUUsV0FBVyxLQUFLLEVBQUUsR0FBZ0I7RUFDMUMsSUFBSSxLQUFLLEtBQUssQ0FBQyxRQUFRO0lBQ3JCLE1BQU0sSUFBSSxNQUFNLENBQUMsbUNBQW1DLEVBQUUsS0FBSyxDQUFDLENBQUM7RUFDL0Q7RUFDQSxJQUFJLENBQUMsVUFBVTtJQUNiLE9BQU8sVUFBVTtFQUNuQjtFQUNBLE1BQU0sSUFBSSxrQkFBa0IsTUFBTTtFQUNsQyxNQUFNLG1CQUFtQixJQUFJLE9BQzNCLENBQUMsS0FBSyxFQUFFLEVBQUUsU0FBUyxFQUFFLEVBQUUsVUFBVSxFQUFFLEVBQUUsR0FBRyxDQUFDLEVBQ3pDO0VBRUYsT0FBTyxVQUFVLEtBQUssT0FBTyxDQUFDLGtCQUFrQixPQUFPLE9BQU8sQ0FBQyxPQUFPO0FBQ3hFIn0=
// denoCacheMetadata=13331841179395087253,2708806526259549177