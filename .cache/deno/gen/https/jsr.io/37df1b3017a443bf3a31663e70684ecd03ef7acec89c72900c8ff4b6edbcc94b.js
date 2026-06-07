// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { normalize } from "./normalize.ts";
import { SEPARATOR_PATTERN } from "./constants.ts";
/**
 * Like normalize(), but doesn't collapse "**\/.." when `globstar` is true.
 *
 * @example Usage
 * ```ts
 * import { normalizeGlob } from "@std/path/windows/normalize-glob";
 * import { assertEquals } from "@std/assert";
 *
 * const normalized = normalizeGlob("**\\foo\\..\\bar", { globstar: true });
 * assertEquals(normalized, "**\\bar");
 * ```
 *
 * @param glob The glob pattern to normalize.
 * @param options The options for glob pattern.
 * @returns The normalized glob pattern.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL25vcm1hbGl6ZV9nbG9iLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB0eXBlIHsgR2xvYk9wdGlvbnMgfSBmcm9tIFwiLi4vX2NvbW1vbi9nbG9iX3RvX3JlZ19leHAudHNcIjtcbmltcG9ydCB7IG5vcm1hbGl6ZSB9IGZyb20gXCIuL25vcm1hbGl6ZS50c1wiO1xuaW1wb3J0IHsgU0VQQVJBVE9SX1BBVFRFUk4gfSBmcm9tIFwiLi9jb25zdGFudHMudHNcIjtcblxuZXhwb3J0IHR5cGUgeyBHbG9iT3B0aW9ucyB9O1xuXG4vKipcbiAqIExpa2Ugbm9ybWFsaXplKCksIGJ1dCBkb2Vzbid0IGNvbGxhcHNlIFwiKipcXC8uLlwiIHdoZW4gYGdsb2JzdGFyYCBpcyB0cnVlLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgbm9ybWFsaXplR2xvYiB9IGZyb20gXCJAc3RkL3BhdGgvd2luZG93cy9ub3JtYWxpemUtZ2xvYlwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUdsb2IoXCIqKlxcXFxmb29cXFxcLi5cXFxcYmFyXCIsIHsgZ2xvYnN0YXI6IHRydWUgfSk7XG4gKiBhc3NlcnRFcXVhbHMobm9ybWFsaXplZCwgXCIqKlxcXFxiYXJcIik7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gZ2xvYiBUaGUgZ2xvYiBwYXR0ZXJuIHRvIG5vcm1hbGl6ZS5cbiAqIEBwYXJhbSBvcHRpb25zIFRoZSBvcHRpb25zIGZvciBnbG9iIHBhdHRlcm4uXG4gKiBAcmV0dXJucyBUaGUgbm9ybWFsaXplZCBnbG9iIHBhdHRlcm4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVHbG9iKFxuICBnbG9iOiBzdHJpbmcsXG4gIG9wdGlvbnM6IFBpY2s8R2xvYk9wdGlvbnMsIFwiZ2xvYnN0YXJcIj4gPSB7fSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHsgZ2xvYnN0YXIgPSBmYWxzZSB9OiBHbG9iT3B0aW9ucyA9IG9wdGlvbnM7XG4gIGlmIChnbG9iLm1hdGNoKC9cXDAvZykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEdsb2IgY29udGFpbnMgaW52YWxpZCBjaGFyYWN0ZXJzOiBcIiR7Z2xvYn1cImApO1xuICB9XG4gIGlmICghZ2xvYnN0YXIpIHtcbiAgICByZXR1cm4gbm9ybWFsaXplKGdsb2IpO1xuICB9XG4gIGNvbnN0IHMgPSBTRVBBUkFUT1JfUEFUVEVSTi5zb3VyY2U7XG4gIGNvbnN0IGJhZFBhcmVudFBhdHRlcm4gPSBuZXcgUmVnRXhwKFxuICAgIGAoPzw9KCR7c318XilcXFxcKlxcXFwqJHtzfSlcXFxcLlxcXFwuKD89JHtzfXwkKWAsXG4gICAgXCJnXCIsXG4gICk7XG4gIHJldHVybiBub3JtYWxpemUoZ2xvYi5yZXBsYWNlKGJhZFBhcmVudFBhdHRlcm4sIFwiXFwwXCIpKS5yZXBsYWNlKC9cXDAvZywgXCIuLlwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBR3JDLFNBQVMsU0FBUyxRQUFRLGlCQUFpQjtBQUMzQyxTQUFTLGlCQUFpQixRQUFRLGlCQUFpQjtBQUluRDs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FDRCxPQUFPLFNBQVMsY0FDZCxJQUFZLEVBQ1osVUFBeUMsQ0FBQyxDQUFDO0VBRTNDLE1BQU0sRUFBRSxXQUFXLEtBQUssRUFBRSxHQUFnQjtFQUMxQyxJQUFJLEtBQUssS0FBSyxDQUFDLFFBQVE7SUFDckIsTUFBTSxJQUFJLE1BQU0sQ0FBQyxtQ0FBbUMsRUFBRSxLQUFLLENBQUMsQ0FBQztFQUMvRDtFQUNBLElBQUksQ0FBQyxVQUFVO0lBQ2IsT0FBTyxVQUFVO0VBQ25CO0VBQ0EsTUFBTSxJQUFJLGtCQUFrQixNQUFNO0VBQ2xDLE1BQU0sbUJBQW1CLElBQUksT0FDM0IsQ0FBQyxLQUFLLEVBQUUsRUFBRSxTQUFTLEVBQUUsRUFBRSxVQUFVLEVBQUUsRUFBRSxHQUFHLENBQUMsRUFDekM7RUFFRixPQUFPLFVBQVUsS0FBSyxPQUFPLENBQUMsa0JBQWtCLE9BQU8sT0FBTyxDQUFDLE9BQU87QUFDeEUifQ==
// denoCacheMetadata=13482835913712329646,7233196966023137777