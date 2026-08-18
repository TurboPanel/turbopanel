import { assertEquals } from "@std/assert";
import {
  DISPLAY_NAME_MAX_LENGTH,
  foldDisplayNameApostrophes,
  isValidDescription,
  isValidDisplayName,
  normalizeDisplayName,
  normalizeDisplayNameKey,
} from "./display-name-format.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isValidDisplayName accepts apostrophes and Unicode labels", () => {
  assertEquals(isValidDisplayName("O'Reilly"), true);
  assertEquals(isValidDisplayName("McDonald's"), true);
  assertEquals(isValidDisplayName("Acme Corp"), true);
  assertEquals(isValidDisplayName("Müller GmbH"), true);
  assertEquals(isValidDisplayName("东京"), true);
  assertEquals(isValidDisplayName("Café"), true);
  assertEquals(isValidDisplayName("اسم"), true);
  assertEquals(isValidDisplayName("🚀"), true);
  assertEquals(isValidDisplayName("bad@name"), true);
  assertEquals(isValidDisplayName(""), false);
});

test("isValidDisplayName rejects empty, control characters, and over-length", () => {
  assertEquals(isValidDisplayName("   ".trim()), false);
  assertEquals(isValidDisplayName("bad\nname"), false);
  assertEquals(isValidDisplayName("a".repeat(DISPLAY_NAME_MAX_LENGTH + 1)), false);
  assertEquals(isValidDisplayName("a".repeat(DISPLAY_NAME_MAX_LENGTH)), true);
  assertEquals(isValidDisplayName("😀".repeat(DISPLAY_NAME_MAX_LENGTH)), true);
  assertEquals(isValidDisplayName("😀".repeat(DISPLAY_NAME_MAX_LENGTH + 1)), false);
});

test("isValidDescription allows empty and rejects control characters", () => {
  assertEquals(isValidDescription(""), true);
  assertEquals(isValidDescription("notes"), true);
  assertEquals(isValidDescription("bad\nname"), false);
  assertEquals(isValidDescription("a".repeat(DISPLAY_NAME_MAX_LENGTH + 1)), false);
});

test("foldDisplayNameApostrophes maps typographic quotes to ASCII", () => {
  assertEquals(foldDisplayNameApostrophes("O\u2019Reilly"), "O'Reilly");
  assertEquals(foldDisplayNameApostrophes("\u2018quoted\u2019"), "'quoted'");
  assertEquals(foldDisplayNameApostrophes("O\u02BCReilly"), "O'Reilly");
});

test("normalizeDisplayName trims, NFC-normalizes, then folds", () => {
  assertEquals(normalizeDisplayName("  O\u2019Reilly  "), "O'Reilly");
  assertEquals(normalizeDisplayName("Cafe\u0301"), "Café");
});

test("normalizeDisplayNameKey folds NFC and case for uniqueness", () => {
  assertEquals(normalizeDisplayNameKey("  Café  "), "café");
  assertEquals(
    normalizeDisplayNameKey("Cafe\u0301"),
    normalizeDisplayNameKey("Café"),
  );
  assertEquals(
    normalizeDisplayNameKey("O\u2019Reilly"),
    normalizeDisplayNameKey("O'Reilly"),
  );
});
