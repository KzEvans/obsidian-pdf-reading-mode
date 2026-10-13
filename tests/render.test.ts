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

async function render(blocks: ReaderBlock[], invalidFormula?: string, extraOptions: Partial<ReaderRenderOptions> = {}) {
  const { document: dom } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const document = dom as unknown as Document;
  const root = document.createElement("div");
  document.body.append(root);
  harnessGlobal.__readerHarness = { document, calls: [], loaded: false, invalidFormula };
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
