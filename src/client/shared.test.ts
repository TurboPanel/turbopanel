import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  BadRequestError,
  buildPatchUpdateFields,
  parseDescription,
  parseDisplayName,
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

test("parseDisplayName returns null when absent and trims valid names", () => {
  assertEquals(parseDisplayName({}), null);
  assertEquals(parseDisplayName({ displayName: "  My App  " }), "My App");
  assertEquals(parseDisplayName({ name: "  Legacy Name  " }), "Legacy Name");
});

test("parseDisplayName prefers displayName over legacy name", () => {
  assertEquals(
    parseDisplayName({ displayName: "Preferred", name: "Legacy" }),
    "Preferred",
  );
});

test("parseDisplayName rejects non-strings, empty, control characters, and over-length", () => {
  assertThrows(() => parseDisplayName({ displayName: 1 }), BadRequestError);
  assertThrows(() => parseDisplayName({ name: 1 }), BadRequestError);
  assertThrows(() => parseDisplayName({ displayName: "" }), BadRequestError);
  assertThrows(
    () => parseDisplayName({ displayName: "bad\nname" }),
    BadRequestError,
  );
  assertThrows(
    () => parseDisplayName({ displayName: "a".repeat(256) }),
    BadRequestError,
  );
});

test("parseDisplayName accepts Unicode labels, apostrophes, and folds typographic quotes", () => {
  assertEquals(parseDisplayName({ displayName: "O'Reilly" }), "O'Reilly");
  assertEquals(
    parseDisplayName({ displayName: "  O\u2019Reilly  " }),
    "O'Reilly",
  );
  assertEquals(parseDisplayName({ displayName: "Müller GmbH" }), "Müller GmbH");
  assertEquals(parseDisplayName({ displayName: "东京" }), "东京");
  assertEquals(parseDisplayName({ displayName: "bad@name" }), "bad@name");
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

  const fromDisplayName = buildPatchUpdateFields({
    displayName: "  From UI  ",
  });
  assertEquals(fromDisplayName.name, "From UI");

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
