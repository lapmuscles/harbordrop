import { describe, expect, it } from "vitest";
import { layoutBars, niceMax } from "../src/pages/admin/barchart";

describe("SVG 長條圖", () => {
  it("niceMax 取整", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(230)).toBe(250);
  });
  it("長條高度與值成比例且在繪圖區內", () => {
    const { bars, max } = layoutBars([{ label: "a", value: 0 }, { label: "b", value: 5 }, { label: "c", value: 10 }], { width: 332, height: 130, padLeft: 32, padBottom: 22, padTop: 8 });
    expect(max).toBe(10);
    expect(bars[0].h).toBe(0);
    expect(bars[2].h).toBe(100);
    expect(bars[1].h).toBe(50);
    expect(bars[2].y).toBe(8);
    expect(bars[2].x + bars[2].w).toBeLessThanOrEqual(332);
  });
});
