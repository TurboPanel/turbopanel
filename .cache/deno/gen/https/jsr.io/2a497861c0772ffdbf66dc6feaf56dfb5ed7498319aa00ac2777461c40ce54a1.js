// Copyright 2018-2026 the Deno authors. MIT license.
// This module is browser compatible.
import { _format, assertArg } from "../_common/format.ts";
/**
 * Generate a path from `ParsedPath` object.
 *
 * @example Usage
 * ```ts
 * import { format } from "@std/path/windows/format";
 * import { assertEquals } from "@std/assert";
 *
 * const path = format({
 *   root: "C:\\",
 *   dir: "C:\\path\\dir",
 *   base: "file.txt",
 *   ext: ".txt",
 *   name: "file"
 * });
 * assertEquals(path, "C:\\path\\dir\\file.txt");
 * ```
 *
 * @param pathObject The path object to format.
 * @returns The formatted path.
 */ export function format(pathObject) {
  assertArg(pathObject);
  return _format("\\", pathObject);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvcGF0aC8xLjEuNS93aW5kb3dzL2Zvcm1hdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI2IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG5pbXBvcnQgeyBfZm9ybWF0LCBhc3NlcnRBcmcgfSBmcm9tIFwiLi4vX2NvbW1vbi9mb3JtYXQudHNcIjtcbmltcG9ydCB0eXBlIHsgUGFyc2VkUGF0aCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuXG4vKipcbiAqIEdlbmVyYXRlIGEgcGF0aCBmcm9tIGBQYXJzZWRQYXRoYCBvYmplY3QuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBmb3JtYXQgfSBmcm9tIFwiQHN0ZC9wYXRoL3dpbmRvd3MvZm9ybWF0XCI7XG4gKiBpbXBvcnQgeyBhc3NlcnRFcXVhbHMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbiAqXG4gKiBjb25zdCBwYXRoID0gZm9ybWF0KHtcbiAqICAgcm9vdDogXCJDOlxcXFxcIixcbiAqICAgZGlyOiBcIkM6XFxcXHBhdGhcXFxcZGlyXCIsXG4gKiAgIGJhc2U6IFwiZmlsZS50eHRcIixcbiAqICAgZXh0OiBcIi50eHRcIixcbiAqICAgbmFtZTogXCJmaWxlXCJcbiAqIH0pO1xuICogYXNzZXJ0RXF1YWxzKHBhdGgsIFwiQzpcXFxccGF0aFxcXFxkaXJcXFxcZmlsZS50eHRcIik7XG4gKiBgYGBcbiAqXG4gKiBAcGFyYW0gcGF0aE9iamVjdCBUaGUgcGF0aCBvYmplY3QgdG8gZm9ybWF0LlxuICogQHJldHVybnMgVGhlIGZvcm1hdHRlZCBwYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0KHBhdGhPYmplY3Q6IFBhcnRpYWw8UGFyc2VkUGF0aD4pOiBzdHJpbmcge1xuICBhc3NlcnRBcmcocGF0aE9iamVjdCk7XG4gIHJldHVybiBfZm9ybWF0KFwiXFxcXFwiLCBwYXRoT2JqZWN0KTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxREFBcUQ7QUFDckQscUNBQXFDO0FBRXJDLFNBQVMsT0FBTyxFQUFFLFNBQVMsUUFBUSx1QkFBdUI7QUFHMUQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBQ0QsT0FBTyxTQUFTLE9BQU8sVUFBK0I7RUFDcEQsVUFBVTtFQUNWLE9BQU8sUUFBUSxNQUFNO0FBQ3ZCIn0=
// denoCacheMetadata=13978710783073993384,17579934423533773521