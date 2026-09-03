import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { normalizeCpuModel, resolveCpuCatalogEntry } from "./cpu-catalog.ts";

it("normalizeCpuModel: lower-cases and collapses whitespace without mutating callers' strings", () => {
  assertEquals(
    normalizeCpuModel("  Intel Xeon   Gold 6338  "),
    "intel xeon gold 6338",
  );
});

it("resolveCpuCatalogEntry: exact match — Intel Xeon Scalable", () => {
  assertEquals(
    resolveCpuCatalogEntry("Intel Xeon Gold 6338"),
    { tdpWatts: 205, tjMaxCelsius: 105 },
  );
});

it("resolveCpuCatalogEntry: exact match is case/whitespace-insensitive", () => {
  assertEquals(
    resolveCpuCatalogEntry("  intel   XEON gold 6338 "),
    { tdpWatts: 205, tjMaxCelsius: 105 },
  );
});

it("resolveCpuCatalogEntry: exact match — AMD EPYC", () => {
  assertEquals(
    resolveCpuCatalogEntry("AMD EPYC 7763"),
    { tdpWatts: 280, tjMaxCelsius: 95 },
  );
});

it("resolveCpuCatalogEntry: exact match — Ryzen / Threadripper", () => {
  assertEquals(
    resolveCpuCatalogEntry("AMD Ryzen 9 5950X"),
    { tdpWatts: 105, tjMaxCelsius: 90 },
  );
  assertEquals(
    resolveCpuCatalogEntry("AMD Ryzen Threadripper 3960X"),
    { tdpWatts: 280, tjMaxCelsius: 95 },
  );
});

it("resolveCpuCatalogEntry: exact match — Core i-series", () => {
  assertEquals(
    resolveCpuCatalogEntry("Intel Core i9-13900K"),
    { tdpWatts: 125, tjMaxCelsius: 100 },
  );
});

it("resolveCpuCatalogEntry: exact match — Ampere Altra", () => {
  assertEquals(
    resolveCpuCatalogEntry("Ampere Altra Q80-30"),
    { tdpWatts: 250, tjMaxCelsius: 85 },
  );
});

it("resolveCpuCatalogEntry: exact match — AWS Graviton", () => {
  assertEquals(
    resolveCpuCatalogEntry("AWS Graviton3"),
    { tdpWatts: 130, tjMaxCelsius: 95 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted Xeon Scalable SKU", () => {
  assertEquals(
    resolveCpuCatalogEntry("Intel Xeon Platinum 9999Q"),
    { tdpWatts: 150, tjMaxCelsius: 100 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted Xeon E5 v3/v4 SKU", () => {
  assertEquals(
    resolveCpuCatalogEntry("Intel Xeon E5-2699 v4"),
    { tdpWatts: 120, tjMaxCelsius: 92 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted EPYC SKU", () => {
  assertEquals(
    resolveCpuCatalogEntry("AMD EPYC 9999"),
    { tdpWatts: 200, tjMaxCelsius: 95 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted Threadripper PRO SKU", () => {
  assertEquals(
    resolveCpuCatalogEntry("AMD Ryzen Threadripper PRO 9999WX"),
    { tdpWatts: 250, tjMaxCelsius: 95 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted Ryzen desktop SKU", () => {
  assertEquals(
    resolveCpuCatalogEntry("AMD Ryzen 7 9999X"),
    { tdpWatts: 95, tjMaxCelsius: 95 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted Core i-series SKU", () => {
  assertEquals(
    resolveCpuCatalogEntry("Intel Core i5-99999K"),
    { tdpWatts: 95, tjMaxCelsius: 100 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted Altra SKU", () => {
  assertEquals(
    resolveCpuCatalogEntry("Ampere Altra Max M999-99"),
    { tdpWatts: 250, tjMaxCelsius: 85 },
  );
});

it("resolveCpuCatalogEntry: family regex fallback — unlisted Graviton generation", () => {
  assertEquals(
    resolveCpuCatalogEntry("AWS Graviton4"),
    { tdpWatts: 120, tjMaxCelsius: 95 },
  );
});

it("resolveCpuCatalogEntry: unknown model resolves to null", () => {
  assertEquals(resolveCpuCatalogEntry("Totally Unknown Silicon 42"), null);
});

it("resolveCpuCatalogEntry: null/undefined/empty resolve to null", () => {
  assertEquals(resolveCpuCatalogEntry(null), null);
  assertEquals(resolveCpuCatalogEntry(undefined), null);
  assertEquals(resolveCpuCatalogEntry("   "), null);
});

it("normalizeCpuModel: strips trademark markers and trailing clock text from a raw cpuinfo string", () => {
  assertEquals(
    normalizeCpuModel("Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz"),
    "intel core i7-9700",
  );
});

it("normalizeCpuModel: strips a trailing core-count suffix from a raw cpuinfo string", () => {
  assertEquals(
    normalizeCpuModel("AMD Ryzen 7 5800X 8-Core Processor"),
    "amd ryzen 7 5800x",
  );
});

it("resolveCpuCatalogEntry: family regex fallback — raw cpuinfo Core i-series string", () => {
  assertEquals(
    resolveCpuCatalogEntry("Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz"),
    { tdpWatts: 95, tjMaxCelsius: 100 },
  );
});

it("resolveCpuCatalogEntry: exact match — raw cpuinfo Ryzen string with core-count suffix", () => {
  assertEquals(
    resolveCpuCatalogEntry("AMD Ryzen 7 5800X 8-Core Processor"),
    { tdpWatts: 105, tjMaxCelsius: 90 },
  );
});

it("resolveCpuCatalogEntry: exact match — raw cpuinfo Xeon string with trademark markers", () => {
  assertEquals(
    resolveCpuCatalogEntry("Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz"),
    { tdpWatts: 205, tjMaxCelsius: 105 },
  );
});
