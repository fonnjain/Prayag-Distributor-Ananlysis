import { describe, expect, it } from "vitest";
import { isResolutionItemClosed, validateResolutionItem } from "./resolutionItems";

const pending = {
  code: "P99",
  type: "PENDING",
  title: "An answer is owed",
  category: "data quality",
  reason: "The source needs confirmation.",
  evidence: "[Source: test] source evidence",
  raisedOn: "2026-09-14",
  raisedBy: "test",
  owner: "internal",
};

describe("resolution item validation", () => {
  it("defaults PENDING items to non-blocking", () => {
    expect(validateResolutionItem(pending)).toMatchObject({
      type: "PENDING",
      blocksApi: false,
      scopeMeasure: null,
      status: "open",
    });
  });

  it("rejects a PENDING item that attempts to block the API", () => {
    expect(() => validateResolutionItem({ ...pending, blocksApi: true })).toThrow(
      "PENDING items cannot block the API",
    );
  });

  it("requires named measures for HOLD items", () => {
    expect(() => validateResolutionItem({ ...pending, code: "H99", type: "HOLD" })).toThrow(
      "scopeMeasure is required for a HOLD",
    );
    expect(validateResolutionItem({
      ...pending,
      code: "H99",
      type: "HOLD",
      scopeMeasure: "margin, gross contribution",
    })).toMatchObject({
      type: "HOLD",
      blocksApi: true,
      scopeMeasure: "margin, gross contribution",
    });
  });

  it("rejects unknown fields and malformed dates", () => {
    expect(() => validateResolutionItem({ ...pending, unexpected: true })).toThrow(
      "Unknown or invalid fields",
    );
    expect(() => validateResolutionItem({ ...pending, raisedOn: "14-09-2026" })).toThrow(
      "raisedOn must be YYYY-MM-DD",
    );
  });

  it("treats every non-open status as closed", () => {
    expect(isResolutionItemClosed("open")).toBe(false);
    expect(isResolutionItemClosed("answered")).toBe(true);
    expect(isResolutionItemClosed("resolved")).toBe(true);
    expect(isResolutionItemClosed("accepted-as-is")).toBe(true);
  });

  it("does not allow a newly added row to claim a closed status", () => {
    expect(() => validateResolutionItem({ ...pending, status: "answered" })).toThrow(
      "New resolution items must start with status open",
    );
  });
});