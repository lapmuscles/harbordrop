/** 純 SVG 長條圖的幾何計算（不依賴圖表套件） */
export interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: number;
}

export function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function layoutBars(
  data: { label: string; value: number }[],
  opts: { width: number; height: number; padLeft?: number; padBottom?: number; padTop?: number; gap?: number },
): { bars: Bar[]; max: number; ticks: { y: number; value: number }[] } {
  const { width, height, padLeft = 32, padBottom = 22, padTop = 8, gap = 0.3 } = opts;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotH = height - padBottom - padTop;
  const slot = data.length ? (width - padLeft) / data.length : 0;
  const w = slot * (1 - gap);
  const bars = data.map((d, i) => {
    const h = max ? (d.value / max) * plotH : 0;
    return { x: padLeft + i * slot + (slot - w) / 2, y: padTop + plotH - h, w, h, label: d.label, value: d.value };
  });
  const ticks = [0, 0.5, 1].map((f) => ({ y: padTop + plotH - f * plotH, value: Math.round(max * f) }));
  return { bars, max, ticks };
}
