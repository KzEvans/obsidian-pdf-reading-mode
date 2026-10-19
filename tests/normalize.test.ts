import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ligatureSuperscriptCandidate, normalizeContentList } from "../src/normalize.js";

const normalize = (items: unknown, pageCount = 9) => normalizeContentList(items, "pdf-hash", "mineru-v4-vlm", pageCount);

test("provider reading order survives interleaved two-column coordinates", () => {
  const doc = normalize([
    { type: "text", text: "Left column starts", page_idx: 0, bbox: [70, 700, 460, 900] },
    { type: "text", text: "Left column continues", page_idx: 0, bbox: [70, 50, 460, 150] },
    { type: "text", text: "Right column follows", page_idx: 0, bbox: [550, 20, 920, 100] },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.text), ["Left column starts", "Left column continues", "Right column follows"]);
  assert.deepEqual(doc.blocks[0]?.sources, [{ page: 1, bbox: [0.07, 0.7, 0.46, 0.9] }]);
  assert.equal(doc.pageCount, 9);
});

test("figures, captions, and scientific footnotes remain one ordered block", () => {
  const doc = normalize([
    { type: "text", text: "See Fig. 2", page_idx: 1 },
    { type: "image", img_path: "paper/images/fig2.jpg", image_caption: ["Fig. 2. Mechanical properties."], image_footnote: ["n = 5; error bars show standard deviation."], page_idx: 1 },
    { type: "text", text: "The next paragraph", page_idx: 1 },
  ]);
  assert.equal(doc.blocks.length, 3);
  assert.equal(doc.blocks[1]?.kind, "figure");
  assert.equal(doc.blocks[1]?.asset, "paper/images/fig2.jpg");
  assert.deepEqual(doc.blocks[1]?.captions, ["Fig. 2. Mechanical properties."]);
  assert.deepEqual(doc.blocks[1]?.footnotes, ["n = 5; error bars show standard deviation."]);
  assert.deepEqual(doc.blocks[1]?.sources, [{ page: 2 }]);
});

test("table HTML is retained with its caption and meaningful superscript text", () => {
  const html = '<table><tr><td>E</td><td>3.4 MJ/m<sup>3</sup></td></tr></table>';
  const doc = normalize([{ type: "table", table_body: html, table_caption: ["Table 1. Performance."], table_footnote: ["a: measured at 240 V."], img_path: "images/t1.jpg", page_idx: 2 }]);
  assert.equal(doc.blocks[0]?.html, html);
  assert.equal(doc.blocks[0]?.kind, "table");
  assert.match(doc.blocks[0]?.text ?? "", /3\.4 MJ\/m3/);
  assert.deepEqual(doc.blocks[0]?.footnotes, ["a: measured at 240 V."]);
});

test("formula LaTeX and image fallback are preserved", () => {
  const doc = normalize([{ type: "equation", text: "$$p = \\epsilon E^2$$", img_path: "images/equation.jpg", page_idx: 3 }]);
  assert.equal(doc.blocks[0]?.kind, "equation");
  assert.equal(doc.blocks[0]?.text, "$$p = \\epsilon E^2$$");
  assert.equal(doc.blocks[0]?.asset, "images/equation.jpg");
});

test("publication metadata folds conservatively without deleting author content", () => {
  const doc = normalize([
    { type: "text", text: "Ultrasoft-yet-strong elastomer", text_level: 1, page_idx: 0 },
    { type: "text", text: "Zheqi Chen, Rui Xiao, Yingwu Luo", page_idx: 0 },
    { type: "text", text: "State Key Laboratory of Chemical Engineering, Zhejiang University, China", page_idx: 0 },
    { type: "text", text: "Abstract", text_level: 1, page_idx: 0 },
    { type: "text", text: "The university measured the strain and modulus.", page_idx: 0 },
    { type: "page_footnote", text: "* Corresponding author: Yingwu Luo.", page_idx: 0 },
    { type: "footer", text: "Chemical Engineering Journal", page_idx: 0 },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.kind), ["heading", "metadata", "metadata", "heading", "paragraph", "metadata", "footer"]);
  assert.equal(doc.blocks[1]?.hiddenByDefault, true);
  assert.equal(doc.blocks[1]?.text, "Zheqi Chen, Rui Xiao, Yingwu Luo");
  assert.equal(doc.blocks[4]?.hiddenByDefault, undefined);
});

test("scientific page footnotes and superscripts or ligatures are not mistaken for metadata", () => {
  const scientific = "The ﬁlm has energy density 3.4 MJ/m³; ε₀ = 8.854 × 10⁻¹² F/m.";
  const doc = normalize([
    { type: "page_footnote", text: scientific, page_idx: 0 },
    { type: "text", text: "Author contributions affected neither voltage nor strain.", page_idx: 0 },
  ]);
  assert.equal(doc.blocks[0]?.kind, "footnote");
  assert.equal(doc.blocks[0]?.hiddenByDefault, undefined);
  assert.equal(doc.blocks[0]?.text, scientific);
  assert.equal(doc.blocks[1]?.kind, "paragraph");
});

test("references stop at acknowledgements, including an untagged section title", () => {
  const doc = normalize([
    { type: "text", text: "References", text_level: 1, page_idx: 6 },
    { type: "text", text: "[1] A research paper.", page_idx: 6 },
    { type: "text", text: "[2] Another paper.", page_idx: 7 },
    { type: "text", text: "Acknowledgements", page_idx: 7 },
    { type: "text", text: "We thank the laboratory staff.", page_idx: 7 },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.kind), ["heading", "references", "references", "heading", "paragraph"]);
  assert.equal(doc.blocks[1]?.hiddenByDefault, true);
  assert.equal(doc.blocks[4]?.hiddenByDefault, undefined);
});

test("provider reference lists retain every entry", () => {
  const doc = normalize([{ type: "list", sub_type: "ref_text", list_items: ["[1] First citation", "[2] Second citation"], page_idx: 8 }]);
  assert.equal(doc.blocks[0]?.kind, "references");
  assert.equal(doc.blocks[0]?.text, "[1] First citation\n[2] Second citation");
});

test("only explicit adjacent cross-page continuation merges and retains both sources", () => {
  const doc = normalize([
    { type: "text", text: "The specimen was", page_idx: 0, bbox: [50, 800, 450, 950] },
    { type: "text", text: "tested at 240 V.", page_idx: 1, bbox: [50, 50, 450, 120], continues_prev: true },
    { type: "text", text: "a new paragraph despite lowercase", page_idx: 2 },
  ]);
  assert.equal(doc.blocks.length, 2);
  assert.equal(doc.blocks[0]?.text, "The specimen was tested at 240 V.");
  assert.deepEqual(doc.blocks[0]?.sources.map(source => source.page), [1, 2]);
  assert.equal(doc.blocks[0]?.id, "block-1");
});

test("figures between fragments prevent an inferred continuation merge", () => {
  const doc = normalize([
    { type: "text", text: "Before figure", page_idx: 0 },
    { type: "image", img_path: "images/fig.jpg", page_idx: 0 },
    { type: "text", text: "after figure", page_idx: 1, continues_prev: true },
  ]);
  assert.equal(doc.blocks.length, 3);
});

test("unknown types and missing coordinates keep content without inventing a location", () => {
  const doc = normalize([
    { type: "future_annotation", content: { description: "Do not lose this scientific observation." }, page_idx: 1 },
    { type: "text", text: "No source page supplied" },
    { type: "text", text: "Malformed bbox", page_idx: 0, bbox: [1, 2, "x", 4] },
  ]);
  assert.equal(doc.blocks[0]?.kind, "paragraph");
  assert.equal(doc.blocks[0]?.text, "Do not lose this scientific observation.");
  assert.deepEqual(doc.blocks[1]?.sources, []);
  assert.deepEqual(doc.blocks[2]?.sources, [{ page: 1 }]);
  assert.equal(doc.warnings.length, 3);
});

test("unknown provider payload fields survive instead of becoming an empty block", () => {
  const doc = normalize([{ type: "future_science_note", explanation: "The correction is 0.32 ± 0.01.", page_idx: 0 }]);
  assert.equal(doc.blocks[0]?.text, "The correction is 0.32 ± 0.01.");
  assert.equal(doc.blocks[0]?.kind, "paragraph");
});

test("new MiddleJson or page-grouped JSON is rejected instead of misread as cloud V1", () => {
  assert.throws(() => normalize({ schema: "docvortex.middle", pages: [] }), /Content List/);
  assert.throws(() => normalize([[{ type: "paragraph" }]]), /Content List/);
});

test("multi-panel figure with an interleaved numbered caption becomes one source crop", () => {
  const doc = normalize([
    { type: "chart", chart_caption: ["(a)"], img_path: "a.jpg", page_idx: 4, bbox: [60, 68, 322, 272] },
    { type: "chart", chart_caption: ["(b)"], img_path: "b.jpg", page_idx: 4, bbox: [364, 66, 635, 272] },
    { type: "chart", chart_caption: ["(c)"], img_path: "c.jpg", page_idx: 4, bbox: [65, 277, 324, 479] },
    { type: "text", text: "Fig. 3. Mechanical performance of the copolymers.", page_idx: 4, bbox: [647, 66, 939, 153] },
    { type: "chart", chart_footnote: ["n = 5"], img_path: "d.jpg", page_idx: 4, bbox: [376, 278, 636, 479] },
    { type: "table", table_body: "<table><tr><td>Table values</td></tr></table>", page_idx: 4, bbox: [58, 528, 484, 615] },
  ]);
  assert.equal(doc.blocks.length, 2);
  assert.equal(doc.blocks[0]?.kind, "figure");
  assert.equal(doc.blocks[0]?.asset, undefined);
  assert.deepEqual(doc.blocks[0]?.sources, [
    { page: 5, bbox: [0.06, 0.066, 0.636, 0.479] },
    { page: 5, bbox: [0.647, 0.066, 0.939, 0.153] },
  ]);
  assert.deepEqual(doc.blocks[0]?.captions, ["Fig. 3. Mechanical performance of the copolymers."]);
  assert.equal(doc.blocks[0]?.text, "(a)\n(b)\n(c)");
  assert.deepEqual(doc.blocks[0]?.footnotes, ["n = 5"]);
  assert.equal(doc.blocks[1]?.kind, "table");
});

test("adjacent visuals without a confirmed caption remain separate", () => {
  const doc = normalize([
    { type: "image", img_path: "a.jpg", page_idx: 3, bbox: [50, 50, 400, 300] },
    { type: "chart", img_path: "b.jpg", page_idx: 3, bbox: [420, 50, 850, 300] },
    { type: "text", text: "Fig. 3 shows the effect on the measured strain.", page_idx: 3, bbox: [50, 320, 850, 370] },
  ]);
  assert.equal(doc.blocks.length, 3);
  assert.equal(doc.blocks[0]?.asset, "a.jpg");
  assert.equal(doc.blocks[2]?.kind, "paragraph");
});

test("a numbered caption ends the group before the next nearby figure", () => {
  const doc = normalize([
    { type: "chart", img_path: "4a.jpg", page_idx: 5, bbox: [100, 100, 400, 300] },
    { type: "chart", img_path: "4b.jpg", chart_caption: ["Figure 4. First complete figure."], page_idx: 5, bbox: [430, 100, 750, 300] },
    { type: "image", img_path: "5a.jpg", page_idx: 5, bbox: [100, 315, 400, 550] },
    { type: "chart", img_path: "5b.jpg", chart_caption: ["Figure 5. Next complete figure."], page_idx: 5, bbox: [430, 315, 750, 550] },
  ]);
  assert.equal(doc.blocks.length, 2);
  assert.deepEqual(doc.blocks.map(block => block.captions), [["Figure 4. First complete figure."], ["Figure 5. Next complete figure."]]);
  assert.deepEqual(doc.blocks.map(block => block.sources[0]?.bbox), [[0.1, 0.1, 0.75, 0.3], [0.1, 0.315, 0.75, 0.55]]);
});

test("graphical abstract title confirms a group containing in-region labels", () => {
  const doc = normalize([
    { type: "text", text: "G R A P H I C A L A B S T R A C T", page_idx: 0, bbox: [336, 359, 544, 370] },
    { type: "image", img_path: "diagram.jpg", page_idx: 0, bbox: [336, 385, 462, 525] },
    { type: "text", text: "Triblock SEHAS", page_idx: 0, bbox: [339, 470, 413, 481] },
    { type: "text", text: "Mechanical Property", text_level: 2, page_idx: 0, bbox: [510, 385, 642, 399] },
    { type: "chart", img_path: "chart.jpg", page_idx: 0, bbox: [470, 399, 648, 534] },
    { type: "chart", chart_caption: ["Actuation Performance"], img_path: "chart2.jpg", page_idx: 0, bbox: [650, 395, 840, 532] },
    { type: "text", text: "A R T I C L E I N F O", page_idx: 0, bbox: [58, 569, 189, 582] },
  ]);
  assert.equal(doc.blocks.length, 3);
  assert.equal(doc.blocks[0]?.kind, "heading");
  assert.equal(doc.blocks[1]?.kind, "figure");
  assert.equal(doc.blocks[1]?.asset, undefined);
  assert.deepEqual(doc.blocks[1]?.sources, [{ page: 1, bbox: [0.336, 0.385, 0.84, 0.534] }]);
  assert.equal(doc.blocks[1]?.captions, undefined);
  assert.equal(doc.blocks[1]?.text, "Triblock SEHAS\nMechanical Property\nActuation Performance");
  assert.equal(doc.blocks[2]?.text, "A R T I C L E I N F O");
});

test("author superscript markers are classified without modifying original text", () => {
  const authorLine = "Zheqi Chen<sup>a,1</sup>, Youhua Xiao<sup>a,c,1</sup>, Yingwu Luo<sup>a,b,c,⁎</sup>";
  const doc = normalize([
    { type: "text", text: "Article title", text_level: 1, page_idx: 0 },
    { type: "image", img_path: "logo.jpg", page_idx: 0, bbox: [838, 206, 887, 242] },
    { type: "text", text: authorLine, page_idx: 0 },
    { type: "page_footnote", text: "<sup>1</sup> Those authors contributed equally to this work.", page_idx: 0 },
    { type: "page_footnote", text: "<sup>1</sup>H NMR measured the sample composition.", page_idx: 0 },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.kind), ["heading", "metadata", "metadata", "metadata", "footnote"]);
  assert.equal(doc.blocks[2]?.text, authorLine);
  assert.equal(doc.blocks[4]?.hiddenByDefault, undefined);
});

test("ligature superscript repair produces a candidate while preserving scientific exponents", () => {
  const original = "arti<sup>fi</sup>cial muscle with energy 3.4 MJ/m<sup>3</sup>; <sup>1</sup>H NMR";
  assert.equal(ligatureSuperscriptCandidate(original), "artificial muscle with energy 3.4 MJ/m<sup>3</sup>; <sup>1</sup>H NMR");
  assert.match(original, /<sup>fi<\/sup>/);
});

test("first-page publisher controls and tiny icons fold while abstract art stays visible", () => {
  const items = [
    { type: "text", text: "pubs.acs.org/Biomac", page_idx: 0 },
    { type: "text", text: "Article", page_idx: 0 },
    { type: "text", text: "Research title", text_level: 1, page_idx: 0 },
    { type: "text", text: "Published as part of a virtual special issue. Yiting Cai and coauthors.", page_idx: 0 },
    { type: "image", img_path: "cite.jpg", bbox: [84, 240, 116, 265], page_idx: 0 },
    { type: "text", text: "Cite This: Biomacromolecules 2024, 25, 5019−5027", page_idx: 0 },
    { type: "image", img_path: "read.jpg", bbox: [514, 238, 548, 266], page_idx: 0 },
    { type: "text", text: "Read Online", page_idx: 0 },
    { type: "text", text: "ACCESS", page_idx: 0 },
    { type: "text", text: "Metrics & More", page_idx: 0 },
    { type: "text", text: "Article Recommendations", page_idx: 0 },
    { type: "text", text: "\\*sı Supporting Information", page_idx: 0 },
    { type: "text", text: "ABSTRACT: Our material gives a large area strain.", page_idx: 0 },
    { type: "image", img_path: "abstract.jpg", bbox: [614, 318, 914, 442], page_idx: 0 },
    { type: "text", text: "Supporting Information contains the experimental controls.", page_idx: 0 },
    { type: "image", img_path: "qr.jpg", bbox: [843, 842, 912, 917], page_idx: 0 },
  ];
  const doc = normalize(items);
  assert.equal(doc.blocks[2]?.kind, "heading");
  for (const index of [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    assert.equal(doc.blocks[index]?.kind, "metadata", `publisher block ${index}`);
    assert.equal(doc.blocks[index]?.hiddenByDefault, true);
  }
  assert.equal(doc.blocks[13]?.kind, "figure");
  assert.equal(doc.blocks[13]?.asset, "abstract.jpg");
  assert.equal(doc.blocks[14]?.kind, "paragraph");
  // The uncaptioned bottom-right thumbnail is the journal cover, not article content.
  assert.equal(doc.blocks[15]?.kind, "metadata");
  assert.equal(doc.blocks[15]?.hiddenByDefault, true);
});

test("the page-1 journal cover thumbnail folds after the body starts; captioned or larger figures stay", () => {
  const doc = normalize([
    { type: "text", text: "Dispersion Polymerization in an Elastomeric Solvent", page_idx: 0, bbox: [80, 135, 721, 158] },
    { type: "text", text: "ABSTRACT: Polymerization-induced phase separation provides a route.", page_idx: 0, bbox: [77, 292, 507, 473] },
    { type: "text", text: "1. INTRODUCTION", text_level: 1, page_idx: 0, bbox: [80, 607, 225, 623] },
    { type: "image", img_path: "cover.jpg", page_idx: 0, bbox: [846, 837, 914, 910] },
    { type: "image", img_path: "small-figure.jpg", image_caption: ["Figure 1. Particle sizes."], page_idx: 0, bbox: [846, 837, 914, 910] },
    { type: "image", img_path: "toc.jpg", page_idx: 0, bbox: [518, 760, 914, 930] },
    { type: "image", img_path: "later.jpg", page_idx: 1, bbox: [846, 837, 914, 910] },
  ]);
  const kinds = Object.fromEntries(doc.blocks.filter(block => block.asset).map(block => [block.asset, block.kind]));
  assert.deepEqual(kinds, { "cover.jpg": "metadata", "small-figure.jpg": "figure", "toc.jpg": "figure", "later.jpg": "figure" });
});

test("only an explicit provider aside with a download imprint is metadata", () => {
  const imprint = "Downloaded from pubs.acs.org/article-pdf/paper.pdf by ZHEJIANG UNIV user on 26 August 2026";
  const guest = "Downloaded from pubs.acs.org/mamobx/article-pdf/59/18/9999/68474740/ma-2026-00969.c.pdf by guest on 14 October 2026";
  const wiley = "Downloaded from https://onlinelibrary.wiley.com/doi/10.1002/adma.202400001 by Zhejiang University, Wiley Online Library on [14/10/2026]. See the Terms and Conditions";
  const doc = normalize([
    { type: "aside_text", text: imprint, page_idx: 4 },
    { type: "aside_text", text: "Downloaded from the instrument after the calibration run.", page_idx: 4 },
    { type: "text", text: "Metrics & More", page_idx: 4 },
    { type: "text", text: "Article", page_idx: 4 },
    { type: "aside_text", text: guest, page_idx: 5 },
    { type: "page_aside_text", text: wiley, page_idx: 6 },
    { type: "text", text: guest, page_idx: 6 },
  ]);
  assert.equal(doc.blocks[0]?.kind, "metadata");
  assert.equal(doc.blocks[0]?.text, imprint);
  assert.equal(doc.blocks[1]?.kind, "paragraph");
  assert.equal(doc.blocks[2]?.kind, "paragraph");
  assert.equal(doc.blocks[3]?.kind, "paragraph");
  assert.equal(doc.blocks[4]?.kind, "metadata");
  assert.equal(doc.blocks[5]?.kind, "metadata");
  // Body text is never reclassified by wording alone.
  assert.equal(doc.blocks[6]?.kind, "paragraph");
});

test("in-image OCR before and after a figure becomes alt text without extra source regions", () => {
  const doc = normalize([
    { type: "text", text: "Body before the figure.", page_idx: 3, bbox: [100, 50, 900, 80] },
    { type: "text", text: "b", page_idx: 3, bbox: [120, 120, 140, 140] },
    { type: "image", text: "TEM image", img_path: "figure2.jpg", image_caption: ["Figure 2. Microstructures."], page_idx: 3, bbox: [100, 100, 900, 600] },
    { type: "text", text: "200 μm", page_idx: 3, bbox: [750, 550, 850, 570] },
    { type: "list", list_items: ["N10", "D10"], page_idx: 3, bbox: [150, 200, 250, 240] },
    { type: "text", text: "Body after the figure.", page_idx: 3, bbox: [100, 650, 900, 680] },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.kind), ["paragraph", "figure", "paragraph"]);
  assert.deepEqual(doc.blocks.map(block => block.id), ["block-1", "block-3", "block-6"]);
  assert.equal(doc.blocks[1]?.text, "b\nTEM image\n200 μm\nN10\nD10");
  assert.equal(doc.blocks[1]?.asset, "figure2.jpg");
  assert.deepEqual(doc.blocks[1]?.sources, [{ page: 4, bbox: [0.1, 0.1, 0.9, 0.6] }]);
  assert.deepEqual(doc.blocks[1]?.captions, ["Figure 2. Microstructures."]);
});

test("explicit numbered figure captions inside image bounds are not absorbed as OCR", () => {
  for (const caption of ["Fig. 2. Microstructures.", "Figure 2: Microstructures."]) {
    const doc = normalize([
      { type: "text", text: caption, page_idx: 3, bbox: [120, 120, 500, 150] },
      { type: "image", img_path: "figure2.jpg", page_idx: 3, bbox: [100, 100, 900, 600] },
    ]);
    assert.deepEqual(doc.blocks.map(block => block.text), [caption, ""]);
    assert.equal(doc.blocks[0]?.kind, "paragraph");
    assert.equal(doc.blocks[1]?.asset, "figure2.jpg");
  }
});

test("external body text, other-page text and less than 95 percent contained labels remain body", () => {
  const doc = normalize([
    { type: "image", img_path: "figure2.jpg", page_idx: 3, bbox: [100, 100, 900, 600] },
    { type: "text", text: "Only overlaps the image edge.", page_idx: 3, bbox: [890, 150, 990, 180] },
    { type: "text", text: "External body text.", page_idx: 3, bbox: [100, 650, 900, 680] },
    { type: "text", text: "Same geometry on another page.", page_idx: 4, bbox: [120, 120, 500, 150] },
  ]);
  assert.equal(doc.blocks.length, 4);
  assert.equal(doc.blocks[0]?.text, "");
  assert.deepEqual(doc.blocks.slice(1).map(block => block.kind), ["paragraph", "paragraph", "paragraph"]);
});

test("OCR containment uses the grouped image bbox rather than its separate caption source", () => {
  const doc = normalize([
    { type: "text", text: "N10", page_idx: 4, bbox: [140, 140, 180, 160] },
    { type: "chart", img_path: "a.jpg", page_idx: 4, bbox: [100, 100, 400, 500] },
    { type: "chart", img_path: "b.jpg", page_idx: 4, bbox: [450, 100, 750, 500] },
    { type: "text", text: "Figure 3. Tensile behaviors.", page_idx: 4, bbox: [100, 520, 750, 550] },
    { type: "text", text: "Text beside the caption.", page_idx: 4, bbox: [150, 525, 250, 540] },
  ]);
  assert.equal(doc.blocks.length, 2);
  assert.equal(doc.blocks[0]?.text, "N10");
  assert.equal(doc.blocks[1]?.text, "Text beside the caption.");
  assert.deepEqual(doc.blocks[0]?.sources, [
    { page: 5, bbox: [0.1, 0.1, 0.75, 0.5] },
    { page: 5, bbox: [0.1, 0.52, 0.75, 0.55] },
  ]);
});

test("small OCR bbox rounding differences require at least 95 percent containment", () => {
  const doc = normalize([
    { type: "image", img_path: "figure.jpg", page_idx: 3, bbox: [100, 100, 900, 600] },
    { type: "text", text: "96 percent inside", page_idx: 3, bbox: [804, 200, 904, 230] },
    { type: "text", text: "94 percent inside", page_idx: 3, bbox: [806, 250, 906, 280] },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.text), ["96 percent inside", "94 percent inside"]);
  assert.deepEqual(doc.blocks.map(block => block.kind), ["figure", "paragraph"]);
  assert.deepEqual(doc.blocks[0]?.sources, [{ page: 4, bbox: [0.1, 0.1, 0.9, 0.6] }]);
});

test("grouped provider captions keep unnumbered narrative but panel letters become alt text", () => {
  const doc = normalize([
    { type: "chart", img_path: "a.jpg", chart_caption: ["(a)", "Error bars represent standard deviation."], page_idx: 3, bbox: [100, 100, 400, 400] },
    { type: "image", img_path: "b.jpg", image_caption: ["b", "Figure 2. Scientific results."], page_idx: 3, bbox: [450, 100, 750, 400] },
  ]);
  assert.equal(doc.blocks.length, 1);
  assert.deepEqual(doc.blocks[0]?.captions, ["Error bars represent standard deviation.", "Figure 2. Scientific results."]);
  assert.equal(doc.blocks[0]?.text, "(a)\nb");
  assert.deepEqual(doc.blocks[0]?.sources, [{ page: 4, bbox: [0.1, 0.1, 0.75, 0.4] }]);
});

test("confirmed figure groups put material and axis labels in alt but retain narrative captions", () => {
  const doc = normalize([
    { type: "chart", img_path: "a.jpg", chart_caption: ["AB3", "Stress (MPa)", "Microstructure of a polymer"], page_idx: 3, bbox: [100, 100, 400, 400] },
    { type: "image", img_path: "b.jpg", image_caption: ["(AB3)2", "Figure 2. Material structures.", "The image shows domain contrast", "n = 5"], page_idx: 3, bbox: [450, 100, 750, 400] },
  ]);
  assert.equal(doc.blocks.length, 1);
  assert.deepEqual(doc.blocks[0]?.captions, [
    "Microstructure of a polymer", "Figure 2. Material structures.", "The image shows domain contrast", "n = 5",
  ]);
  assert.equal(doc.blocks[0]?.text, "AB3\nStress (MPa)\n(AB3)2");
  assert.deepEqual(doc.blocks[0]?.sources, [{ page: 4, bbox: [0.1, 0.1, 0.75, 0.4] }]);
});

test("short provider descriptions without a confirmed group caption are retained", () => {
  const doc = normalize([
    { type: "chart", img_path: "a.jpg", chart_caption: ["Material contrast"], page_idx: 3, bbox: [100, 100, 400, 400] },
    { type: "image", img_path: "b.jpg", image_caption: ["Phase image"], page_idx: 3, bbox: [450, 100, 750, 400] },
  ]);
  assert.equal(doc.blocks.length, 2);
  assert.deepEqual(doc.blocks.map(block => block.captions), [["Material contrast"], ["Phase image"]]);
});

test("code with an explicit table caption is a table while ordinary algorithm/code keeps its fallback", () => {
  const body = '<div class="mineru-algorithm">time number<br>0 100<br>20 140</div>';
  const caption = "Table 1. Time-Evolution of the Number of the Cross-Linked Chains";
  const doc = normalize([
    { type: "code", sub_type: "algorithm", code_caption: [caption], code_body: body, bbox: [96, 843, 480, 931], page_idx: 2 },
    { type: "code", sub_type: "algorithm", code_caption: ["Algorithm 1. Network update."], code_body: body, page_idx: 3 },
    { type: "code", code_caption: ["表 2：网络参数"], code_body: body, page_idx: 4 },
    { type: "code", code_body: "return network;", page_idx: 5 },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.kind), ["table", "paragraph", "table", "paragraph"]);
  assert.deepEqual(doc.blocks[0]?.captions, [caption]);
  assert.equal(doc.blocks[0]?.html, body);
  assert.deepEqual(doc.blocks[0]?.sources, [{ page: 3, bbox: [0.096, 0.843, 0.48, 0.931] }]);
  assert.equal(doc.blocks[1]?.text, body);
  assert.equal(doc.blocks[1]?.html, undefined);
  assert.equal(doc.blocks[1]?.captions, undefined);
  assert.deepEqual(doc.blocks[2]?.captions, ["表 2：网络参数"]);
  assert.equal(doc.blocks[3]?.text, "return network;");
});

test("page-1 ACS control labels fold even when the provider lists them after the abstract", () => {
  const doc = normalize([
    { type: "text", text: "Dispersion Polymerization in an Elastomeric Solvent", text_level: 1, page_idx: 0 },
    { type: "text", text: "ACCESS", page_idx: 0 },
    { type: "text", text: "Metrics & More", page_idx: 0 },
    { type: "text", text: "ABSTRACT: Polymerization-induced phase separation provides a route.", page_idx: 0 },
    { type: "text", text: "Article Recommendations", page_idx: 0 },
    { type: "text", text: "Supporting Information", page_idx: 0 },
    { type: "text", text: "Supporting Information contains the experimental controls.", page_idx: 0 },
    { type: "text", text: "Supporting Information", text_level: 1, page_idx: 7 },
    { type: "text", text: "Article Recommendations", page_idx: 7 },
  ]);
  assert.deepEqual(doc.blocks.map(block => block.kind),
    ["heading", "metadata", "metadata", "paragraph", "metadata", "metadata", "paragraph", "heading", "paragraph"]);
  assert.equal(doc.blocks[4]?.hiddenByDefault, true);
  assert.equal(doc.blocks[5]?.hiddenByDefault, true);
});
