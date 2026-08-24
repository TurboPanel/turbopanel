import { assertEquals } from "@std/assert";
import { checkPhpSeriesAvailability } from "./deploy-prepare.ts";

const test = Deno.test.bind(Deno);

const site = (name: string, version?: string) => ({
  composeServiceName: name,
  ...(version ? { php: { version } } : {}),
});

test("checkPhpSeriesAvailability hard-errors on an unsupported series", () => {
  // Caught before anything is queued, rather than as a daemon throw halfway
  // through an apply.
  const { errors, warnings } = checkPhpSeriesAvailability({
    sites: [site("legacy", "5.6")],
    reportedSeries: ["8.4"],
  });
  assertEquals(errors.length, 1);
  assertEquals(errors[0]?.includes("PHP 5.6"), true);
  assertEquals(errors[0]?.includes("8.3, 8.4"), true);
  assertEquals(warnings, []);
});

test("checkPhpSeriesAvailability warns, not errors, for an installable series", () => {
  // The old host-wide pin refused this outright, which rejected a deploy the
  // host could perfectly well serve once Ansible installed the series.
  const { errors, warnings } = checkPhpSeriesAvailability({
    sites: [site("app", "8.3")],
    reportedSeries: ["8.4"],
  });
  assertEquals(errors, []);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]?.code, "php_series_not_installed");
  assertEquals(warnings[0]?.details?.series, "8.3");
});

test("checkPhpSeriesAvailability treats no report as unknown, not absent", () => {
  // An older daemon reports nothing. Silence is not evidence the series is
  // missing, so it must not produce a warning.
  const { errors, warnings } = checkPhpSeriesAvailability({
    sites: [site("app", "8.3")],
    reportedSeries: null,
  });
  assertEquals(errors, []);
  assertEquals(warnings, []);
});

test("checkPhpSeriesAvailability ignores sites that name no version", () => {
  const { errors, warnings } = checkPhpSeriesAvailability({
    sites: [site("static"), site("app", "8.4")],
    reportedSeries: ["8.4"],
  });
  assertEquals(errors, []);
  assertEquals(warnings, []);
});
