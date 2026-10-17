import { describe, expect, it } from "vitest";
import { daysSinceEpoch, MSC_CLASSES, mscClass, newYorkDate } from "../src/core/msc";

describe("msc rotation", () => {
	it("covers the 63 top-level classes, with the known gaps in the codes", () => {
		expect(MSC_CLASSES).toHaveLength(63);
		expect(MSC_CLASSES.map((entry) => entry.code)).not.toContain("02");
		expect(MSC_CLASSES[17]).toEqual({ code: "26", title: "Real functions" });
		expect(MSC_CLASSES[18]).toEqual({ code: "28", title: "Measure and integration" });
		expect(MSC_CLASSES[62]).toEqual({ code: "97", title: "Mathematics education" });
	});

	it("matches the published sanity checks", () => {
		// 16:00 UTC is still that calendar date in New York, in both EST and EDT.
		expect(mscClass(new Date("2026-10-13T16:00:00Z"))).toMatchObject({
			date: "2026-10-13",
			timezone: "America/New_York",
			n: 9782,
			index: 17,
			code: "26",
			title: "Real functions",
			heading: "MSC 26 · Real functions",
		});
		expect(mscClass(new Date("2026-10-14T16:00:00Z"))).toMatchObject({
			date: "2026-10-14",
			n: 9783,
			index: 18,
			code: "28",
			title: "Measure and integration",
			heading: "MSC 28 · Measure and integration",
		});
	});

	it("uses the New York calendar date, including across UTC midnight", () => {
		// 03:30 UTC on the 13th is still 23:30 the previous evening in New York (EDT, UTC−4).
		expect(newYorkDate(new Date("2026-10-13T03:30:00Z"))).toBe("2026-10-12");
		expect(mscClass(new Date("2026-10-13T03:30:00Z")).index).toBe(16);
		expect(mscClass(new Date("2026-10-13T04:00:00Z")).date).toBe("2026-10-13");
	});

	it("counts 2000-01-01 as day 0", () => {
		expect(daysSinceEpoch("2000-01-01")).toBe(0);
		expect(mscClass(new Date("2000-01-01T17:00:00Z")).index).toBe(0);
	});
});
