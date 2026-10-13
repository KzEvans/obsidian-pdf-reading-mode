import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractNativeRegion } from "../src/native-text.js";

const viewport = {
  width: 600, height: 800, scale: 1,
  convertToViewportPoint: (x: number, y: number): [number, number] => [x, 800 - y],
};
const region: [number, number, number, number] = [0.05, 0.05, 0.8, 0.3];
function item(str: string, x: number, baseline: number, width: number, size = 12) {
  return { str, width, height: size, transform: [size, 0, 0, size, x, 800 - baseline] };
}

test("groups by baseline and joins wrapped lines in geometric order", () => {
  const items = [
    item("continues.", 40, 115, 54), item("line", 74, 100, 20),
    item("First", 40, 100, 29),
  ];
  assert.equal(extractNativeRegion(items, viewport, region), "First line continues.");
});

test("normalizes a word ligature without adding a word gap or superscript", () => {
  const items = [item("The ", 40, 100, 24), item("ﬁ", 64, 96, 5, 8), item("lm", 69.2, 100, 12)];
  assert.equal(extractNativeRegion(items, viewport, region), "The film");
});

test("recovers a lowered smaller digit as the chemical subscript ZrO2", () => {
  const items = [item("ZrO", 40, 100, 24), item("2", 64.2, 103.5, 5, 8), item(" film", 76, 100, 24)];
  assert.equal(extractNativeRegion(items, viewport, region), "ZrO<sub>2</sub> film");
});

test("recovers an elevated smaller digit as a unit superscript", () => {
  assert.equal(extractNativeRegion([
    item("m", 40, 100, 8), item("3", 48.1, 96, 4, 8),
  ], viewport, region), "m<sup>3</sup>");
});

test("only item centers in the requested bbox are selected", () => {
  const box: [number, number, number, number] = [0.1, 0.1, 0.3, 0.2];
  const items = [
    item("outside left", 0, 120, 40), item("inside", 70, 120, 35),
    item("outside right", 250, 120, 70), item("outside below", 70, 240, 80),
  ];
  assert.equal(extractNativeRegion(items, viewport, box), "inside");
});

test("uses scaled viewport coordinates and tolerates a small bbox rounding error", () => {
  const scaled = { width: 1200, height: 1600, scale: 2,
    convertToViewportPoint: (x: number, y: number): [number, number] => [x * 2, (800 - y) * 2] };
  const box: [number, number, number, number] = [0.1, 0.1, 0.2, 0.2];
  assert.equal(extractNativeRegion([item("edge", 48, 100, 22)], scaled, box), "edge");
});

test("escapes HTML while preserving scientific symbols and Unicode scripts", () => {
  assert.equal(extractNativeRegion([
    item('ε₀ < μ & m³ “film”', 40, 100, 125),
  ], viewport, region), 'ε₀ &lt; μ &amp; m³ “film”');
  assert.equal(extractNativeRegion([
    item('<b title="x">µ\'s</b>', 40, 100, 125),
  ], viewport, region), '&lt;b title=&quot;x&quot;&gt;µ&#39;s&lt;/b&gt;');
});

test("an obvious persistent two-column gutter falls back to the source crop", () => {
  const items = [
    item("Left first", 40, 100, 140), item("Right first", 320, 100, 130),
    item("Left second", 40, 115, 135), item("Right second", 320, 115, 135),
  ];
  assert.equal(extractNativeRegion(items, viewport, region), "");
});

test("a single title with a large word gap is not treated as two columns", () => {
  assert.equal(extractNativeRegion([
    item("Scientific", 40, 100, 65), item("title", 140, 100, 30),
  ], viewport, region), "Scientific title");
});

test("missing text, invalid boxes, and rotated writing return no guessed text", () => {
  assert.equal(extractNativeRegion([], viewport, region), "");
  assert.equal(extractNativeRegion([item("word", 40, 100, 20)], viewport, [0.5, 0, 0.2, 1]), "");
  assert.equal(extractNativeRegion([
    { str: "vertical", width: 60, height: 12, transform: [0, 12, -12, 0, 50, 700] },
  ], viewport, region), "");
});
