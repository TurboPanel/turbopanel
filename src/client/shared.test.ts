import { assertEquals, assertThrows } from "@std/assert";
import {
  BadRequestError,
  buildPatchUpdateFields,
  parseDescription,
  parseName,
  parseJsonbObject,
  requireStringField,
  stripPromotedMetadataKeys,
} from "./shared.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseName returns null when absent and trims valid names", () => {
  assertEquals(parseName({}), null);
  assertEquals(parseName({ name: "  My App  " }), "My App");
  assertEquals(parseName({ name: "  Legacy Name  " }), "Legacy Name");
});

test("parseName ignores leftover displayName and reads name only", () => {
  assertEquals(parseName({ displayName: "Ignored", name: "Preferred" }), "Preferred");
  assertEquals(parseName({ displayName: "Ignored" }), null);
});

test("parseName rejects non-strings, empty, control characters, and over-length", () => {
  assertEquals(parseName({ displayName: "From alias" }), null);
  assertThrows(() => parseName({ name: 1 }), BadRequestError);
  assertThrows(() => parseName({ name: "" }), BadRequestError);
  assertThrows(
    () => parseName({ name: "bad\nname" }),
    BadRequestError,
  );
  assertThrows(
    () => parseName({ name: "a".repeat(256) }),
    BadRequestError,
  );
});

test("parseName accepts Unicode labels, apostrophes, and folds typographic quotes", () => {
  assertEquals(parseName({ name: "O'Reilly" }), "O'Reilly");
  assertEquals(
    parseName({ name: "  O\u2019Reilly  " }),
    "O'Reilly",
  );
  assertEquals(parseName({ name: "Müller GmbH" }), "Müller GmbH");
  assertEquals(parseName({ name: "东京" }), "东京");
  assertEquals(parseName({ name: "bad@name" }), "bad@name");
});

test("parseDescription trims, maps empty to null, and rejects oversize", () => {
  assertEquals(parseDescription({}), null);
  assertEquals(parseDescription({ description: "  hi  " }), "hi");
  assertEquals(parseDescription({ description: "   " }), null);
  assertThrows(() => parseDescription({ description: 1 }), BadRequestError);
  assertThrows(
    () => parseDescription({ description: "a".repeat(256) }),
    BadRequestError,
  );
});

test("stripPromotedMetadataKeys drops listed keys without mutating others", () => {
  assertEquals(
    stripPromotedMetadataKeys(
      { type: "managed", keep: true, nested: { a: 1 } },
      ["type"],
    ),
    { keep: true, nested: { a: 1 } },
  );
});

test("buildPatchUpdateFields always sets updatedAt and optional patches", () => {
  const onlyStamp = buildPatchUpdateFields({});
  assertEquals(typeof onlyStamp.updatedAt, "string");
  assertEquals("name" in onlyStamp, false);
  assertEquals("description" in onlyStamp, false);

  const patched = buildPatchUpdateFields({
    name: "  Renamed  ",
    description: "  notes  ",
  });
  assertEquals(patched.name, "Renamed");
  assertEquals(patched.description, "notes");

  const ignoredAlias = buildPatchUpdateFields({
    displayName: "  From UI  ",
  });
  assertEquals("name" in ignoredAlias, false);

  const clearedDescription = buildPatchUpdateFields({ description: "  " });
  assertEquals(clearedDescription.description, null);
});

test("buildPatchUpdateFields rejects invalid name and description", () => {
  assertThrows(() => buildPatchUpdateFields({ name: 1 }), BadRequestError);
  assertThrows(() => buildPatchUpdateFields({ name: "" }), BadRequestError);
  assertThrows(
    () => buildPatchUpdateFields({ description: 1 }),
    BadRequestError,
  );
  assertThrows(
    () => buildPatchUpdateFields({ description: "a".repeat(256) }),
    BadRequestError,
  );
});

test("requireStringField returns the value or a 400 Response", () => {
  const ok = requireStringField(
    {
      json: (body: unknown, status?: number) => Response.json(body, { status }),
    } as never,
    { name: "alpha" },
    "name",
  );
  assertEquals(ok, "alpha");

  const missing = requireStringField(
    {
      json: (body: unknown, status?: number) => Response.json(body, { status }),
    } as never,
    {},
    "name",
  );
  assertEquals(missing instanceof Response, true);
});

test("parseJsonbObject returns null when absent and rejects non-objects", () => {
  const c = {
    json: (body: unknown, status?: number) => Response.json(body, { status }),
  } as never;

  assertEquals(parseJsonbObject(c, {}, "metadata"), null);
  assertEquals(parseJsonbObject(c, { metadata: { a: 1 } }, "metadata"), {
    a: 1,
  });

  const badArray = parseJsonbObject(c, { metadata: [] }, "metadata");
  assertEquals(badArray instanceof Response, true);
  const badNull = parseJsonbObject(c, { metadata: null }, "metadata");
  assertEquals(badNull instanceof Response, true);
});
