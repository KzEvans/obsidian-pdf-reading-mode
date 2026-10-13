import { strict as assert } from "node:assert";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import type { ReaderBlock, ReaderDocument } from "../src/types.js";
import type { ReaderRenderOptions } from "../src/render.js";

interface Harness {
  document: Document;
  calls: string[];
  loaded: boolean;
  invalidFormula?: string;
}

const harnessGlobal = globalThis as typeof globalThis & { __readerHarness: Harness };
const renderer = build({
  entryPoints: [new URL("../src/render.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node", target: "es2021",
  plugins: [{
    name: "obsidian-test-api",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
        export async function loadMathJax() {
          const h = globalThis.__readerHarness;
          h.calls.push('load:start'); await Promise.resolve();
          h.loaded = true; h.calls.push('load:ready');
        }
        export function renderMath(source, display) {
          const h = globalThis.__readerHarness;
          if (!h.loaded) throw new Error('MathJax not loaded');
          h.calls.push('math:' + source);
          const node = h.document.createElement('span');
          node.className = 'test-math'; node.dataset.source = source;
          node.dataset.display = String(display); node.textContent = source;
          if (source === h.invalidFormula) {
            const error = h.document.createElement('mjx-merror');
            error.setAttribute('data-mjx-error', 'invalid TeX'); node.append(error);
          }
          return node;
        }
        export async function finishRenderMath() { globalThis.__readerHarness.calls.push('flush'); }
        export function sanitizeHTMLToDom(html) {
          const template = globalThis.__readerHarness.document.createElement('template');
          template.innerHTML = html; return template.content;
        }
      ` }));
    },
  }],
}).then(async (result) => {
  const code = result.outputFiles[0]!.text;
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as typeof import("../src/render.js");
});

async function render(
  blocks: ReaderBlock[], invalidFormula?: string, extraOptions: Partial<ReaderRenderOptions> = {},
  beforeRender?: (root: HTMLElement) => void,
) {
  const { document: dom } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const document = dom as unknown as Document;
  const root = document.createElement("div");
  document.body.append(root);
  harnessGlobal.__readerHarness = { document, calls: [], loaded: false, invalidFormula };
  beforeRender?.(root);
  const reader: ReaderDocument = { schemaVersion: 1, sourceHash: "test", parserSignature: "test", pageCount: 2, blocks, warnings: [] };
  const options: ReaderRenderOptions = { fontSize: 18, lineHeight: 1.5, assetUrl: () => "", onSource: () => {}, onCopy: () => {}, onZoom: () => {}, ...extraOptions };
  await (await renderer).renderReader(root, reader, options);
  return { root, harness: harnessGlobal.__readerHarness };
}

function block(id: string, kind: ReaderBlock["kind"], text: string, extra: Partial<ReaderBlock> = {}): ReaderBlock {
  return { id, kind, text, sources: [{ page: 1 }], ...extra };
}

test("cold-start rendering waits for MathJax before both block and inline formulas", async () => {
  const { root, harness } = await render([
    block("equation", "equation", "$$S_z = -p/Y$$"),
    block("body", "paragraph", "The field is $E=U/d$."),
  ]);
  assert.deepEqual(harness.calls, ["load:start", "load:ready", "math:S_z = -p/Y", "math:E=U/d", "flush"]);
  assert.equal(root.querySelectorAll(".test-math").length, 2);
  assert.equal(root.querySelectorAll(".pdf-reader-math-fallback").length, 0);
});

test("scientific tags in text, captions and footnotes coexist with comparisons and TeX", async () => {
  const { root } = await render([
    block("body", "paragraph", "ZrO<sub>2</sub> has units m<sup>3</sup>; $x < y & z$ and 2 < 3."),
    block("figure", "figure", "", { captions: ["Fig. 4. (SEHAS)<sub>2</sub> at $T=20$."], footnotes: ["<sup>a</sup> Measured value."] }),
  ]);
  assert.equal(root.querySelector(".pdf-reader-paragraph sub")?.textContent, "2");
  assert.equal(root.querySelector(".pdf-reader-paragraph sup")?.textContent, "3");
  assert.equal(root.querySelector("figcaption sub")?.textContent, "2");
  assert.equal(root.querySelector(".pdf-reader-figure-footnotes sup")?.textContent, "a");
  assert.equal(root.querySelector<HTMLElement>(".pdf-reader-paragraph .test-math")?.dataset.source, "x < y & z");
  assert.ok(root.textContent?.includes("2 < 3"));
  assert.ok(!root.textContent?.includes("<sub>"));
});

test("native-text HTML entities are decoded once without becoming executable markup", async () => {
  const { root } = await render([
    block("native", "paragraph", "ε₀ &lt; μ &amp; m<sup>3</sup> &lt;img src=x onerror=run()&gt;"),
  ]);
  assert.ok(root.textContent?.includes("ε₀ < μ & m3 <img src=x onerror=run()>"));
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.equal(root.querySelector("sup")?.textContent, "3");
});

test("inline markup keeps superscripts while stripping handlers and active links", async () => {
  const { root } = await render([
    block("unsafe", "paragraph", '<sup onclick="run()" style="color:red">3</sup> <a href="javascript:run()">value</a> $x < y$'),
    block("table", "table", "", { html: '<table><tr><td onclick="run()"><img src="https://invalid.test/remote.png">cell</td></tr></table>' }),
  ]);
  assert.equal(root.querySelector("sup")?.textContent, "3");
  assert.equal(root.querySelectorAll("[onclick], [style], a[href], img[src], script").length, 0);
  assert.equal(root.querySelector("td"), null);
  assert.equal(root.querySelector<HTMLElement>(".test-math")?.dataset.source, "x < y");
});

test("malformed scientific formulas remain verbatim with a source-page control", async () => {
  const invalid = "T_{g}^{a)/°C";
  const { root } = await render([block("bad", "paragraph", `Temperature $${invalid}$.`)], invalid);
  assert.equal(root.querySelector(".pdf-reader-math-fallback")?.textContent, invalid);
  assert.ok(root.querySelector(".has-math-fallback .pdf-reader-block-tools button"));
  assert.equal(root.querySelectorAll("mjx-merror").length, 0);
});

test("tables always use the local original-PDF crop with selectable captions and scientific footnotes", async () => {
  const zoomCaptions: string[] = [];
  const { root } = await render([
    block("table", "table", "Cloud OCR cell data", { asset: "fallback/table.png", html: "<table><tr><td>Reconstructed cell</td><td>$E=U/d$</td></tr></table>", captions: ["Table 3. Original measurements."], footnotes: ["<sup>a</sup> Measured at $T=20$."] }),
  ], undefined, { assetUrl: () => "app://local/fallback/table.png", onZoom: (_url, caption) => zoomCaptions.push(caption) });
  const original = root.querySelector('[data-reader-block-id="table"]')!;
  const image = original.querySelector<HTMLImageElement>("img")!;
  assert.equal(image.getAttribute("src"), "app://local/fallback/table.png");
  assert.equal(original.querySelector("table"), null);
  assert.ok(!original.textContent?.includes("Reconstructed cell"));
  assert.ok(!original.textContent?.includes("Cloud OCR cell data"));
  assert.equal(original.querySelector(".pdf-reader-math-fallback"), null);
  assert.equal(original.querySelector("figcaption")?.textContent, "Table 3. Original measurements.");
  assert.equal(original.querySelector(".pdf-reader-figure-footnotes sup")?.textContent, "a");
  assert.equal(original.querySelector<HTMLElement>(".pdf-reader-figure-footnotes .test-math")?.dataset.source, "T=20");
  assert.ok(original.querySelector(".pdf-reader-block-tools button"));
  image.dispatchEvent(new root.ownerDocument.defaultView!.Event("click"));
  assert.deepEqual(zoomCaptions, ["Table 3. Original measurements."]);
});

test("a missing table source crop prompts the source page instead of rendering provider HTML", async () => {
  const { root } = await render([
    block("table", "table", "Cloud OCR cell data", { html: "<table><tr><td>Reconstructed cell</td></tr></table>", captions: ["Table 1. Caption kept."] }),
  ]);
  assert.equal(root.querySelector("table"), null);
  assert.equal(root.querySelector("img"), null);
  assert.ok(root.querySelector(".pdf-reader-render-notice")?.textContent?.includes("查看源页"));
  assert.ok(!root.textContent?.includes("Reconstructed cell"));
  assert.ok(!root.textContent?.includes("Cloud OCR cell data"));
  assert.equal(root.querySelector("figcaption")?.textContent, "Table 1. Caption kept.");
  assert.ok(root.querySelector(".pdf-reader-block-tools button"));
});

test("ancillary folds move to section ends without changing body or figure order", async () => {
  const { root } = await render([
    block("heading-1", "heading", "Introduction"),
    block("body-1", "paragraph", "First paragraph."),
    block("header", "header", "Journal header"),
    block("body-2", "paragraph", "Second paragraph."),
    block("figure", "figure", "panel OCR", { captions: ["Fig. 1. Scientific caption."] }),
    block("metadata", "metadata", "Publisher information"),
    block("body-3", "paragraph", "Third paragraph."),
    block("heading-2", "heading", "Results"),
    block("body-4", "paragraph", "Result paragraph."),
    block("footer", "footer", "Last-page footer"),
  ]);
  const article = root.querySelector("article")!;
  const direct = Array.from(article.children).map((element) => (element as HTMLElement).dataset.readerBlockId ?? (element as HTMLElement).dataset.foldKind);
  assert.deepEqual(direct, ["heading-1", "body-1", "body-2", "figure", "body-3", "page-furniture", "metadata", "heading-2", "body-4", "page-furniture"]);
  assert.equal(root.querySelector('[data-reader-block-id="header"]')?.closest("details")?.nextElementSibling?.getAttribute("data-fold-kind"), "metadata");
  assert.equal(root.querySelector('[data-reader-block-id="metadata"]')?.closest("details")?.nextElementSibling?.getAttribute("data-reader-block-id"), "heading-2");
});

test("references coalesce across page headers while staying after the body", async () => {
  const { root } = await render([
    block("body", "paragraph", "Last body paragraph."),
    block("references-heading", "heading", "References"),
    block("reference-1", "references", "[1] First source."),
    block("header", "header", "Repeated journal header", { sources: [{ page: 2 }] }),
    block("reference-2", "references", "[2] Second source.", { sources: [{ page: 2 }] }),
    block("footer", "footer", "Page 2", { sources: [{ page: 2 }] }),
  ]);
  const references = root.querySelectorAll('details[data-fold-kind="references"]');
  assert.equal(references.length, 1);
  assert.deepEqual(Array.from(references[0]!.querySelectorAll<HTMLElement>("[data-reader-block-id]")).map((element) => element.dataset.readerBlockId), ["references-heading", "reference-1", "reference-2"]);
  assert.equal(references[0]!.previousElementSibling?.getAttribute("data-fold-kind"), "page-furniture");
  assert.equal(references[0]!.previousElementSibling?.previousElementSibling?.getAttribute("data-reader-block-id"), "body");
  assert.equal(references[0]!.nextElementSibling, null);
  assert.equal(root.querySelector('[data-reader-block-id="header"]')?.closest("details")?.getAttribute("data-fold-kind"), "page-furniture");
  const geometry = { top: 0, left: 0, right: 500, bottom: 500, width: 500, height: 500, x: 0, y: 0, toJSON: () => ({}) };
  root.getBoundingClientRect = () => geometry;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(".pdf-reader-block"))) element.getBoundingClientRect = () => geometry;
  (await renderer).scrollToSourcePage(root, 2);
  assert.equal((references[0] as HTMLDetailsElement).open, true);
  assert.ok(!(root.querySelector('details[data-fold-kind="page-furniture"]') as HTMLDetailsElement).open);
});

test("a page link prioritizes that page's body over an earlier paragraph spanning both pages", async () => {
  const { root } = await render([
    block("continued", "paragraph", "A long paragraph begins on page one.", { sources: [{ page: 1 }, { page: 2 }] }),
    block("page-two", "paragraph", "The next paragraph starts on page two.", { sources: [{ page: 2 }] }),
  ]);
  const rectangle = (top: number) => ({ top, left: 0, right: 500, bottom: top + 80, width: 500, height: 80, x: 0, y: top, toJSON: () => ({}) });
  root.scrollTop = 0;
  root.getBoundingClientRect = () => rectangle(0);
  root.querySelector<HTMLElement>('[data-reader-block-id="continued"]')!.getBoundingClientRect = () => rectangle(100);
  root.querySelector<HTMLElement>('[data-reader-block-id="page-two"]')!.getBoundingClientRect = () => rectangle(200);
  (await renderer).scrollToSourcePage(root, 2);
  assert.equal(root.scrollTop, 176);
});

test("figure OCR text is omitted while real captions, footnotes and numbered caption fallback remain", async () => {
  const zoomCaptions: string[] = [];
  const { root } = await render([
    block("figure-ocr", "figure", "(a) (b) SEHAS random axis labels", { asset: "diagram.png", captions: ["Fig. 1. Network structure."], footnotes: ["Measured at room temperature."] }),
    block("figure-empty", "figure", "(c) stray graphic OCR"),
    block("figure-caption", "figure", "Figure 2. Schematic network."),
  ], undefined, { assetUrl: () => "app://local/diagram.png", onZoom: (_url, caption) => zoomCaptions.push(caption) });
  assert.ok(!root.textContent?.includes("random axis labels"));
  assert.ok(!root.textContent?.includes("stray graphic OCR"));
  assert.equal(root.querySelectorAll("figcaption").length, 2);
  assert.ok(root.textContent?.includes("Fig. 1. Network structure."));
  assert.ok(root.textContent?.includes("Measured at room temperature."));
  assert.equal(root.querySelector('[data-reader-block-id="figure-caption"] figcaption')?.textContent, "Figure 2. Schematic network.");
  const image = root.querySelector<HTMLImageElement>("img")!;
  assert.ok(image.alt.includes("random axis labels"));
  image.dispatchEvent(new root.ownerDocument.defaultView!.Event("click"));
  assert.deepEqual(zoomCaptions, ["Fig. 1. Network structure."]);
});

test("lazy figure and equation images reserve supplied dimensions without decoding", async () => {
  let decodes = 0;
  const dimensionsRequested: string[] = [];
  const { root } = await render([
    block("figure", "figure", "", { asset: "figure.png" }),
    block("equation", "equation", "$$invalid$$", { asset: "equation.png" }),
  ], "invalid", {
    assetUrl: reference => `app://local/${reference}`,
    assetDimensions: reference => { dimensionsRequested.push(reference); return { width: 900, height: 450 }; },
  }, root => {
    const document = root.ownerDocument;
    const create = document.createElement.bind(document);
    document.createElement = ((name: string, options?: ElementCreationOptions) => {
      const element = create(name, options);
      if (name === "img") Object.defineProperty(element, "decode", { value: () => { decodes++; return new Promise(() => {}); } });
      return element;
    }) as Document["createElement"];
  });
  assert.equal(decodes, 0);
  assert.deepEqual(dimensionsRequested, ["figure.png", "equation.png"]);
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    assert.equal(image.loading, "lazy");
    assert.equal(image.getAttribute("width"), "900");
    assert.equal(image.getAttribute("height"), "450");
    assert.equal(image.style.aspectRatio, "900 / 450");
    assert.equal(image.dataset.readerLayoutReserved, "true");
  }
});

test("an image with no header dimensions learns its natural ratio on load", async () => {
  const { root } = await render([block("figure", "figure", "", { asset: "figure.png" })], undefined, {
    assetUrl: () => "app://local/figure.png",
  });
  const image = root.querySelector<HTMLImageElement>("img")!;
  assert.equal(image.getAttribute("width"), null);
  Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 320 } });
  image.dispatchEvent(new root.ownerDocument.defaultView!.Event("load"));
  assert.equal(image.getAttribute("width"), "640");
  assert.equal(image.getAttribute("height"), "320");
  assert.equal(image.style.aspectRatio, "640 / 320");
  assert.notEqual(image.dataset.readerLayoutReserved, "true");
});

test("text-only documents do not wait for MathJax", async () => {
  const { harness } = await render([block("body", "paragraph", "A paragraph without formulas.")]);
  assert.deepEqual(harness.calls, []);
});

test("long rendering yields with partial DOM while keeping every formula and source block", async () => {
  let partialBlocks = -1;
  const blocks = Array.from({ length: 125 }, (_, index) => block(`body-${index}`, "paragraph", `Formula $x_${index}=1$.`));
  const { root, harness } = await render(blocks, undefined, {}, root => {
    setTimeout(() => { partialBlocks = root.querySelectorAll("[data-reader-block-id]").length; }, 0);
  });
  assert.ok(partialBlocks > 0 && partialBlocks < blocks.length, `rendered during yield: ${partialBlocks}`);
  assert.equal(root.querySelectorAll("[data-reader-block-id]").length, 125);
  assert.equal(root.querySelectorAll(".test-math").length, 125);
  assert.equal(harness.calls.filter(call => call.startsWith("math:")).length, 125);
  assert.equal(harness.calls.filter(call => call === "flush").length, 1);
});

test("cancelling a long render at its first yield stops later blocks and formulas", async () => {
  let current = true;
  const blocks = Array.from({ length: 125 }, (_, index) => block(`body-${index}`, "paragraph", `Formula $x_${index}=1$.`));
  const { root, harness } = await render(blocks, undefined, { isCurrent: () => current }, () => {
    setTimeout(() => { current = false; }, 0);
  });
  const rendered = root.querySelectorAll("[data-reader-block-id]").length;
  assert.ok(rendered > 0 && rendered < blocks.length);
  assert.equal(harness.calls.filter(call => call.startsWith("math:")).length, rendered);
  assert.equal(harness.calls.includes("flush"), false);
});

function rectangle(top: number, height = 80, width = 500): DOMRect {
  return { top, left: 0, right: width, bottom: top + height, width, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

test("page tracker coalesces scroll frames and reuses cached geometry, then disposes listeners", async () => {
  const { root } = await render(Array.from({ length: 100 }, (_, index) =>
    block(`body-${index}`, "paragraph", "Body text.", { sources: [{ page: index + 1 }] })));
  let measurements = 0;
  root.scrollTop = 0;
  root.getBoundingClientRect = () => { measurements++; return rectangle(0, 500); };
  Array.from(root.querySelectorAll<HTMLElement>(".pdf-reader-block")).forEach((element, index) => {
    element.getBoundingClientRect = () => { measurements++; return rectangle(index * 100 - root.scrollTop, 90); };
  });
  const win = root.ownerDocument.defaultView!;
  const request = win.requestAnimationFrame;
  const cancel = win.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  win.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  win.cancelAnimationFrame = id => { frames.delete(id); };
  const pages: number[] = [];
  const tracker = (await renderer).createSourcePageTracker(root, page => pages.push(page));
  try {
    assert.equal(tracker.getPage(), 1);
    const initialMeasurements = measurements;
    for (let index = 0; index <= 100; index++) {
      root.scrollTop = index * 20;
      root.dispatchEvent(new win.Event("scroll"));
    }
    assert.equal(frames.size, 1);
    assert.equal(tracker.getPage(), 21);
    assert.equal((await renderer).getVisibleSourcePage(root), 21);
    assert.equal(measurements, initialMeasurements);
    const callback = frames.values().next().value!;
    frames.clear(); callback(0);
    assert.deepEqual(pages, [21]);
    assert.equal(measurements, initialMeasurements);
    root.dispatchEvent(new win.Event("scroll"));
    tracker.dispose();
    assert.equal(frames.size, 0);
    root.dispatchEvent(new win.Event("scroll"));
    assert.equal(frames.size, 0);
    assert.equal(tracker.getPage(), undefined);
  } finally { tracker.dispose(); win.requestAnimationFrame = request; win.cancelAnimationFrame = cancel; }
});

test("page tracker handles hidden roots, closed folds, toggling and resize", async () => {
  const { root } = await render([
    block("reference-1", "references", "First source."),
    block("reference-2", "references", "Second source.", { sources: [{ page: 2 }] }),
    block("body", "paragraph", "Following body.", { sources: [{ page: 3 }] }),
  ]);
  root.scrollTop = 125;
  let height = 0;
  let bodyTop = 100;
  root.getBoundingClientRect = () => rectangle(0, height);
  const fold = root.querySelector<HTMLDetailsElement>("details")!;
  root.querySelector<HTMLElement>("summary")!.getBoundingClientRect = () => rectangle(-root.scrollTop, 30);
  root.querySelector<HTMLElement>('[data-reader-block-id="reference-1"]')!.getBoundingClientRect = () => rectangle(40 - root.scrollTop, 90);
  root.querySelector<HTMLElement>('[data-reader-block-id="reference-2"]')!.getBoundingClientRect = () => rectangle(140 - root.scrollTop, 100);
  root.querySelector<HTMLElement>('[data-reader-block-id="body"]')!.getBoundingClientRect = () => rectangle(bodyTop - root.scrollTop, 100);
  const tracker = (await renderer).createSourcePageTracker(root, () => {});
  try {
    assert.equal(tracker.getPage(), undefined);
    height = 500;
    assert.equal(tracker.getPage(), 3);
    fold.setAttribute("open", ""); bodyTop = 500;
    fold.dispatchEvent(new root.ownerDocument.defaultView!.Event("toggle", { bubbles: true }));
    assert.equal(tracker.getPage(), 2);
    root.scrollTop = 400;
    root.ownerDocument.defaultView!.dispatchEvent(new root.ownerDocument.defaultView!.Event("resize"));
    assert.equal(tracker.getPage(), 3);
  } finally { tracker.dispose(); }
});

test("an unknown-size image load invalidates page offsets while reserved image loads do not", async () => {
  const { root } = await render([
    block("unknown", "figure", "", { asset: "unknown.png" }),
    block("body", "paragraph", "Body on page two.", { sources: [{ page: 2 }] }),
    block("reserved", "figure", "", { asset: "reserved.png", sources: [{ page: 2 }] }),
  ], undefined, { assetUrl: reference => `app://local/${reference}`,
    assetDimensions: reference => reference === "reserved.png" ? { width: 100, height: 50 } : undefined });
  root.scrollTop = 0;
  let measurements = 0;
  let bodyTop = 120;
  root.getBoundingClientRect = () => rectangle(0, 500);
  const unknown = root.querySelector<HTMLElement>('[data-reader-block-id="unknown"]')!;
  unknown.getBoundingClientRect = () => { measurements++; return rectangle(-root.scrollTop, bodyTop); };
  root.querySelector<HTMLElement>('[data-reader-block-id="body"]')!.getBoundingClientRect = () => { measurements++; return rectangle(bodyTop - root.scrollTop, 100); };
  const reserved = root.querySelector<HTMLElement>('[data-reader-block-id="reserved"]')!;
  reserved.getBoundingClientRect = () => { measurements++; return rectangle(bodyTop + 120 - root.scrollTop, 60); };
  const tracker = (await renderer).createSourcePageTracker(root, () => {});
  try {
    tracker.getPage();
    const initial = measurements;
    reserved.querySelector("img")!.dispatchEvent(new root.ownerDocument.defaultView!.Event("load", { bubbles: true }));
    tracker.getPage();
    assert.equal(measurements, initial);
    const image = unknown.querySelector<HTMLImageElement>("img")!;
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 400 } });
    bodyTop = 400;
    image.dispatchEvent(new root.ownerDocument.defaultView!.Event("load", { bubbles: true }));
    root.scrollTop = 150;
    assert.equal(tracker.getPage(), 1);
    assert.ok(measurements > initial);
  } finally { tracker.dispose(); }
});

test("page tracker reports rebuild attempts and isolated invalidation counters without counting scrolls", async () => {
  const { root } = await render([block("body", "paragraph", "Body text.")]);
  const win = root.ownerDocument.defaultView!;
  const originalObserver = win.ResizeObserver;
  const originalRequest = win.requestAnimationFrame;
  const originalCancel = win.cancelAnimationFrame;
  let observerCallback: ResizeObserverCallback | undefined;
  win.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  let height = 0;
  root.scrollTop = 0;
  root.getBoundingClientRect = () => rectangle(0, height);
  root.querySelector<HTMLElement>(".pdf-reader-block")!.getBoundingClientRect = () => rectangle(-root.scrollTop, 100);
  const image = root.ownerDocument.createElement("img");
  const reserved = root.ownerDocument.createElement("img");
  reserved.dataset.readerLayoutReserved = "true";
  root.append(image, reserved);
  const tracker = (await renderer).createSourcePageTracker(root, () => {});
  try {
    assert.equal(tracker.getPage(), undefined);
    assert.equal(tracker.getPage(), undefined);
    assert.equal(tracker.getStats().rebuilds, 2);
    height = 500;
    assert.equal(tracker.getPage(), 1);
    for (let index = 0; index < 20; index++) {
      root.dispatchEvent(new win.Event("scroll"));
      tracker.getPage();
    }
    assert.deepEqual(tracker.getStats().invalidations, {});
    assert.equal(tracker.getStats().rebuilds, 3);
    reserved.dispatchEvent(new win.Event("load", { bubbles: true }));
    tracker.getPage();
    assert.equal(tracker.getStats().rebuilds, 3);
    image.dispatchEvent(new win.Event("load", { bubbles: true }));
    root.dispatchEvent(new win.Event("error"));
    root.dispatchEvent(new win.Event("toggle"));
    win.dispatchEvent(new win.Event("resize"));
    observerCallback!([], {} as ResizeObserver);
    tracker.getPage();
    const stats = tracker.getStats();
    assert.equal(stats.rebuilds, 4);
    assert.ok(Number.isFinite(stats.rebuildMs) && stats.rebuildMs >= 0);
    assert.deepEqual(stats.invalidations, { load: 1, error: 1, toggle: 1, "window-resize": 1, "resize-observer": 1 });
    stats.rebuilds = 999;
    stats.invalidations.load = 999;
    assert.equal(tracker.getStats().rebuilds, 4);
    assert.equal(tracker.getStats().invalidations.load, 1);
  } finally {
    tracker.dispose();
    win.ResizeObserver = originalObserver;
    win.requestAnimationFrame = originalRequest;
    win.cancelAnimationFrame = originalCancel;
  }
});
