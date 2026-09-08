import { describe, expect, it } from "vitest";
import { calendarOpenPrimaryRegisterMonths } from "./primaryRegisterMonths.js";

describe("calendarOpenPrimaryRegisterMonths", () => {
  it("uses the current calendar month plus three prior in fiscal order", () => {
    expect(calendarOpenPrimaryRegisterMonths("2026-27", new Date("2026-09-08T12:00:00Z")))
      .toEqual(["Jun-26", "Jul-26", "Aug-26", "Sep-26"]);
  });

  it("does not leak a prior fiscal year's calendar months into the requested FY", () => {
    expect(calendarOpenPrimaryRegisterMonths("2026-27", new Date("2026-05-08T12:00:00Z")))
      .toEqual(["Apr-26", "May-26"]);
  });
});