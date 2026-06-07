// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { assertArg } from "../_common/from_file_url.ts";
/**
 * Converts a file URL to a path string.
 *
 * @example Usage
 * ```ts
 * import { fromFileUrl } from "@std/path/windows/from-file-url";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(fromFileUrl("file:///home/foo"), "\\home\\foo");
 * assertEquals(fromFileUrl("file:///C:/Users/foo"), "C:\\Users\\foo");
 * assertEquals(fromFileUrl("file://localhost/home/foo"), "\\home\\foo");
 * ```
 *
 * @param url The file URL to convert.
 * @returns The path string.
 */ export function fromFileUrl(url) {
  url = assertArg(url);
  let path = decodeURIComponent(url.pathname.replace(/\//g, "\\").replace(/%(?![0-9A-Fa-f]{2})/g, "%25")).replace(/^\\*([A-Za-z]:)(\\|$)/, "$1\\");
  if (url.hostname !== "") {
    // Note: The `URL` implementation guarantees that the drive letter and
    // hostname are mutually exclusive. Otherwise it would not have been valid
    // to append the hostname and path like this.
    path = `\\\\${url.hostname}${path}`;
  }
  return path;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL2Zyb21fZmlsZV91cmwudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyNiB0aGUgRGVubyBhdXRob3JzLiBNSVQgbGljZW5zZS5cbi8vIFRoaXMgbW9kdWxlIGlzIGJyb3dzZXIgY29tcGF0aWJsZS5cblxuaW1wb3J0IHsgYXNzZXJ0QXJnIH0gZnJvbSBcIi4uL19jb21tb24vZnJvbV9maWxlX3VybC50c1wiO1xuXG4vKipcbiAqIENvbnZlcnRzIGEgZmlsZSBVUkwgdG8gYSBwYXRoIHN0cmluZy5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGZyb21GaWxlVXJsIH0gZnJvbSBcIkBzdGQvcGF0aC93aW5kb3dzL2Zyb20tZmlsZS11cmxcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhmcm9tRmlsZVVybChcImZpbGU6Ly8vaG9tZS9mb29cIiksIFwiXFxcXGhvbWVcXFxcZm9vXCIpO1xuICogYXNzZXJ0RXF1YWxzKGZyb21GaWxlVXJsKFwiZmlsZTovLy9DOi9Vc2Vycy9mb29cIiksIFwiQzpcXFxcVXNlcnNcXFxcZm9vXCIpO1xuICogYXNzZXJ0RXF1YWxzKGZyb21GaWxlVXJsKFwiZmlsZTovL2xvY2FsaG9zdC9ob21lL2Zvb1wiKSwgXCJcXFxcaG9tZVxcXFxmb29cIik7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gdXJsIFRoZSBmaWxlIFVSTCB0byBjb252ZXJ0LlxuICogQHJldHVybnMgVGhlIHBhdGggc3RyaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZnJvbUZpbGVVcmwodXJsOiBVUkwgfCBzdHJpbmcpOiBzdHJpbmcge1xuICB1cmwgPSBhc3NlcnRBcmcodXJsKTtcbiAgbGV0IHBhdGggPSBkZWNvZGVVUklDb21wb25lbnQoXG4gICAgdXJsLnBhdGhuYW1lLnJlcGxhY2UoL1xcLy9nLCBcIlxcXFxcIikucmVwbGFjZSgvJSg/IVswLTlBLUZhLWZdezJ9KS9nLCBcIiUyNVwiKSxcbiAgKS5yZXBsYWNlKC9eXFxcXCooW0EtWmEtel06KShcXFxcfCQpLywgXCIkMVxcXFxcIik7XG4gIGlmICh1cmwuaG9zdG5hbWUgIT09IFwiXCIpIHtcbiAgICAvLyBOb3RlOiBUaGUgYFVSTGAgaW1wbGVtZW50YXRpb24gZ3VhcmFudGVlcyB0aGF0IHRoZSBkcml2ZSBsZXR0ZXIgYW5kXG4gICAgLy8gaG9zdG5hbWUgYXJlIG11dHVhbGx5IGV4Y2x1c2l2ZS4gT3RoZXJ3aXNlIGl0IHdvdWxkIG5vdCBoYXZlIGJlZW4gdmFsaWRcbiAgICAvLyB0byBhcHBlbmQgdGhlIGhvc3RuYW1lIGFuZCBwYXRoIGxpa2UgdGhpcy5cbiAgICBwYXRoID0gYFxcXFxcXFxcJHt1cmwuaG9zdG5hbWV9JHtwYXRofWA7XG4gIH1cbiAgcmV0dXJuIHBhdGg7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQyxTQUFTLFNBQVMsUUFBUSw4QkFBOEI7QUFFeEQ7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBQ0QsT0FBTyxTQUFTLFlBQVksR0FBaUI7RUFDM0MsTUFBTSxVQUFVO0VBQ2hCLElBQUksT0FBTyxtQkFDVCxJQUFJLFFBQVEsQ0FBQyxPQUFPLENBQUMsT0FBTyxNQUFNLE9BQU8sQ0FBQyx3QkFBd0IsUUFDbEUsT0FBTyxDQUFDLHlCQUF5QjtFQUNuQyxJQUFJLElBQUksUUFBUSxLQUFLLElBQUk7SUFDdkIsc0VBQXNFO0lBQ3RFLDBFQUEwRTtJQUMxRSw2Q0FBNkM7SUFDN0MsT0FBTyxDQUFDLElBQUksRUFBRSxJQUFJLFFBQVEsR0FBRyxNQUFNO0VBQ3JDO0VBQ0EsT0FBTztBQUNUIn0=
// denoCacheMetadata=5605904415741148614,10042084782477109488