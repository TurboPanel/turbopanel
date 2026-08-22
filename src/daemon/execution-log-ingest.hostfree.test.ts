import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  MAX_EXECUTION_LOG_CHUNK_BODY_BYTES,
  parseExecutionLogChunkBody,
} from "./execution-log-ingest.ts";
import { MAX_EXECUTION_LOG_CHUNK_BYTES } from "../lib/execution-logs/types.ts";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("parseExecutionLogChunkBody", () => {
  it("accepts a well-formed chunk and decodes its bytes", () => {
    const parsed = parseExecutionLogChunkBody({
      seq: 3,
      bytes: base64(new TextEncoder().encode("hello")),
    });
    assert(parsed.ok);
    assertEquals(parsed.seq, 3);
    assertEquals(new TextDecoder().decode(parsed.bytes), "hello");
  });

  it("accepts an empty chunk (a command may flush nothing)", () => {
    const parsed = parseExecutionLogChunkBody({ seq: 0, bytes: "" });
    assert(parsed.ok);
    assertEquals(parsed.bytes.byteLength, 0);
  });

  it("rejects a non-object body", () => {
    for (const body of [null, undefined, "chunk", 42, []]) {
      const parsed = parseExecutionLogChunkBody(body);
      assert(!parsed.ok);
      assertEquals(parsed.error, "invalid chunk");
    }
  });

  it("rejects a missing, fractional, or negative sequence", () => {
    for (const seq of [undefined, "0", 1.5, -1]) {
      const parsed = parseExecutionLogChunkBody({ seq, bytes: "" });
      assert(!parsed.ok);
      assertEquals(parsed.error, "seq must be a non-negative integer");
    }
  });

  it("rejects bytes that are not a base64 string", () => {
    for (const bytes of [undefined, 5, {}]) {
      const parsed = parseExecutionLogChunkBody({ seq: 0, bytes });
      assert(!parsed.ok);
      assertEquals(parsed.error, "bytes must be base64");
    }
    const invalid = parseExecutionLogChunkBody({ seq: 0, bytes: "!!!not base64!!!" });
    assert(!invalid.ok);
    assertEquals(invalid.error, "bytes must be base64");
  });

  it("rejects a chunk over the per-chunk cap", () => {
    const parsed = parseExecutionLogChunkBody({
      seq: 0,
      bytes: base64(new Uint8Array(MAX_EXECUTION_LOG_CHUNK_BYTES + 1)),
    });
    assert(!parsed.ok);
    assertEquals(parsed.error, "chunk too large");
  });

  it("leaves the request budget above the base64-expanded chunk cap", () => {
    // base64 expands by 4/3; the request budget must clear that plus JSON
    // quoting or a legal max-size chunk would 413 before it could be parsed.
    assert(
      MAX_EXECUTION_LOG_CHUNK_BODY_BYTES >
        Math.ceil(MAX_EXECUTION_LOG_CHUNK_BYTES / 3) * 4,
    );
  });
});
