// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertArgs, lastPathSegment, stripSuffix } from "../_common/basename.ts";
import { CHAR_COLON } from "../_common/constants.ts";
import { stripTrailingSeparators } from "../_common/strip_trailing_separators.ts";
import { isPathSeparator, isWindowsDeviceRoot } from "./_util.ts";
import { fromFileUrl } from "./from_file_url.ts";
/**
 * Return the last portion of a `path`.
 * Trailing directory separators are ignored, and optional suffix is removed.
 *
 * @example Usage
 * ```ts
 * import { basename } from "@std/path/windows/basename";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(basename("C:\\user\\Documents\\"), "Documents");
 * assertEquals(basename("C:\\user\\Documents\\image.png"), "image.png");
 * assertEquals(basename("C:\\user\\Documents\\image.png", ".png"), "image");
 * assertEquals(basename(new URL("file:///C:/user/Documents/image.png")), "image.png");
 * assertEquals(basename(new URL("file:///C:/user/Documents/image.png"), ".png"), "image");
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
  // Check for a drive letter prefix so as not to mistake the following
  // path separator as an extra separator at the end of the path that can be
  // disregarded
  let start = 0;
  if (path.length >= 2) {
    const drive = path.charCodeAt(0);
    if (isWindowsDeviceRoot(drive)) {
      if (path.charCodeAt(1) === CHAR_COLON) start = 2;
    }
  }
  const lastSegment = lastPathSegment(path, isPathSeparator, start);
  const strippedSegment = stripTrailingSeparators(lastSegment, isPathSeparator);
  return suffix ? stripSuffix(strippedSegment, suffix) : strippedSegment;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL2Jhc2VuYW1lLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB7XG4gIGFzc2VydEFyZ3MsXG4gIGxhc3RQYXRoU2VnbWVudCxcbiAgc3RyaXBTdWZmaXgsXG59IGZyb20gXCIuLi9fY29tbW9uL2Jhc2VuYW1lLnRzXCI7XG5pbXBvcnQgeyBDSEFSX0NPTE9OIH0gZnJvbSBcIi4uL19jb21tb24vY29uc3RhbnRzLnRzXCI7XG5pbXBvcnQgeyBzdHJpcFRyYWlsaW5nU2VwYXJhdG9ycyB9IGZyb20gXCIuLi9fY29tbW9uL3N0cmlwX3RyYWlsaW5nX3NlcGFyYXRvcnMudHNcIjtcbmltcG9ydCB7IGlzUGF0aFNlcGFyYXRvciwgaXNXaW5kb3dzRGV2aWNlUm9vdCB9IGZyb20gXCIuL191dGlsLnRzXCI7XG5pbXBvcnQgeyBmcm9tRmlsZVVybCB9IGZyb20gXCIuL2Zyb21fZmlsZV91cmwudHNcIjtcblxuLyoqXG4gKiBSZXR1cm4gdGhlIGxhc3QgcG9ydGlvbiBvZiBhIGBwYXRoYC5cbiAqIFRyYWlsaW5nIGRpcmVjdG9yeSBzZXBhcmF0b3JzIGFyZSBpZ25vcmVkLCBhbmQgb3B0aW9uYWwgc3VmZml4IGlzIHJlbW92ZWQuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBiYXNlbmFtZSB9IGZyb20gXCJAc3RkL3BhdGgvd2luZG93cy9iYXNlbmFtZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKGJhc2VuYW1lKFwiQzpcXFxcdXNlclxcXFxEb2N1bWVudHNcXFxcXCIpLCBcIkRvY3VtZW50c1wiKTtcbiAqIGFzc2VydEVxdWFscyhiYXNlbmFtZShcIkM6XFxcXHVzZXJcXFxcRG9jdW1lbnRzXFxcXGltYWdlLnBuZ1wiKSwgXCJpbWFnZS5wbmdcIik7XG4gKiBhc3NlcnRFcXVhbHMoYmFzZW5hbWUoXCJDOlxcXFx1c2VyXFxcXERvY3VtZW50c1xcXFxpbWFnZS5wbmdcIiwgXCIucG5nXCIpLCBcImltYWdlXCIpO1xuICogYXNzZXJ0RXF1YWxzKGJhc2VuYW1lKG5ldyBVUkwoXCJmaWxlOi8vL0M6L3VzZXIvRG9jdW1lbnRzL2ltYWdlLnBuZ1wiKSksIFwiaW1hZ2UucG5nXCIpO1xuICogYXNzZXJ0RXF1YWxzKGJhc2VuYW1lKG5ldyBVUkwoXCJmaWxlOi8vL0M6L3VzZXIvRG9jdW1lbnRzL2ltYWdlLnBuZ1wiKSwgXCIucG5nXCIpLCBcImltYWdlXCIpO1xuICogYGBgXG4gKlxuICogQHBhcmFtIHBhdGggVGhlIHBhdGggdG8gZXh0cmFjdCB0aGUgbmFtZSBmcm9tLlxuICogQHBhcmFtIHN1ZmZpeCBUaGUgc3VmZml4IHRvIHJlbW92ZSBmcm9tIGV4dHJhY3RlZCBuYW1lLlxuICogQHJldHVybnMgVGhlIGV4dHJhY3RlZCBuYW1lLlxuICogQHRocm93cyB7VHlwZUVycm9yfSBJZiBgcGF0aGAgaXMgYSBgVVJMYCBpbnN0YW5jZSB3aG9zZSBwcm90b2NvbCBpcyBub3QgYGZpbGU6YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJhc2VuYW1lKHBhdGg6IHN0cmluZyB8IFVSTCwgc3VmZml4ID0gXCJcIik6IHN0cmluZyB7XG4gIGlmIChwYXRoIGluc3RhbmNlb2YgVVJMKSB7XG4gICAgcGF0aCA9IGZyb21GaWxlVXJsKHBhdGgpO1xuICB9XG4gIGFzc2VydEFyZ3MocGF0aCwgc3VmZml4KTtcblxuICAvLyBDaGVjayBmb3IgYSBkcml2ZSBsZXR0ZXIgcHJlZml4IHNvIGFzIG5vdCB0byBtaXN0YWtlIHRoZSBmb2xsb3dpbmdcbiAgLy8gcGF0aCBzZXBhcmF0b3IgYXMgYW4gZXh0cmEgc2VwYXJhdG9yIGF0IHRoZSBlbmQgb2YgdGhlIHBhdGggdGhhdCBjYW4gYmVcbiAgLy8gZGlzcmVnYXJkZWRcbiAgbGV0IHN0YXJ0ID0gMDtcbiAgaWYgKHBhdGgubGVuZ3RoID49IDIpIHtcbiAgICBjb25zdCBkcml2ZSA9IHBhdGguY2hhckNvZGVBdCgwKTtcbiAgICBpZiAoaXNXaW5kb3dzRGV2aWNlUm9vdChkcml2ZSkpIHtcbiAgICAgIGlmIChwYXRoLmNoYXJDb2RlQXQoMSkgPT09IENIQVJfQ09MT04pIHN0YXJ0ID0gMjtcbiAgICB9XG4gIH1cblxuICBjb25zdCBsYXN0U2VnbWVudCA9IGxhc3RQYXRoU2VnbWVudChwYXRoLCBpc1BhdGhTZXBhcmF0b3IsIHN0YXJ0KTtcbiAgY29uc3Qgc3RyaXBwZWRTZWdtZW50ID0gc3RyaXBUcmFpbGluZ1NlcGFyYXRvcnMobGFzdFNlZ21lbnQsIGlzUGF0aFNlcGFyYXRvcik7XG4gIHJldHVybiBzdWZmaXggPyBzdHJpcFN1ZmZpeChzdHJpcHBlZFNlZ21lbnQsIHN1ZmZpeCkgOiBzdHJpcHBlZFNlZ21lbnQ7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUNFLFVBQVUsRUFDVixlQUFlLEVBQ2YsV0FBVyxRQUNOLHlCQUF5QjtBQUNoQyxTQUFTLFVBQVUsUUFBUSwwQkFBMEI7QUFDckQsU0FBUyx1QkFBdUIsUUFBUSwwQ0FBMEM7QUFDbEYsU0FBUyxlQUFlLEVBQUUsbUJBQW1CLFFBQVEsYUFBYTtBQUNsRSxTQUFTLFdBQVcsUUFBUSxxQkFBcUI7QUFFakQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBQ0QsT0FBTyxTQUFTLFNBQVMsSUFBa0IsRUFBRSxTQUFTLEVBQUU7RUFDdEQsSUFBSSxnQkFBZ0IsS0FBSztJQUN2QixPQUFPLFlBQVk7RUFDckI7RUFDQSxXQUFXLE1BQU07RUFFakIscUVBQXFFO0VBQ3JFLDBFQUEwRTtFQUMxRSxjQUFjO0VBQ2QsSUFBSSxRQUFRO0VBQ1osSUFBSSxLQUFLLE1BQU0sSUFBSSxHQUFHO0lBQ3BCLE1BQU0sUUFBUSxLQUFLLFVBQVUsQ0FBQztJQUM5QixJQUFJLG9CQUFvQixRQUFRO01BQzlCLElBQUksS0FBSyxVQUFVLENBQUMsT0FBTyxZQUFZLFFBQVE7SUFDakQ7RUFDRjtFQUVBLE1BQU0sY0FBYyxnQkFBZ0IsTUFBTSxpQkFBaUI7RUFDM0QsTUFBTSxrQkFBa0Isd0JBQXdCLGFBQWE7RUFDN0QsT0FBTyxTQUFTLFlBQVksaUJBQWlCLFVBQVU7QUFDekQifQ==
// denoCacheMetadata=2227149443820030049,17628541202645772037