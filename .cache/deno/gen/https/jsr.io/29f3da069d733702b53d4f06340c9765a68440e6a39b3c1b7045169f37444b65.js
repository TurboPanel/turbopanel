// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertArgs, lastPathSegment, stripSuffix } from "../_common/basename.ts";
import { fromFileUrl } from "./from_file_url.ts";
import { stripTrailingSeparators } from "../_common/strip_trailing_separators.ts";
import { isPosixPathSeparator } from "./_util.ts";
/**
 * Return the last portion of a `path`.
 * Trailing directory separators are ignored, and optional suffix is removed.
 *
 * @example Usage
 * ```ts
 * import { basename } from "@std/path/posix/basename";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(basename("/home/user/Documents/"), "Documents");
 * assertEquals(basename("/home/user/Documents/image.png"), "image.png");
 * assertEquals(basename("/home/user/Documents/image.png", ".png"), "image");
 * assertEquals(basename(new URL("file:///home/user/Documents/image.png")), "image.png");
 * assertEquals(basename(new URL("file:///home/user/Documents/image.png"), ".png"), "image");
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
 * import { basename } from "@std/path/posix/basename";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(basename("https://deno.land/std/path/mod.ts"), "mod.ts");
 * assertEquals(basename("https://deno.land/std/path/mod.ts", ".ts"), "mod");
 * assertEquals(basename("https://deno.land/std/path/mod.ts?a=b"), "mod.ts?a=b");
 * assertEquals(basename("https://deno.land/std/path/mod.ts#header"), "mod.ts#header");
 * assertEquals(basename(new URL("https://deno.land/std/path/mod.ts").pathname), "mod.ts");
 * ```
 *
 * @param path The path to extract the name from.
 * @param suffix The suffix to remove from extracted name.
 * @returns The extracted name.
 * @throws {TypeError} If `path` is a `URL` instance whose protocol is not `file:`.
 */ export function basename(path, suffix = "") {
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  assertArgs(path, suffix);
  const lastSegment = lastPathSegment(path, isPosixPathSeparator);
  const strippedSegment = stripTrailingSeparators(lastSegment, isPosixPathSeparator);
  return suffix ? stripSuffix(strippedSegment, suffix) : strippedSegment;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9wb3NpeC9iYXNlbmFtZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQge1xuICBhc3NlcnRBcmdzLFxuICBsYXN0UGF0aFNlZ21lbnQsXG4gIHN0cmlwU3VmZml4LFxufSBmcm9tIFwiLi4vX2NvbW1vbi9iYXNlbmFtZS50c1wiO1xuaW1wb3J0IHsgZnJvbUZpbGVVcmwgfSBmcm9tIFwiLi9mcm9tX2ZpbGVfdXJsLnRzXCI7XG5pbXBvcnQgeyBzdHJpcFRyYWlsaW5nU2VwYXJhdG9ycyB9IGZyb20gXCIuLi9fY29tbW9uL3N0cmlwX3RyYWlsaW5nX3NlcGFyYXRvcnMudHNcIjtcbmltcG9ydCB7IGlzUG9zaXhQYXRoU2VwYXJhdG9yIH0gZnJvbSBcIi4vX3V0aWwudHNcIjtcblxuLyoqXG4gKiBSZXR1cm4gdGhlIGxhc3QgcG9ydGlvbiBvZiBhIGBwYXRoYC5cbiAqIFRyYWlsaW5nIGRpcmVjdG9yeSBzZXBhcmF0b3JzIGFyZSBpZ25vcmVkLCBhbmQgb3B0aW9uYWwgc3VmZml4IGlzIHJlbW92ZWQuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBiYXNlbmFtZSB9IGZyb20gXCJAc3RkL3BhdGgvcG9zaXgvYmFzZW5hbWVcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhiYXNlbmFtZShcIi9ob21lL3VzZXIvRG9jdW1lbnRzL1wiKSwgXCJEb2N1bWVudHNcIik7XG4gKiBhc3NlcnRFcXVhbHMoYmFzZW5hbWUoXCIvaG9tZS91c2VyL0RvY3VtZW50cy9pbWFnZS5wbmdcIiksIFwiaW1hZ2UucG5nXCIpO1xuICogYXNzZXJ0RXF1YWxzKGJhc2VuYW1lKFwiL2hvbWUvdXNlci9Eb2N1bWVudHMvaW1hZ2UucG5nXCIsIFwiLnBuZ1wiKSwgXCJpbWFnZVwiKTtcbiAqIGFzc2VydEVxdWFscyhiYXNlbmFtZShuZXcgVVJMKFwiZmlsZTovLy9ob21lL3VzZXIvRG9jdW1lbnRzL2ltYWdlLnBuZ1wiKSksIFwiaW1hZ2UucG5nXCIpO1xuICogYXNzZXJ0RXF1YWxzKGJhc2VuYW1lKG5ldyBVUkwoXCJmaWxlOi8vL2hvbWUvdXNlci9Eb2N1bWVudHMvaW1hZ2UucG5nXCIpLCBcIi5wbmdcIiksIFwiaW1hZ2VcIik7XG4gKiBgYGBcbiAqXG4gKiBAZXhhbXBsZSBXb3JraW5nIHdpdGggVVJMc1xuICpcbiAqIE9ubHkgYFVSTGAgaW5zdGFuY2VzIHdpdGggdGhlIGBmaWxlOmAgcHJvdG9jb2wgYXJlIGFjY2VwdGVkLiBUbyBwcm9jZXNzIGFcbiAqIG5vbi1gZmlsZTpgIFVSTCwgcGFzcyBpdCBhcyBhIHN0cmluZyBvciBwYXNzIGl0cyBgcGF0aG5hbWVgIHByb3BlcnR5LlxuICpcbiAqIE5vdGU6IFRoaXMgZnVuY3Rpb24gZG9lc24ndCBhdXRvbWF0aWNhbGx5IHN0cmlwIGhhc2ggYW5kIHF1ZXJ5IHBhcnRzIGZyb21cbiAqIFVSTHMuIElmIHlvdXIgVVJMIGNvbnRhaW5zIGEgaGFzaCBvciBxdWVyeSwgcmVtb3ZlIHRoZW0gYmVmb3JlIHBhc3NpbmcgdGhlXG4gKiBVUkwgdG8gdGhlIGZ1bmN0aW9uLiBUaGlzIGNhbiBiZSBkb25lIGJ5IHBhc3NpbmcgdGhlIFVSTCB0byBgbmV3IFVSTCh1cmwpYCxcbiAqIGFuZCBzZXR0aW5nIHRoZSBgaGFzaGAgYW5kIGBzZWFyY2hgIHByb3BlcnRpZXMgdG8gZW1wdHkgc3RyaW5ncy5cbiAqXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgYmFzZW5hbWUgfSBmcm9tIFwiQHN0ZC9wYXRoL3Bvc2l4L2Jhc2VuYW1lXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRFcXVhbHMoYmFzZW5hbWUoXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvcGF0aC9tb2QudHNcIiksIFwibW9kLnRzXCIpO1xuICogYXNzZXJ0RXF1YWxzKGJhc2VuYW1lKFwiaHR0cHM6Ly9kZW5vLmxhbmQvc3RkL3BhdGgvbW9kLnRzXCIsIFwiLnRzXCIpLCBcIm1vZFwiKTtcbiAqIGFzc2VydEVxdWFscyhiYXNlbmFtZShcImh0dHBzOi8vZGVuby5sYW5kL3N0ZC9wYXRoL21vZC50cz9hPWJcIiksIFwibW9kLnRzP2E9YlwiKTtcbiAqIGFzc2VydEVxdWFscyhiYXNlbmFtZShcImh0dHBzOi8vZGVuby5sYW5kL3N0ZC9wYXRoL21vZC50cyNoZWFkZXJcIiksIFwibW9kLnRzI2hlYWRlclwiKTtcbiAqIGFzc2VydEVxdWFscyhiYXNlbmFtZShuZXcgVVJMKFwiaHR0cHM6Ly9kZW5vLmxhbmQvc3RkL3BhdGgvbW9kLnRzXCIpLnBhdGhuYW1lKSwgXCJtb2QudHNcIik7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gcGF0aCBUaGUgcGF0aCB0byBleHRyYWN0IHRoZSBuYW1lIGZyb20uXG4gKiBAcGFyYW0gc3VmZml4IFRoZSBzdWZmaXggdG8gcmVtb3ZlIGZyb20gZXh0cmFjdGVkIG5hbWUuXG4gKiBAcmV0dXJucyBUaGUgZXh0cmFjdGVkIG5hbWUuXG4gKiBAdGhyb3dzIHtUeXBlRXJyb3J9IElmIGBwYXRoYCBpcyBhIGBVUkxgIGluc3RhbmNlIHdob3NlIHByb3RvY29sIGlzIG5vdCBgZmlsZTpgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYmFzZW5hbWUocGF0aDogc3RyaW5nIHwgVVJMLCBzdWZmaXggPSBcIlwiKTogc3RyaW5nIHtcbiAgaWYgKHBhdGggaW5zdGFuY2VvZiBVUkwpIHtcbiAgICBwYXRoID0gZnJvbUZpbGVVcmwocGF0aCk7XG4gIH1cbiAgYXNzZXJ0QXJncyhwYXRoLCBzdWZmaXgpO1xuXG4gIGNvbnN0IGxhc3RTZWdtZW50ID0gbGFzdFBhdGhTZWdtZW50KHBhdGgsIGlzUG9zaXhQYXRoU2VwYXJhdG9yKTtcbiAgY29uc3Qgc3RyaXBwZWRTZWdtZW50ID0gc3RyaXBUcmFpbGluZ1NlcGFyYXRvcnMoXG4gICAgbGFzdFNlZ21lbnQsXG4gICAgaXNQb3NpeFBhdGhTZXBhcmF0b3IsXG4gICk7XG4gIHJldHVybiBzdWZmaXggPyBzdHJpcFN1ZmZpeChzdHJpcHBlZFNlZ21lbnQsIHN1ZmZpeCkgOiBzdHJpcHBlZFNlZ21lbnQ7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUNFLFVBQVUsRUFDVixlQUFlLEVBQ2YsV0FBVyxRQUNOLHlCQUF5QjtBQUNoQyxTQUFTLFdBQVcsUUFBUSxxQkFBcUI7QUFDakQsU0FBUyx1QkFBdUIsUUFBUSwwQ0FBMEM7QUFDbEYsU0FBUyxvQkFBb0IsUUFBUSxhQUFhO0FBRWxEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXlDQyxHQUNELE9BQU8sU0FBUyxTQUFTLElBQWtCLEVBQUUsU0FBUyxFQUFFO0VBQ3RELElBQUksZ0JBQWdCLEtBQUs7SUFDdkIsT0FBTyxZQUFZO0VBQ3JCO0VBQ0EsV0FBVyxNQUFNO0VBRWpCLE1BQU0sY0FBYyxnQkFBZ0IsTUFBTTtFQUMxQyxNQUFNLGtCQUFrQix3QkFDdEIsYUFDQTtFQUVGLE9BQU8sU0FBUyxZQUFZLGlCQUFpQixVQUFVO0FBQ3pEIn0=
// denoCacheMetadata=9981268318291679020,16945185199882698859