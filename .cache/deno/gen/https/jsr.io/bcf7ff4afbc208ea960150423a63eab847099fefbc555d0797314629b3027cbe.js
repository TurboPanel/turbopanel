// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { isWindows } from "jsr:@std/internal@^1.0.14/os";
import { fromFileUrl as posixFromFileUrl } from "./posix/from_file_url.ts";
import { fromFileUrl as windowsFromFileUrl } from "./windows/from_file_url.ts";
/**
 * Converts a file URL to a path string.
 *
 * @example Usage
 * ```ts
 * import { fromFileUrl } from "@std/path/from-file-url";
 * import { assertEquals } from "@std/assert";
 *
 * if (Deno.build.os === "windows") {
 *   assertEquals(fromFileUrl("file:///home/foo"), "\\home\\foo");
 *   assertEquals(fromFileUrl("file:///C:/Users/foo"), "C:\\Users\\foo");
 *   assertEquals(fromFileUrl("file://localhost/home/foo"), "\\home\\foo");
 * } else {
 *   assertEquals(fromFileUrl("file:///home/foo"), "/home/foo");
 * }
 * ```
 *
 * @param url The file URL to convert to a path.
 * @returns The path string.
 */ export function fromFileUrl(url) {
  return isWindows ? windowsFromFileUrl(url) : posixFromFileUrl(url);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS9mcm9tX2ZpbGVfdXJsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB7IGlzV2luZG93cyB9IGZyb20gXCJqc3I6QHN0ZC9pbnRlcm5hbEBeMS4wLjE0L29zXCI7XG5pbXBvcnQgeyBmcm9tRmlsZVVybCBhcyBwb3NpeEZyb21GaWxlVXJsIH0gZnJvbSBcIi4vcG9zaXgvZnJvbV9maWxlX3VybC50c1wiO1xuaW1wb3J0IHsgZnJvbUZpbGVVcmwgYXMgd2luZG93c0Zyb21GaWxlVXJsIH0gZnJvbSBcIi4vd2luZG93cy9mcm9tX2ZpbGVfdXJsLnRzXCI7XG5cbi8qKlxuICogQ29udmVydHMgYSBmaWxlIFVSTCB0byBhIHBhdGggc3RyaW5nLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgZnJvbUZpbGVVcmwgfSBmcm9tIFwiQHN0ZC9wYXRoL2Zyb20tZmlsZS11cmxcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGlmIChEZW5vLmJ1aWxkLm9zID09PSBcIndpbmRvd3NcIikge1xuICogICBhc3NlcnRFcXVhbHMoZnJvbUZpbGVVcmwoXCJmaWxlOi8vL2hvbWUvZm9vXCIpLCBcIlxcXFxob21lXFxcXGZvb1wiKTtcbiAqICAgYXNzZXJ0RXF1YWxzKGZyb21GaWxlVXJsKFwiZmlsZTovLy9DOi9Vc2Vycy9mb29cIiksIFwiQzpcXFxcVXNlcnNcXFxcZm9vXCIpO1xuICogICBhc3NlcnRFcXVhbHMoZnJvbUZpbGVVcmwoXCJmaWxlOi8vbG9jYWxob3N0L2hvbWUvZm9vXCIpLCBcIlxcXFxob21lXFxcXGZvb1wiKTtcbiAqIH0gZWxzZSB7XG4gKiAgIGFzc2VydEVxdWFscyhmcm9tRmlsZVVybChcImZpbGU6Ly8vaG9tZS9mb29cIiksIFwiL2hvbWUvZm9vXCIpO1xuICogfVxuICogYGBgXG4gKlxuICogQHBhcmFtIHVybCBUaGUgZmlsZSBVUkwgdG8gY29udmVydCB0byBhIHBhdGguXG4gKiBAcmV0dXJucyBUaGUgcGF0aCBzdHJpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmcm9tRmlsZVVybCh1cmw6IHN0cmluZyB8IFVSTCk6IHN0cmluZyB7XG4gIHJldHVybiBpc1dpbmRvd3MgPyB3aW5kb3dzRnJvbUZpbGVVcmwodXJsKSA6IHBvc2l4RnJvbUZpbGVVcmwodXJsKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsU0FBUyxRQUFRLCtCQUErQjtBQUN6RCxTQUFTLGVBQWUsZ0JBQWdCLFFBQVEsMkJBQTJCO0FBQzNFLFNBQVMsZUFBZSxrQkFBa0IsUUFBUSw2QkFBNkI7QUFFL0U7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FtQkMsR0FDRCxPQUFPLFNBQVMsWUFBWSxHQUFpQjtFQUMzQyxPQUFPLFlBQVksbUJBQW1CLE9BQU8saUJBQWlCO0FBQ2hFIn0=
// denoCacheMetadata=2609983761193974712,182786452603350327