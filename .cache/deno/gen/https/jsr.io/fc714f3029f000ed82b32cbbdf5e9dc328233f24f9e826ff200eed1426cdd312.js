// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { encodeWhitespace } from "../_common/to_file_url.ts";
import { isAbsolute } from "./is_absolute.ts";
/**
 * Converts a path string to a file URL.
 *
 * @example Usage
 * ```ts
 * import { toFileUrl } from "@std/path/windows/to-file-url";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(toFileUrl("\\home\\foo"), new URL("file:///home/foo"));
 * assertEquals(toFileUrl("C:\\Users\\foo"), new URL("file:///C:/Users/foo"));
 * assertEquals(toFileUrl("\\\\127.0.0.1\\home\\foo"), new URL("file://127.0.0.1/home/foo"));
 * ```
 * @param path The path to convert.
 * @returns The file URL.
 */ export function toFileUrl(path) {
  if (!isAbsolute(path)) {
    throw new TypeError(`Path must be absolute: received "${path}"`);
  }
  const [, hostname, pathname] = path.match(/^(?:[/\\]{2}([^/\\]+)(?=[/\\](?:[^/\\]|$)))?(.*)/);
  const url = new URL("file:///");
  url.pathname = encodeWhitespace(pathname.replace(/%/g, "%25"));
  if (hostname !== undefined && hostname !== "localhost") {
    url.hostname = hostname;
    if (!url.hostname) {
      throw new TypeError(`Invalid hostname: "${url.hostname}"`);
    }
  }
  return url;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL3RvX2ZpbGVfdXJsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG4vLyBUaGlzIG1vZHVsZSBpcyBicm93c2VyIGNvbXBhdGlibGUuXG5cbmltcG9ydCB7IGVuY29kZVdoaXRlc3BhY2UgfSBmcm9tIFwiLi4vX2NvbW1vbi90b19maWxlX3VybC50c1wiO1xuaW1wb3J0IHsgaXNBYnNvbHV0ZSB9IGZyb20gXCIuL2lzX2Fic29sdXRlLnRzXCI7XG5cbi8qKlxuICogQ29udmVydHMgYSBwYXRoIHN0cmluZyB0byBhIGZpbGUgVVJMLlxuICpcbiAqIEBleGFtcGxlIFVzYWdlXG4gKiBgYGB0c1xuICogaW1wb3J0IHsgdG9GaWxlVXJsIH0gZnJvbSBcIkBzdGQvcGF0aC93aW5kb3dzL3RvLWZpbGUtdXJsXCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBhc3NlcnRFcXVhbHModG9GaWxlVXJsKFwiXFxcXGhvbWVcXFxcZm9vXCIpLCBuZXcgVVJMKFwiZmlsZTovLy9ob21lL2Zvb1wiKSk7XG4gKiBhc3NlcnRFcXVhbHModG9GaWxlVXJsKFwiQzpcXFxcVXNlcnNcXFxcZm9vXCIpLCBuZXcgVVJMKFwiZmlsZTovLy9DOi9Vc2Vycy9mb29cIikpO1xuICogYXNzZXJ0RXF1YWxzKHRvRmlsZVVybChcIlxcXFxcXFxcMTI3LjAuMC4xXFxcXGhvbWVcXFxcZm9vXCIpLCBuZXcgVVJMKFwiZmlsZTovLzEyNy4wLjAuMS9ob21lL2Zvb1wiKSk7XG4gKiBgYGBcbiAqIEBwYXJhbSBwYXRoIFRoZSBwYXRoIHRvIGNvbnZlcnQuXG4gKiBAcmV0dXJucyBUaGUgZmlsZSBVUkwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0ZpbGVVcmwocGF0aDogc3RyaW5nKTogVVJMIHtcbiAgaWYgKCFpc0Fic29sdXRlKHBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcihgUGF0aCBtdXN0IGJlIGFic29sdXRlOiByZWNlaXZlZCBcIiR7cGF0aH1cImApO1xuICB9XG4gIGNvbnN0IFssIGhvc3RuYW1lLCBwYXRobmFtZV0gPSBwYXRoLm1hdGNoKFxuICAgIC9eKD86Wy9cXFxcXXsyfShbXi9cXFxcXSspKD89Wy9cXFxcXSg/OlteL1xcXFxdfCQpKSk/KC4qKS8sXG4gICkhO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKFwiZmlsZTovLy9cIik7XG4gIHVybC5wYXRobmFtZSA9IGVuY29kZVdoaXRlc3BhY2UocGF0aG5hbWUhLnJlcGxhY2UoLyUvZywgXCIlMjVcIikpO1xuICBpZiAoaG9zdG5hbWUgIT09IHVuZGVmaW5lZCAmJiBob3N0bmFtZSAhPT0gXCJsb2NhbGhvc3RcIikge1xuICAgIHVybC5ob3N0bmFtZSA9IGhvc3RuYW1lO1xuICAgIGlmICghdXJsLmhvc3RuYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKGBJbnZhbGlkIGhvc3RuYW1lOiBcIiR7dXJsLmhvc3RuYW1lfVwiYCk7XG4gICAgfVxuICB9XG4gIHJldHVybiB1cmw7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUFTLGdCQUFnQixRQUFRLDRCQUE0QjtBQUM3RCxTQUFTLFVBQVUsUUFBUSxtQkFBbUI7QUFFOUM7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FDRCxPQUFPLFNBQVMsVUFBVSxJQUFZO0VBQ3BDLElBQUksQ0FBQyxXQUFXLE9BQU87SUFDckIsTUFBTSxJQUFJLFVBQVUsQ0FBQyxpQ0FBaUMsRUFBRSxLQUFLLENBQUMsQ0FBQztFQUNqRTtFQUNBLE1BQU0sR0FBRyxVQUFVLFNBQVMsR0FBRyxLQUFLLEtBQUssQ0FDdkM7RUFFRixNQUFNLE1BQU0sSUFBSSxJQUFJO0VBQ3BCLElBQUksUUFBUSxHQUFHLGlCQUFpQixTQUFVLE9BQU8sQ0FBQyxNQUFNO0VBQ3hELElBQUksYUFBYSxhQUFhLGFBQWEsYUFBYTtJQUN0RCxJQUFJLFFBQVEsR0FBRztJQUNmLElBQUksQ0FBQyxJQUFJLFFBQVEsRUFBRTtNQUNqQixNQUFNLElBQUksVUFBVSxDQUFDLG1CQUFtQixFQUFFLElBQUksUUFBUSxDQUFDLENBQUMsQ0FBQztJQUMzRDtFQUNGO0VBQ0EsT0FBTztBQUNUIn0=
// denoCacheMetadata=13297695788657173032,7558657255417845340