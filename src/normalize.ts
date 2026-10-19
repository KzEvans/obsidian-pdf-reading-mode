import type { ReaderBlock, ReaderBlockKind, ReaderDocument, SourceRef } from "./types";

type Item = Record<string, unknown>;

const REFERENCE_TITLE = /^(?:\d+[.)]?\s+)?(?:references|bibliography|literature cited|参考文献)\s*[:：]?$/i;
const FIRST_PAGE_CONTROL = /^(?:Read Online|ACCESS|Metrics & More|Article Recommendations|(?:\S{1,4}\s+)?Supporting Information)$/i;
const BODY_TITLE =/^(?:\d+[.)]?\s+)?(?:abstract|summary|introduction|keywords?|highlights)\b/i;
const SECTION_AFTER_REFERENCES = /^(?:\d+[.)]?\s+)?(?:acknowledg(?:e)?ments?|appendix(?:\s+[A-Z0-9])?|appendices|supplement(?:al|ary)\s+(?:information|materials?)|supporting information|author contributions?|credit authorship contribution statement|declaration of\s+.{1,70}|conflicts? of interest|data availability(?: statement)?|funding|致谢|附录)\s*[:：]?$/i;

/** Normalize MinerU's cloud Content List V1, without reordering provider blocks. */
export function normalizeContentList(
  items: unknown,
  sourceHash: string,
  parserSignature: string,
  pageCount: number,
): ReaderDocument {
  if (!Array.isArray(items) || items.some(Array.isArray)) {
    throw new Error("MinerU 未返回兼容的扁平 Content List；请保留结果包并检查解析格式。");
  }

  const document: ReaderDocument = {
    schemaVersion: 1,
    sourceHash,
    parserSignature,
    pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0,
    blocks: [],
    warnings: [],
  };
  let inReferences = false;
  let seenFirstPageTitle = false;
  let seenBody = false;

  items.forEach((raw: unknown, index: number) => {
    const item = isRecord(raw) ? raw : { text: raw };
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "text";
    const sources = readSources(item, document, index);
    const text = blockText(item, type);
    let kind = blockKind(item, type);
    const classificationText = htmlText(text.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "")).trim();
    const compactHeading = classificationText.replace(/\s+/g, "").toLowerCase();
    const isReferenceTitle = REFERENCE_TITLE.test(classificationText);
    const isNextSection = text.length < 120 && SECTION_AFTER_REFERENCES.test(classificationText);
    const isSpacedHeading = /^(?:graphicalabstract|abstract|highlights)$/.test(compactHeading);
    const hasHeadingLevel = typeof item.text_level === "number" && item.text_level > 0;

    // Exact ACS control-bar labels; the provider may list them after the abstract.
    const isFirstPageControl = sources[0]?.page === 1 && FIRST_PAGE_CONTROL.test(classificationText);

    if (isFirstPageControl) kind = "metadata";
    else if (hasHeadingLevel || isReferenceTitle || isNextSection || isSpacedHeading) kind = "heading";
    if (kind === "heading") {
      if (isReferenceTitle) inReferences = true;
      else inReferences = false;
      if (sources[0]?.page === 1) seenFirstPageTitle = true;
    }
    if (BODY_TITLE.test(classificationText) || /^(?:abstract|highlights)$/.test(compactHeading) || (kind === "paragraph" && text.length > 500)) seenBody = true;

    if (kind === "paragraph" || kind === "footnote") {
      if (
        isPublicationMetadata(classificationText) ||
        (sources[0]?.page === 1 && !seenBody && isFirstPagePublishingUi(classificationText, !seenFirstPageTitle)) ||
        // Publisher margin imprint: a URL or path, then "by <user|guest|institution> ... on <date>".
        ((type === "aside_text" || type === "page_aside_text") && /^Downloaded from\s+\S*[./]\S*\s+by\s+.+\bon\b/i.test(classificationText))
      ) {
        kind = "metadata";
      } else if (
        kind === "paragraph" && sources[0]?.page === 1 && seenFirstPageTitle && !seenBody &&
        (isAuthorLine(classificationText) || isAffiliationLine(classificationText))
      ) {
        kind = "metadata";
      } else if (inReferences && kind === "paragraph") {
        kind = "references";
      }
    } else if (inReferences && kind === "list") {
      kind = "references";
    }

    const block: ReaderBlock = {
      id: `block-${index + 1}`,
      kind,
      sources,
      text,
    };
    if (kind === "heading") {
      const level = typeof item.text_level === "number" ? item.text_level : item.level;
      block.level = typeof level === "number" && Number.isInteger(level) && level > 0 ? level : 1;
    }
    if (kind === "metadata" || kind === "references" || kind === "header" || kind === "footer") {
      block.hiddenByDefault = true;
    }

    if (kind === "figure" || kind === "table" || kind === "equation") {
      const asset = nonemptyString(item.img_path) ?? nonemptyString(item.image_path) ?? nonemptyString(item.asset);
      if (asset) block.asset = asset;
      const prefix = type === "code" ? "code" : type === "chart" ? "chart" : kind === "table" ? "table" : "image";
      const captions = textArray(item[`${prefix}_caption`] ?? item.captions);
      const footnotes = textArray(item[`${prefix}_footnote`] ?? item.footnotes);
      if (captions.length) block.captions = captions;
      if (footnotes.length) block.footnotes = footnotes;
    }
    const logoBox = sources[0]?.bbox;
    const uncaptionedFirstPageImage = kind === "figure" && sources[0]?.page === 1 &&
      !text && !block.captions?.length && !block.footnotes?.length && logoBox;
    if (
      uncaptionedFirstPageImage && (
        (seenFirstPageTitle && !seenBody && (
          (logoBox[0] > 0.65 && logoBox[3] < 0.35 && logoBox[2] - logoBox[0] < 0.1 && logoBox[3] - logoBox[1] < 0.08) ||
          (logoBox[2] - logoBox[0] <= 0.05 && logoBox[3] - logoBox[1] <= 0.05)
        )) ||
        // Journal cover thumbnail beside the received/published dates (bottom right).
        (logoBox[0] > 0.65 && logoBox[1] > 0.75 && logoBox[2] - logoBox[0] < 0.1 && logoBox[3] - logoBox[1] < 0.1)
      )
    ) {
      block.kind = "metadata";
      block.hiddenByDefault = true;
    }
    const html = nonemptyString(item.table_body) ?? nonemptyString(item.html) ??
      (type === "code" && kind === "table" ? nonemptyString(item.code_body) : undefined);
    if (html) block.html = html;

    if (!knownType(type)) {
      document.warnings.push(`内容块 ${index + 1} 使用未知类型 ${type}，已保留为正文。`);
    }
    if (!text && !block.asset && !block.html && !block.captions?.length && !block.footnotes?.length && !['header', 'footer', 'metadata'].includes(kind)) {
      document.warnings.push(`内容块 ${index + 1} 没有可显示内容。`);
    }

    const previous = document.blocks[document.blocks.length - 1];
    const previousPage = previous?.sources[previous.sources.length - 1]?.page;
    if (
      item.continues_prev === true && previous?.kind === "paragraph" && kind === "paragraph" &&
      previousPage !== undefined && sources[0]?.page === previousPage + 1 && previous.text && text &&
      !previous.html && !block.html
    ) {
      previous.text = joinContinuation(previous.text, text);
      previous.sources.push(...sources);
    } else {
      document.blocks.push(block);
    }
  });

  document.blocks = absorbInFigureText(groupFigureComponents(document.blocks));
  return document;
}

function readSources(item: Item, document: ReaderDocument, index: number): SourceRef[] {
  const pageIndex = item.page_idx;
  if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) || pageIndex < 0) {
    document.warnings.push(`内容块 ${index + 1} 缺少有效原文页码，已保留内容但无法定位。`);
    return [];
  }
  const source: SourceRef = { page: pageIndex + 1 };
  if (document.pageCount && source.page > document.pageCount) {
    document.warnings.push(`内容块 ${index + 1} 的原文页码超出 PDF 页数，已取消该定位。`);
    return [];
  }
  const bbox = item.bbox;
  if (bbox !== undefined) {
    if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(value => typeof value === "number" && Number.isFinite(value))) {
      // The cloud Content List contract uses 0–1000, unlike local MiddleJson.
      const normalized = bbox.map(value => Math.max(0, Math.min(1, (value as number) / 1000))) as SourceRef["bbox"];
      if (normalized && normalized[2] > normalized[0] && normalized[3] > normalized[1]) {
        source.bbox = normalized;
      } else {
        document.warnings.push(`内容块 ${index + 1} 的原文范围无效，已保留页级定位。`);
      }
    } else {
      document.warnings.push(`内容块 ${index + 1} 的原文范围无效，已保留页级定位。`);
    }
  }
  return [source];
}

function blockKind(item: Item, type: string): ReaderBlockKind {
  switch (type) {
    case "text": case "paragraph": return "paragraph";
    case "title": case "doc_title": case "heading": return "heading";
    case "list": return item.sub_type === "ref_text" || item.sub_type === "reference_list" ? "references" : "list";
    case "ref_text": case "references": return "references";
    case "image": case "chart": case "figure": return "figure";
    case "table": return "table";
    case "code": return textArray(item.code_caption).some(caption =>
      /^(?:table\s*S?\d+[A-Za-z]?\b|表\s*(?:S?\d+|[一二三四五六七八九十]+)(?=[\s.:：、-]|$))/i.test(htmlText(caption).trim()),
    ) ? "table" : "paragraph";
    case "equation": case "interline_equation": case "equation_interline": return "equation";
    case "page_footnote": case "footnote": return "footnote";
    case "header": case "page_header": return "header";
    case "footer": case "page_footer": case "page_number": return "footer";
    case "metadata": case "author": case "affiliation": return "metadata";
    default: return "paragraph";
  }
}

function knownType(type: string): boolean {
  return /^(?:text|paragraph|title|doc_title|heading|list|ref_text|references|image|chart|figure|table|equation|interline_equation|equation_interline|page_footnote|footnote|header|page_header|footer|page_footer|page_number|metadata|author|affiliation|code|algorithm|aside_text|page_aside_text|index)$/.test(type);
}

function blockText(item: Item, type: string): string {
  if (type === "table") {
    const explicit = readText(item.text);
    if (explicit) return explicit;
    return htmlText(readText(item.table_body ?? item.html ?? item.content));
  }
  for (const value of [item.text, item.list_items, item.code_body, item.content, item.label]) {
    const text = readText(value);
    if (text) return text;
  }
  return knownType(type) ? "" : readText(item);
}

function readText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const inlineSpans = value.every(entry => isRecord(entry) && typeof entry.type === "string");
    return value.map(readText).filter(Boolean).join(inlineSpans ? "" : "\n").trim();
  }
  if (isRecord(value)) {
    if (value.type === "equation_inline") {
      const latex = readText(value.content);
      return latex ? `$${latex}$` : "";
    }
    for (const field of ["text", "content", "children", "paragraph_content", "title_content", "item_content", "list_items", "math_content", "code_content", "algorithm_content"]) {
      if (value[field] !== undefined) return readText(value[field]);
    }
    return Object.entries(value)
      .filter(([key]) => !/^(?:type|sub_type|bbox|page_idx|index|level|text_level|path|img_path|image_path|url|style|styles|score|angle|format)$/.test(key))
      .map(([, entry]) => readText(entry)).filter(Boolean).join("\n").trim();
  }
  return "";
}

function textArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(readText).filter(Boolean);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicationMetadata(text: string): boolean {
  if (text.length > 700) return false;
  return /^(?:©|copyright\b|all rights reserved\b|published by\b|https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*10\.)/i.test(text) ||
    /\ball rights reserved\b/i.test(text) ||
    /^(?:received|accepted|available online|revised|published)\s*:?[\s]*(?:in\s+revised\s+form\s+)?(?:\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}|\d{4}[-/]\d{1,2})/i.test(text) ||
    /^(?:[*⁎†‡]\s*)?(?:corresponding authors?\b|(?:these|those) authors contributed equally\b|authors? contributed equally\b|e[- ]?mail(?: address)?\s*:)/i.test(text);
}

function isFirstPagePublishingUi(text: string, beforeTitle: boolean): boolean {
  return /^(?:Published as part of\b|Cite This\s*:|pubs\.acs\.org\/)/i.test(text) ||
    /^(?:Read Online|ACCESS|Metrics & More|Article Recommendations)$/i.test(text) ||
    (beforeTitle && /^Article$/i.test(text)) ||
    (text.length < 120 && /\bSupporting Information\b/i.test(text));
}

function isAuthorLine(text: string): boolean {
  if (text.length > 240 || /[.!?:;]/.test(text.replace(/\b[A-Z]\./g, ""))) return false;
  const names = text.split(/\s*,\s*|\s+and\s+/).map(name => name.replace(/[†‡*]+/g, "").replace(/\s+[a-z]$/, "").trim());
  return names.length >= 2 && names.every(name => /^(?:[A-Z][A-Za-z'’.-]*\s+){1,3}[A-Z][A-Za-z'’.-]*$/.test(name));
}

function isAffiliationLine(text: string): boolean {
  if (text.length > 350 || /\b(?:we|our|results?|shows?|demonstrates?|measured|strain|modulus|voltage)\b/i.test(text)) return false;
  return /^(?:[a-z0-9][.)]?\s+)?(?:the\s+)?(?:department|school|faculty|college|institute|laboratory|state key laboratory|university|centre|center)\b/i.test(text) ||
    (text.includes(",") && /\b(?:university|institute of technology)\b/i.test(text) && /\b(?:\d{5,6}|china|usa|germany|japan|uk|france)\b/i.test(text));
}

function joinContinuation(previous: string, next: string): string {
  if (previous.endsWith("\u00ad")) return previous.slice(0, -1) + next;
  return previous + (previous.endsWith("-") ? "" : " ") + next;
}

function htmlText(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(?:tr|p|div|li)>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " }[entity] ?? entity))
    .replace(/[ \t]+/g, " ").trim();
}

type Box = [number, number, number, number];
const FIGURE_CAPTION = /^fig(?:ure)?\.?\s*(S?\d+[A-Za-z]?)\s*[.:]\s*/i;
const PANEL_LABEL = /^\(?[a-z]\)?[.:]?$/i;
const PANEL_CAPTION = /^\(?[a-z]\)?$/i;

/** Panels are grouped only when a single numbered caption confirms their identity. */
function groupFigureComponents(blocks: ReaderBlock[]): ReaderBlock[] {
  const result: ReaderBlock[] = [];
  for (let index = 0; index < blocks.length;) {
    const first = blocks[index];
    if (!first) break;
    const firstSource = first.sources[0];
    if (first.kind !== "figure" || !firstSource?.bbox) {
      result.push(first);
      index++;
      continue;
    }
    const previous = blocks[index - 1];
    const graphicalAbstract = previous?.sources[0]?.page === firstSource.page &&
      previous.text.replace(/\s+/g, "").toLowerCase() === "graphicalabstract";
    const group = [first];
    let union = firstSource.bbox;
    let cropUnion = firstSource.bbox;
    let cursor = index + 1;
    const captionNumbers = new Set<string>();
    addFigureNumbers(first, captionNumbers);

    while (cursor < blocks.length) {
      const candidate = blocks[cursor];
      const source = candidate?.sources[0];
      if (!candidate || source?.page !== firstSource.page || !source.bbox) break;
      const caption = figureNumber(candidate.text);
      const panelLabel = candidate.kind === "paragraph" && PANEL_LABEL.test(htmlText(candidate.text));
      const abstractLabel = graphicalAbstract && (candidate.kind === "paragraph" || candidate.kind === "heading") && candidate.text.length < 120 &&
        source.bbox[0] >= firstSource.bbox[0] - 0.025 &&
        source.bbox[1] >= firstSource.bbox[1] - 0.025 &&
        source.bbox[3] <= union[3] + 0.04;
      if (candidate.kind !== "figure" && candidate.kind !== "paragraph" && !abstractLabel) break;
      if (candidate.kind !== "figure" && !caption && !panelLabel && !abstractLabel) break;
      // A numbered caption closes the figure. A later panel belongs to it only when
      // its region is already inside the existing panel envelope (e.g. Chen Fig. 3).
      if (captionNumbers.size && candidate.kind === "figure" && !mostlyInside(cropUnion, source.bbox)) break;
      if (!nearFigureRegion(union, source.bbox)) break;
      group.push(candidate);
      union = unionBox(union, source.bbox);
      if (candidate.kind === "figure" || !caption) cropUnion = unionBox(cropUnion, source.bbox);
      addFigureNumbers(candidate, captionNumbers);
      cursor++;
    }

    const visuals = group.filter(block => block.kind === "figure").length;
    if (group.length > 1 && (captionNumbers.size === 1 || (graphicalAbstract && visuals > 1 && captionNumbers.size === 0))) {
      const captionIsLabel = (caption: string) => isProviderLabelCaption(caption, captionNumbers.size === 1 || graphicalAbstract);
      const captions = group.flatMap(block => [
        ...(block.captions ?? []).filter(caption => !captionIsLabel(caption)),
        ...(block.kind !== "figure" && figureNumber(block.text) ? [block.text] : []),
      ]);
      const footnotes = group.flatMap(block => block.footnotes ?? []);
      const grouped: ReaderBlock = {
        id: first.id,
        kind: "figure",
        text: group.flatMap(block => [
          ...(block.kind === "figure" || !figureNumber(block.text) ? [block.text] : []),
          ...(block.captions ?? []).filter(captionIsLabel),
        ]).filter(Boolean).join("\n"),
        sources: [
          { page: firstSource.page, bbox: cropUnion },
          ...group.filter(block => block.kind !== "figure" && figureNumber(block.text)).flatMap(block => block.sources),
        ],
      };
      if (captions.length) grouped.captions = [...new Set(captions)];
      if (footnotes.length) grouped.footnotes = [...new Set(footnotes)];
      // No individual panel image represents the whole figure; the host crops this source region.
      result.push(grouped);
      index = cursor;
    } else {
      // Conflicting figure numbers leave the whole candidate run untouched.
      result.push(...group);
      index = cursor;
    }
  }
  return result;
}

/** OCR inside an image belongs to its alt text, not to the surrounding body. */
function absorbInFigureText(blocks: ReaderBlock[]): ReaderBlock[] {
  const figures = blocks.map((block, index) => ({ block, index }))
    .filter(({ block }) => block.kind === "figure" && block.sources[0]?.bbox);
  const labels = new Map<ReaderBlock, Array<{ index: number; text: string }>>();
  const absorbed = new Set<ReaderBlock>();
  blocks.forEach((block, index) => {
    if ((block.kind !== "paragraph" && block.kind !== "list") || !block.text.trim()) return;
    // A numbered figure caption remains a caption even if its bbox overlaps an image.
    if (/^fig(?:ure)?\.?\s*S?\d+[A-Za-z]?\b/i.test(htmlText(block.text).trim())) return;
    const source = block.sources.length === 1 ? block.sources[0] : undefined;
    if (!source?.bbox) return;
    const owners = figures.filter(({ block: figure }) => {
      const image = figure.sources[0];
      return image?.page === source.page && image.bbox && mostlyInside(image.bbox, source.bbox!, 0.95);
    });
    // Overlapping figures do not provide a unique geometric owner.
    if (owners.length !== 1) return;
    const owner = owners[0]!;
    let contents = labels.get(owner.block);
    if (!contents) {
      contents = owner.block.text ? [{ index: owner.index, text: owner.block.text }] : [];
      labels.set(owner.block, contents);
    }
    contents.push({ index, text: block.text });
    absorbed.add(block);
  });
  for (const [figure, contents] of labels) {
    figure.text = contents.sort((left, right) => left.index - right.index).map(item => item.text).join("\n");
  }
  return blocks.filter(block => !absorbed.has(block));
}

function figureNumber(text: string): string | undefined {
  return FIGURE_CAPTION.exec(htmlText(text).trim())?.[1]?.toLowerCase();
}

function isPanelCaption(text: string): boolean {
  return PANEL_CAPTION.test(htmlText(text).trim());
}

/** A confirmed figure caption distinguishes short panel/axis titles from narrative. */
function isProviderLabelCaption(text: string, confirmedFigure: boolean): boolean {
  if (isPanelCaption(text)) return true;
  const plain = htmlText(text).trim();
  const words = plain.split(/\s+/);
  if (!confirmedFigure || figureNumber(text) || !plain || plain.length > 80 || words.length > 6) return false;
  if (/[.!?:;。！？：；]$/.test(plain) || /[=<>≤≥]/.test(plain)) return false;
  // Preserve unnumbered explanatory caption fragments, even without a final period.
  if (words.length > 1 && (
    /^(?:the|a|an|this|these|those|each)\b/i.test(plain) ||
    /\b(?:of|for|with|in|on|at|under|during|after|before|versus|vs|as|that|which)\b/i.test(plain) ||
    /\b(?:is|are|was|were|has|have|shows?|shown|represents?|illustrates?|indicates?|denotes?|corresponds?|measured|obtained|calculated)\b/i.test(plain)
  )) return false;
  return true;
}

function addFigureNumbers(block: ReaderBlock, numbers: Set<string>): void {
  for (const text of [block.text, ...(block.captions ?? [])]) {
    const number = figureNumber(text);
    if (number) numbers.add(number);
  }
}

function unionBox(left: Box, right: Box): Box {
  return [Math.min(left[0], right[0]), Math.min(left[1], right[1]), Math.max(left[2], right[2]), Math.max(left[3], right[3])];
}

function nearFigureRegion(left: Box, right: Box): boolean {
  const horizontalGap = Math.max(0, left[0] - right[2], right[0] - left[2]);
  const verticalGap = Math.max(0, left[1] - right[3], right[1] - left[3]);
  return horizontalGap <= 0.1 && verticalGap <= 0.045;
}

function mostlyInside(region: Box, candidate: Box, minimumFraction = 0.85): boolean {
  const area = (candidate[2] - candidate[0]) * (candidate[3] - candidate[1]);
  const intersection = Math.max(0, Math.min(region[2], candidate[2]) - Math.max(region[0], candidate[0])) *
    Math.max(0, Math.min(region[3], candidate[3]) - Math.max(region[1], candidate[1]));
  return area > 0 && intersection / area >= minimumFraction;
}

/** Candidate only: callers should confirm against the PDF text before replacing provider text. */
export function ligatureSuperscriptCandidate(text: string): string {
  return text.replace(/(^|[\sA-Za-z-])<sup\b[^>]*>(fi|fl|ff|ffi|ffl|f)<\/sup>(?=[a-z])/g, "$1$2");
}
