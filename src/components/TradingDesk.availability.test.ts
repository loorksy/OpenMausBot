import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("trading room client", () => {
  it("does not paint idle or a known pause before the server snapshot", () => {
    const source = readFileSync(new URL("./TradingDesk.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('?? "IDLE"');
    expect(source).toContain("UNAVAILABLE");
    expect(source).toContain("الحضور غير متاح");
    expect(source).toContain("الإيقاف المؤقت غير متاح");
    expect(source).toContain("مفتاح الإيقاف غير متاح");
    expect(source).toContain("القرار غير متاح");
    expect(source).toContain("المخاطر والسياسة غير متاحة");
    expect(source).toContain("الصفقة والتنفيذ غير متاحين");
    expect(source).toContain("المراقبة غير متاحة");
    expect(source).toContain("المحادثة غير متاحة");
    expect(source).not.toContain("derivePositionLifecycle");
  });
});
