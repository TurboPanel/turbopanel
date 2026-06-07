// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { basename as posixBasename } from "./posix/basename.ts";
import { basename as windowsBasename } from "./windows/basename.ts";
/**
 * Return the last portion of a path.
 *
 * The trailing directory separators are ignored, and optional suffix is
 * removed.
 *
 * @example Usage
 * ```ts
 * import { basename } from "@std/path/basename";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(basename("C:\\user\\Documents\\image.png"), "image.png");
 *   assertEquals(basename(new URL("file:///C:/user/Documents/image.png")), "image.png");
 * } else {
 *   assertEquals(basename("/home/user/Documents/image.png"), "image.png");
 *   assertEquals(basename(new URL("file:///home/user/Documents/image.png")), "image.png");
 * }
 * ```
 *
 * @param path Path to extract the name from. When passed as a `URL`
 * instance, its protocol must be `file:`. For other protocols, pass the URL
 * as a string or pass its `pathname` property.
 * @param suffix Suffix to remove from extracted name.
 *
 * @returns The basename of the path.
 * @throws {TypeError} If `path` is a `URL` instance whose protocol is not `file:`.
 */ export function basename(path, suffix = "") {
  return isWindows ? windowsBasename(path, suffix) : posixBasename(path, suffix);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9iYXNlbmFtZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBpc1dpbmRvd3MgfSBmcm9tIFwianNyOkBzdGQvaW50ZXJuYWxAXjEuMC4xNC9vc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUgYXMgcG9zaXhCYXNlbmFtZSB9IGZyb20gXCIuL3Bvc2l4L2Jhc2VuYW1lLnRzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSBhcyB3aW5kb3dzQmFzZW5hbWUgfSBmcm9tIFwiLi93aW5kb3dzL2Jhc2VuYW1lLnRzXCI7XG5cbi8qKlxuICogUmV0dXJuIHRoZSBsYXN0IHBvcnRpb24gb2YgYSBwYXRoLlxuICpcbiAqIFRoZSB0cmFpbGluZyBkaXJlY3Rvcnkgc2VwYXJhdG9ycyBhcmUgaWdub3JlZCwgYW5kIG9wdGlvbmFsIHN1ZmZpeCBpc1xuICogcmVtb3ZlZC5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGJhc2VuYW1lIH0gZnJvbSBcIkBzdGQvcGF0aC9iYXNlbmFtZVwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogaWYgKERlbm8uYnVpbGQub3MgPT09IFwid2luZG93c1wiKSB7XG4gKiAgIGFzc2VydEVxdWFscyhiYXNlbmFtZShcIkM6XFxcXHVzZXJcXFxcRG9jdW1lbnRzXFxcXGltYWdlLnBuZ1wiKSwgXCJpbWFnZS5wbmdcIik7XG4gKiAgIGFzc2VydEVxdWFscyhiYXNlbmFtZShuZXcgVVJMKFwiZmlsZTovLy9DOi91c2VyL0RvY3VtZW50cy9pbWFnZS5wbmdcIikpLCBcImltYWdlLnBuZ1wiKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGFzc2VydEVxdWFscyhiYXNlbmFtZShcIi9ob21lL3VzZXIvRG9jdW1lbnRzL2ltYWdlLnBuZ1wiKSwgXCJpbWFnZS5wbmdcIik7XG4gKiAgIGFzc2VydEVxdWFscyhiYXNlbmFtZShuZXcgVVJMKFwiZmlsZTovLy9ob21lL3VzZXIvRG9jdW1lbnRzL2ltYWdlLnBuZ1wiKSksIFwiaW1hZ2UucG5nXCIpO1xuICogfVxuICogYGBgXG4gKlxuICogQHBhcmFtIHBhdGggUGF0aCB0byBleHRyYWN0IHRoZSBuYW1lIGZyb20uIFdoZW4gcGFzc2VkIGFzIGEgYFVSTGBcbiAqIGluc3RhbmNlLCBpdHMgcHJvdG9jb2wgbXVzdCBiZSBgZmlsZTpgLiBGb3Igb3RoZXIgcHJvdG9jb2xzLCBwYXNzIHRoZSBVUkxcbiAqIGFzIGEgc3RyaW5nIG9yIHBhc3MgaXRzIGBwYXRobmFtZWAgcHJvcGVydHkuXG4gKiBAcGFyYW0gc3VmZml4IFN1ZmZpeCB0byByZW1vdmUgZnJvbSBleHRyYWN0ZWQgbmFtZS5cbiAqXG4gKiBAcmV0dXJucyBUaGUgYmFzZW5hbWUgb2YgdGhlIHBhdGguXG4gKiBAdGhyb3dzIHtUeXBlRXJyb3J9IElmIGBwYXRoYCBpcyBhIGBVUkxgIGluc3RhbmNlIHdob3NlIHByb3RvY29sIGlzIG5vdCBgZmlsZTpgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYmFzZW5hbWUocGF0aDogc3RyaW5nIHwgVVJMLCBzdWZmaXggPSBcIlwiKTogc3RyaW5nIHtcbiAgcmV0dXJuIGlzV2luZG93c1xuICAgID8gd2luZG93c0Jhc2VuYW1lKHBhdGgsIHN1ZmZpeClcbiAgICA6IHBvc2l4QmFzZW5hbWUocGF0aCwgc3VmZml4KTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTLFlBQVksYUFBYSxRQUFRLHNCQUFzQjtBQUNoRSxTQUFTLFlBQVksZUFBZSxRQUFRLHdCQUF3QjtBQUVwRTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMkJDLEdBQ0QsT0FBTyxTQUFTLFNBQVMsSUFBa0IsRUFBRSxTQUFTLEVBQUU7RUFDdEQsT0FBTyxZQUNILGdCQUFnQixNQUFNLFVBQ3RCLGNBQWMsTUFBTTtBQUMxQiJ9
// denoCacheMetadata=1480962042800852222,15178304262490136559