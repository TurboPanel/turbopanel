// Copyright 2018-2025 the Deno authors. MIT license.
// This module is browser compatible.
/**
 * Utilities for
 * {@link https://www.rfc-editor.org/rfc/rfc4648.html#section-4 | base64}
 * encoding and decoding.
 *
 * ```ts
 * import {
 *   encodeBase64,
 *   decodeBase64,
 * } from "@std/encoding/base64";
 * import { assertEquals } from "@std/assert";
 *
 * const foobar = new TextEncoder().encode("foobar");
 *
 * assertEquals(encodeBase64(foobar), "Zm9vYmFy");
 * assertEquals(decodeBase64("Zm9vYmFy"), foobar);
 * ```
 *
 * @module
 */ import { calcSizeBase64, decode, encode } from "./_common64.ts";
import { detach } from "./_common_detach.ts";
const padding = "=".charCodeAt(0);
const alphabet = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const rAlphabet = new Uint8Array(128).fill(64); // alphabet.length
alphabet.forEach((byte, i)=>rAlphabet[byte] = i);
/**
 * Converts data into a base64-encoded string.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc4648.html#section-4}
 *
 * @param data The data to encode.
 * @returns The base64-encoded string.
 *
 * @example Usage
 * ```ts
 * import { encodeBase64 } from "@std/encoding/base64";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(encodeBase64("foobar"), "Zm9vYmFy");
 * ```
 */ export function encodeBase64(data) {
  if (typeof data === "string") {
    data = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) data = new Uint8Array(data).slice();
  else data = data.slice();
  const [output, i] = detach(data, calcSizeBase64(data.length));
  encode(output, i, 0, alphabet, padding);
  return new TextDecoder().decode(output);
}
/**
 * Decodes a base64-encoded string.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc4648.html#section-4}
 *
 * @param b64 The base64-encoded string to decode.
 * @returns The decoded data.
 *
 * @example Usage
 * ```ts
 * import { decodeBase64 } from "@std/encoding/base64";
 * import { assertEquals } from "@std/assert";
 *
 * assertEquals(
 *   decodeBase64("Zm9vYmFy"),
 *   new TextEncoder().encode("foobar")
 * );
 * ```
 */ export function decodeBase64(b64) {
  const output = new TextEncoder().encode(b64);
  // deno-lint-ignore no-explicit-any
  return new Uint8Array(output.buffer.transfer(decode(output, 0, 0, rAlphabet, padding)));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQvZW5jb2RpbmcvMS4wLjEwL2Jhc2U2NC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDI1IHRoZSBEZW5vIGF1dGhvcnMuIE1JVCBsaWNlbnNlLlxuLy8gVGhpcyBtb2R1bGUgaXMgYnJvd3NlciBjb21wYXRpYmxlLlxuXG4vKipcbiAqIFV0aWxpdGllcyBmb3JcbiAqIHtAbGluayBodHRwczovL3d3dy5yZmMtZWRpdG9yLm9yZy9yZmMvcmZjNDY0OC5odG1sI3NlY3Rpb24tNCB8IGJhc2U2NH1cbiAqIGVuY29kaW5nIGFuZCBkZWNvZGluZy5cbiAqXG4gKiBgYGB0c1xuICogaW1wb3J0IHtcbiAqICAgZW5jb2RlQmFzZTY0LFxuICogICBkZWNvZGVCYXNlNjQsXG4gKiB9IGZyb20gXCJAc3RkL2VuY29kaW5nL2Jhc2U2NFwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogY29uc3QgZm9vYmFyID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKFwiZm9vYmFyXCIpO1xuICpcbiAqIGFzc2VydEVxdWFscyhlbmNvZGVCYXNlNjQoZm9vYmFyKSwgXCJabTl2WW1GeVwiKTtcbiAqIGFzc2VydEVxdWFscyhkZWNvZGVCYXNlNjQoXCJabTl2WW1GeVwiKSwgZm9vYmFyKTtcbiAqIGBgYFxuICpcbiAqIEBtb2R1bGVcbiAqL1xuXG5pbXBvcnQgeyBjYWxjU2l6ZUJhc2U2NCwgZGVjb2RlLCBlbmNvZGUgfSBmcm9tIFwiLi9fY29tbW9uNjQudHNcIjtcbmltcG9ydCB7IGRldGFjaCB9IGZyb20gXCIuL19jb21tb25fZGV0YWNoLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFVpbnQ4QXJyYXlfIH0gZnJvbSBcIi4vX3R5cGVzLnRzXCI7XG5leHBvcnQgdHlwZSB7IFVpbnQ4QXJyYXlfIH07XG5cbmNvbnN0IHBhZGRpbmcgPSBcIj1cIi5jaGFyQ29kZUF0KDApO1xuY29uc3QgYWxwaGFiZXQgPSBuZXcgVGV4dEVuY29kZXIoKVxuICAuZW5jb2RlKFwiQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrL1wiKTtcbmNvbnN0IHJBbHBoYWJldCA9IG5ldyBVaW50OEFycmF5KDEyOCkuZmlsbCg2NCk7IC8vIGFscGhhYmV0Lmxlbmd0aFxuYWxwaGFiZXQuZm9yRWFjaCgoYnl0ZSwgaSkgPT4gckFscGhhYmV0W2J5dGVdID0gaSk7XG5cbi8qKlxuICogQ29udmVydHMgZGF0YSBpbnRvIGEgYmFzZTY0LWVuY29kZWQgc3RyaW5nLlxuICpcbiAqIEBzZWUge0BsaW5rIGh0dHBzOi8vd3d3LnJmYy1lZGl0b3Iub3JnL3JmYy9yZmM0NjQ4Lmh0bWwjc2VjdGlvbi00fVxuICpcbiAqIEBwYXJhbSBkYXRhIFRoZSBkYXRhIHRvIGVuY29kZS5cbiAqIEByZXR1cm5zIFRoZSBiYXNlNjQtZW5jb2RlZCBzdHJpbmcuXG4gKlxuICogQGV4YW1wbGUgVXNhZ2VcbiAqIGBgYHRzXG4gKiBpbXBvcnQgeyBlbmNvZGVCYXNlNjQgfSBmcm9tIFwiQHN0ZC9lbmNvZGluZy9iYXNlNjRcIjtcbiAqIGltcG9ydCB7IGFzc2VydEVxdWFscyB9IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuICpcbiAqIGFzc2VydEVxdWFscyhlbmNvZGVCYXNlNjQoXCJmb29iYXJcIiksIFwiWm05dlltRnlcIik7XG4gKiBgYGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuY29kZUJhc2U2NChkYXRhOiBBcnJheUJ1ZmZlciB8IFVpbnQ4QXJyYXkgfCBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodHlwZW9mIGRhdGEgPT09IFwic3RyaW5nXCIpIHtcbiAgICBkYXRhID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGRhdGEpIGFzIFVpbnQ4QXJyYXlfO1xuICB9IGVsc2UgaWYgKGRhdGEgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgZGF0YSA9IG5ldyBVaW50OEFycmF5KGRhdGEpLnNsaWNlKCk7XG4gIGVsc2UgZGF0YSA9IGRhdGEuc2xpY2UoKTtcbiAgY29uc3QgW291dHB1dCwgaV0gPSBkZXRhY2goXG4gICAgZGF0YSBhcyBVaW50OEFycmF5XyxcbiAgICBjYWxjU2l6ZUJhc2U2NCgoZGF0YSBhcyBVaW50OEFycmF5XykubGVuZ3RoKSxcbiAgKTtcbiAgZW5jb2RlKG91dHB1dCwgaSwgMCwgYWxwaGFiZXQsIHBhZGRpbmcpO1xuICByZXR1cm4gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKG91dHB1dCk7XG59XG5cbi8qKlxuICogRGVjb2RlcyBhIGJhc2U2NC1lbmNvZGVkIHN0cmluZy5cbiAqXG4gKiBAc2VlIHtAbGluayBodHRwczovL3d3dy5yZmMtZWRpdG9yLm9yZy9yZmMvcmZjNDY0OC5odG1sI3NlY3Rpb24tNH1cbiAqXG4gKiBAcGFyYW0gYjY0IFRoZSBiYXNlNjQtZW5jb2RlZCBzdHJpbmcgdG8gZGVjb2RlLlxuICogQHJldHVybnMgVGhlIGRlY29kZWQgZGF0YS5cbiAqXG4gKiBAZXhhbXBsZSBVc2FnZVxuICogYGBgdHNcbiAqIGltcG9ydCB7IGRlY29kZUJhc2U2NCB9IGZyb20gXCJAc3RkL2VuY29kaW5nL2Jhc2U2NFwiO1xuICogaW1wb3J0IHsgYXNzZXJ0RXF1YWxzIH0gZnJvbSBcIkBzdGQvYXNzZXJ0XCI7XG4gKlxuICogYXNzZXJ0RXF1YWxzKFxuICogICBkZWNvZGVCYXNlNjQoXCJabTl2WW1GeVwiKSxcbiAqICAgbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKFwiZm9vYmFyXCIpXG4gKiApO1xuICogYGBgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWNvZGVCYXNlNjQoYjY0OiBzdHJpbmcpOiBVaW50OEFycmF5XyB7XG4gIGNvbnN0IG91dHB1dCA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShiNjQpIGFzIFVpbnQ4QXJyYXlfO1xuICAvLyBkZW5vLWxpbnQtaWdub3JlIG5vLWV4cGxpY2l0LWFueVxuICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoKG91dHB1dC5idWZmZXIgYXMgYW55KVxuICAgIC50cmFuc2ZlcihkZWNvZGUob3V0cHV0LCAwLCAwLCByQWxwaGFiZXQsIHBhZGRpbmcpKSk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEscURBQXFEO0FBQ3JELHFDQUFxQztBQUVyQzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1CQyxHQUVELFNBQVMsY0FBYyxFQUFFLE1BQU0sRUFBRSxNQUFNLFFBQVEsaUJBQWlCO0FBQ2hFLFNBQVMsTUFBTSxRQUFRLHNCQUFzQjtBQUk3QyxNQUFNLFVBQVUsSUFBSSxVQUFVLENBQUM7QUFDL0IsTUFBTSxXQUFXLElBQUksY0FDbEIsTUFBTSxDQUFDO0FBQ1YsTUFBTSxZQUFZLElBQUksV0FBVyxLQUFLLElBQUksQ0FBQyxLQUFLLGtCQUFrQjtBQUNsRSxTQUFTLE9BQU8sQ0FBQyxDQUFDLE1BQU0sSUFBTSxTQUFTLENBQUMsS0FBSyxHQUFHO0FBRWhEOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUNELE9BQU8sU0FBUyxhQUFhLElBQXVDO0VBQ2xFLElBQUksT0FBTyxTQUFTLFVBQVU7SUFDNUIsT0FBTyxJQUFJLGNBQWMsTUFBTSxDQUFDO0VBQ2xDLE9BQU8sSUFBSSxnQkFBZ0IsYUFBYSxPQUFPLElBQUksV0FBVyxNQUFNLEtBQUs7T0FDcEUsT0FBTyxLQUFLLEtBQUs7RUFDdEIsTUFBTSxDQUFDLFFBQVEsRUFBRSxHQUFHLE9BQ2xCLE1BQ0EsZUFBZSxBQUFDLEtBQXFCLE1BQU07RUFFN0MsT0FBTyxRQUFRLEdBQUcsR0FBRyxVQUFVO0VBQy9CLE9BQU8sSUFBSSxjQUFjLE1BQU0sQ0FBQztBQUNsQztBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQkMsR0FDRCxPQUFPLFNBQVMsYUFBYSxHQUFXO0VBQ3RDLE1BQU0sU0FBUyxJQUFJLGNBQWMsTUFBTSxDQUFDO0VBQ3hDLG1DQUFtQztFQUNuQyxPQUFPLElBQUksV0FBVyxBQUFDLE9BQU8sTUFBTSxDQUNqQyxRQUFRLENBQUMsT0FBTyxRQUFRLEdBQUcsR0FBRyxXQUFXO0FBQzlDIn0=
// denoCacheMetadata=13188016382760862358,12161552320319631934