import { finishRenderMath, loadMathJax, renderMath, sanitizeHTMLToDom } from "obsidian";
import type { ReaderBlock, ReaderDocument } from "./types";

export interface ReaderRenderOptions {
  fontSize: number;
  lineHeight: number;
  assetUrl: (path: string) => string;
  assetDimensions?: (path: string) => { width: number; height: number } | undefined;
  isCurrent?: () => boolean;
  onSource: (page: number) => void;
  onCopy: (page: number) => void;
  onZoom: (url: string, caption: string) => void;
}

interface RenderContext {
  document: Document;
  options: ReaderRenderOptions;
  markedPages: Set<number>;
  mathDocuments: Set<Document>;
}

const INLINE_TAGS = new Set(["SPAN", "SUP", "SUB", "EM", "STRONG", "B", "I", "U", "S", "SMALL", "BR", "CODE"]);
const TABLE_TAGS = new Set(["TABLE", "CAPTION", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "UL", "OL", "LI", "P", "DIV"]);
const OMIT_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "TEXTAREA", "BUTTON", "SVG", "MATH"]);

/** Keep body/figure order, moving only ancillary blocks to the end of their section. */
export async function renderReader(root: HTMLElement, readerDocument: ReaderDocument, options: ReaderRenderOptions): Promise<void> {
  if (options.isCurrent?.() === false) return;
  if (readerDocument.blocks.some(requiresMath)) {
    try { await loadMathJax(); } catch { /* Individual formulas retain their source-page fallback. */ }
  }
  if (options.isCurrent?.() === false) return;
  const context: RenderContext = {
    document: root.ownerDocument,
    options,
    markedPages: new Set(),
    mathDocuments: new Set(),
  };
  root.style.setProperty("--pdf-reader-font-size", `${finiteClamp(options.fontSize, 14, 30, 18)}px`);
  root.style.setProperty("--pdf-reader-line-height", String(finiteClamp(options.lineHeight, 1.2, 2, 1.5)));
  const article = context.document.createElement("article");
  article.className = "pdf-reader-article";
  article.setAttribute("aria-label", "PDF 阅读模式正文");
  root.replaceChildren(article);

  let rendered = 0;
  let batchStarted = performance.now();
  const shouldYield = () => ++rendered % 40 === 0 || performance.now() - batchStarted >= 12;
  const yieldToUI = async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    batchStarted = performance.now();
  };

  const blocks = sectionEndAncillary(readerDocument.blocks);
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index];
    if (!block) break;
    const fold = foldKind(block);
    if (!fold) {
      article.append(renderBlock(block, context));
      index += 1;
      if (shouldYield()) {
        await yieldToUI();
        if (options.isCurrent?.() === false) return;
      }
      continue;
    }

    const group: ReaderBlock[] = [];
    while (index < blocks.length) {
      const next = blocks[index];
      if (!next || foldKind(next) !== fold) break;
      group.push(next);
      index += 1;
    }
    const details = context.document.createElement("details");
    details.className = "pdf-reader-fold";
    details.dataset.foldKind = fold;
    const summary = context.document.createElement("summary");
    summary.className = "pdf-reader-fold-summary";
    summary.textContent = foldLabel(fold);
    setSources(summary, group.flatMap((item) => sourcePages(item)));
    details.append(summary);
    const content = context.document.createElement("div");
    content.className = "pdf-reader-fold-content";
    details.append(content);
    article.append(details);
    const foldedContext = { ...context, markedPages: new Set<number>() };
    for (const item of group) {
      content.append(renderBlock(item, foldedContext));
      if (shouldYield()) {
        await yieldToUI();
        if (options.isCurrent?.() === false) return;
      }
    }
  }

  if (!readerDocument.blocks.length) {
    const empty = context.document.createElement("p");
    empty.className = "pdf-reader-render-notice";
    empty.textContent = "没有可重排的正文，请查看原 PDF。";
    article.append(empty);
  }

  if (context.mathDocuments.size) {
    try {
      await finishRenderMath();
      // MathJax creates its stylesheet in the document used by renderMath.
      // Obsidian pop-out windows need the same generated stylesheet.
      for (const mathDocument of context.mathDocuments) {
        if (mathDocument === context.document) continue;
        for (const id of ["MJX-CHTML-styles", "MJX-SVG-styles"]) {
          const sourceStyle = mathDocument.getElementById(id);
          if (!sourceStyle || sourceStyle.tagName !== "STYLE") continue;
          let style = context.document.getElementById(id);
          if (!style) {
            style = context.document.createElement("style");
            style.id = id;
            context.document.head.append(style);
          }
          style.textContent = sourceStyle.textContent;
        }
      }
    } catch {
      if (article.isConnected && article.parentElement === root) {
        const notice = context.document.createElement("p");
        notice.className = "pdf-reader-render-notice";
        notice.textContent = "部分公式未完成排版，可用原文按钮查看源页。";
        article.prepend(notice);
      }
    }
  }
}

function requiresMath(block: ReaderBlock): boolean {
  if (block.kind === "equation") return true;
  return [block.text, block.html ?? "", ...(block.captions ?? []), ...(block.footnotes ?? [])]
    .some(text => mathPattern().test(text) || /data-(?:math|latex)\s*=|math-(?:inline|display)/i.test(text));
}

export function scrollToSourcePage(root: HTMLElement, page: number): void {
  if (!Number.isInteger(page) || page < 1) return;
  const targets = Array.from(root.querySelectorAll<HTMLElement>(".pdf-reader-block[data-source-pages]"))
    .filter((element) => pagesFromElement(element).includes(page));
  // Prefer the body when a page also contains a collapsed publisher header.
  const target = targets.find((element) => !element.closest(".pdf-reader-fold") && pagesFromElement(element)[0] === page)
    ?? targets.find((element) => !element.closest(".pdf-reader-fold"))
    ?? targets.find((element) => element.closest(".pdf-reader-fold")?.getAttribute("data-fold-kind") === "references")
    ?? targets[0];
  if (!target) return;
  for (let parent = target.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
  }
  const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 24;
  root.scrollTop = Math.max(0, top);
}

export interface SourcePageTracker {
  getPage(): number | undefined;
  getStats(): { rebuilds: number; rebuildMs: number; invalidations: Record<string, number> };
  dispose(): void;
}

interface PagePosition { page: number; top: number; bottom: number }
interface PageIndex { positions: PagePosition[]; height: number }
const pageTrackers = new WeakMap<HTMLElement, SourcePageTracker>();

/** Cache geometry between layout changes; normal scrolling only reads scrollTop. */
export function createSourcePageTracker(root: HTMLElement, onChange: (page: number) => void): SourcePageTracker {
  pageTrackers.get(root)?.dispose();
  const win = root.ownerDocument.defaultView!;
  const requestFrame = (callback: FrameRequestCallback): number => win.requestAnimationFrame
    ? win.requestAnimationFrame(callback) : win.setTimeout(() => callback(0), 16);
  const cancelFrame = (id: number) => win.cancelAnimationFrame ? win.cancelAnimationFrame(id) : win.clearTimeout(id);
  let index: PageIndex = { positions: [], height: 0 };
  let dirty = true;
  let frame: number | undefined;
  let disposed = false;
  let previousPage: number | undefined;
  let rebuilds = 0;
  let rebuildMs = 0;
  const invalidations: Record<string, number> = {};
  const getPage = (): number | undefined => {
    if (disposed) return undefined;
    if (dirty) {
      const started = performance.now();
      index = buildPageIndex(root);
      rebuilds++;
      rebuildMs += performance.now() - started;
      dirty = index.height <= 0;
    }
    return pageAtScroll(index, root.scrollTop);
  };
  const schedule = () => {
    if (disposed || frame !== undefined) return;
    frame = requestFrame(() => {
      frame = undefined;
      const page = getPage();
      if (page !== undefined && page !== previousPage) { previousPage = page; onChange(page); }
    });
  };
  const invalidate = (reason: string) => {
    if (disposed) return;
    invalidations[reason] = (invalidations[reason] ?? 0) + 1;
    dirty = true;
    schedule();
  };
  const toggle = () => invalidate("toggle");
  const error = () => invalidate("error");
  const windowResize = () => invalidate("window-resize");
  const imageLoad = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "IMG" && target.dataset.readerLayoutReserved !== "true") invalidate("load");
  };
  const resize = win.ResizeObserver ? new win.ResizeObserver(() => invalidate("resize-observer")) : undefined;
  resize?.observe(root);
  const article = root.querySelector("article");
  if (article) resize?.observe(article);
  root.addEventListener("scroll", schedule, { passive: true });
  root.addEventListener("toggle", toggle, true);
  root.addEventListener("load", imageLoad, true);
  root.addEventListener("error", error, true);
  win.addEventListener("resize", windowResize);
  const tracker: SourcePageTracker = {
    getPage,
    getStats: () => ({ rebuilds, rebuildMs, invalidations: { ...invalidations } }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) cancelFrame(frame);
      resize?.disconnect();
      root.removeEventListener("scroll", schedule);
      root.removeEventListener("toggle", toggle, true);
      root.removeEventListener("load", imageLoad, true);
      root.removeEventListener("error", error, true);
      win.removeEventListener("resize", windowResize);
      if (pageTrackers.get(root) === tracker) pageTrackers.delete(root);
    },
  };
  pageTrackers.set(root, tracker);
  return tracker;
}

export function getVisibleSourcePage(root: HTMLElement): number | undefined {
  const tracker = pageTrackers.get(root);
  return tracker ? tracker.getPage() : pageAtScroll(buildPageIndex(root), root.scrollTop);
}

function buildPageIndex(root: HTMLElement): PageIndex {
  const boundary = root.getBoundingClientRect();
  const positions: PagePosition[] = [];
  const elements = Array.from(root.querySelectorAll<HTMLElement>(".pdf-reader-block[data-source-pages], .pdf-reader-fold-summary[data-source-pages]"));
  for (const element of elements) {
    const closedFold = element.closest("details:not([open])");
    if (closedFold && element.parentElement !== closedFold) continue;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.height <= 0 || rectangle.width <= 0) continue;
    const page = pagesFromElement(element)[0];
    if (!page) continue;
    positions.push({ page, top: rectangle.top - boundary.top + root.scrollTop, bottom: rectangle.bottom - boundary.top + root.scrollTop });
  }
  positions.sort((left, right) => left.top - right.top);
  return { positions, height: boundary.height };
}

function pageAtScroll(index: PageIndex, scrollTop: number): number | undefined {
  if (index.height <= 0 || !index.positions.length) return undefined;
  const line = scrollTop + Math.min(48, index.height / 4);
  let low = 0;
  let high = index.positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.positions[middle]!.top <= line) low = middle + 1;
    else high = middle;
  }
  const before = index.positions[low - 1];
  const after = index.positions[low];
  if (before && before.bottom > line) return before.page;
  const beforeVisible = before && before.bottom > scrollTop;
  const afterVisible = after && after.top < scrollTop + index.height;
  if (beforeVisible && (!afterVisible || line - before.top <= after.top - line)) return before.page;
  return afterVisible ? after.page : undefined;
}

function renderBlock(block: ReaderBlock, context: RenderContext): HTMLElement {
  const wrapper = context.document.createElement("section");
  wrapper.className = `pdf-reader-block pdf-reader-${block.kind}`;
  wrapper.dataset.readerBlockId = block.id;
  const pages = sourcePages(block);
  setSources(wrapper, pages);
  const unmarkedPages = pages.filter((page) => !context.markedPages.has(page));
  if (unmarkedPages.length) {
    const markers = context.document.createElement("div");
    markers.className = "pdf-reader-page-markers";
    for (const page of unmarkedPages) {
      context.markedPages.add(page);
      const marker = context.document.createElement("span");
      marker.className = "pdf-reader-page-marker";
      marker.textContent = `PDF p. ${page}`;
      markers.append(marker);
    }
    wrapper.append(markers);
  }

  if (block.kind === "figure" || block.kind === "table") {
    const figure = context.document.createElement("figure");
    figure.className = "pdf-reader-figure-group";
    // Tables use an original-PDF crop; provider HTML cannot change columns or scientific notation.
    appendImageOrText(figure, block, context);
    appendCaptions(figure, block, context);
    wrapper.append(figure);
  } else if (block.kind === "equation") {
    const equation = context.document.createElement("div");
    equation.className = "pdf-reader-equation-body";
    const rendered = appendMath(equation, stripMathDelimiters(block.text), true, context);
    const original = !rendered && block.asset ? resolveAsset(block.asset, context.options) : undefined;
    if (original) {
      equation.replaceChildren();
      appendImage(equation, original, block.text || "原文公式", context, undefined, block.asset);
    }
    wrapper.append(equation);
  } else if (block.kind === "list") {
    if (block.html) {
      const list = context.document.createElement("div");
      appendHtml(list, block.html, context, true, block.text);
      wrapper.append(list);
    } else {
      const lines = block.text.split(/\n+/).filter((line) => line.trim());
      const ordered = lines.length > 0 && lines.every((line) => /^\s*\d+[.)]\s/.test(line));
      const list = context.document.createElement(ordered ? "ol" : "ul");
      for (const line of lines) {
        const item = context.document.createElement("li");
        appendTextWithMath(item, line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""), context);
        list.append(item);
      }
      wrapper.append(list);
    }
  } else {
    const level = Math.round(finiteClamp(block.level ?? 2, 1, 6, 2));
    const element = context.document.createElement(block.kind === "heading" ? `h${level}` : "p");
    if (block.html) appendHtml(element, block.html, context, false, block.text);
    else appendTextWithMath(element, block.text, context);
    wrapper.append(element);
  }

  if (wrapper.querySelector(".pdf-reader-math-fallback")) wrapper.classList.add("has-math-fallback");
  appendSourceTools(wrapper, pages, context);
  return wrapper;
}

function appendImageOrText(parent: HTMLElement, block: ReaderBlock, context: RenderContext): void {
  const url = block.asset ? resolveAsset(block.asset, context.options) : undefined;
  if (url) {
    const caption = displayCaptions(block).join("\n");
    appendImage(parent, url, caption, context, block.text || caption, block.asset);
    return;
  }
  const fallback = context.document.createElement("p");
  fallback.className = "pdf-reader-render-notice";
  fallback.textContent = block.kind === "table" ? "原 PDF 表格裁图暂不可用，请查看源页。" : "图表暂不可用，请查看源页。";
  parent.append(fallback);
}

function appendImage(parent: HTMLElement, url: string, caption: string, context: RenderContext, altText?: string, assetReference?: string): void {
  const image = context.document.createElement("img");
  image.alt = (altText ?? caption).trim().slice(0, 300) || "文献图表";
  image.loading = "lazy";
  image.decoding = "async";
  image.className = "pdf-reader-image";
  image.tabIndex = 0;
  image.setAttribute("role", "button");
  image.setAttribute("aria-label", "放大查看图表");
  const setDimensions = (width: number, height: number): boolean => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
    image.setAttribute("width", String(width));
    image.setAttribute("height", String(height));
    image.style.aspectRatio = `${width} / ${height}`;
    return true;
  };
  const dimensions = assetReference ? context.options.assetDimensions?.(assetReference) : undefined;
  if (dimensions && setDimensions(dimensions.width, dimensions.height)) image.dataset.readerLayoutReserved = "true";
  image.addEventListener("load", () => {
    if (!image.hasAttribute("width") || !image.hasAttribute("height")) setDimensions(image.naturalWidth, image.naturalHeight);
  }, { once: true });
  image.addEventListener("click", () => context.options.onZoom(url, caption));
  image.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      context.options.onZoom(url, caption);
    }
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    const warning = context.document.createElement("p");
    warning.className = "pdf-reader-render-notice";
    warning.textContent = "图表无法加载，请查看源页。";
    image.after(warning);
  }, { once: true });
  image.src = url;
  parent.append(image);
}

function appendCaptions(parent: HTMLElement, block: ReaderBlock, context: RenderContext): void {
  const captions = displayCaptions(block);
  if (captions.length) {
    const caption = context.document.createElement("figcaption");
    for (const text of captions) {
      const paragraph = context.document.createElement("p");
      appendTextWithMath(paragraph, text, context);
      caption.append(paragraph);
    }
    parent.append(caption);
  }
  if (block.footnotes?.length) {
    const notes = context.document.createElement("div");
    notes.className = "pdf-reader-figure-footnotes";
    for (const text of block.footnotes) {
      const paragraph = context.document.createElement("p");
      appendTextWithMath(paragraph, text, context);
      notes.append(paragraph);
    }
    parent.append(notes);
  }
}

function displayCaptions(block: ReaderBlock): string[] {
  if (block.captions?.length) return block.captions;
  // A figure's text is often OCR from axes/panels. Retain it only when it is clearly a caption.
  const text = block.text.replace(/<[^>]*>/g, "").trim();
  if (block.kind === "figure" && /^(?:fig(?:ure)?\.?\s*(?:s?\d+[a-z]?|[ivx]+)\b|图\s*(?:\d+|[一二三四五六七八九十]+))/i.test(text)) return [block.text];
  return [];
}

function sectionEndAncillary(blocks: ReaderBlock[]): ReaderBlock[] {
  const ordered: ReaderBlock[] = [];
  let ancillary: ReaderBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "metadata" || block.kind === "header" || block.kind === "footer") {
      if (block.text.trim() || block.html?.trim() || block.asset || block.captions?.length || block.footnotes?.length) ancillary.push(block);
      continue;
    }
    if (block.kind === "heading") {
      ordered.push(...ancillary);
      ancillary = [];
    }
    ordered.push(block);
  }
  // Keep the final references fold last; its repeated page furniture belongs just before it.
  let referencesStart = ordered.length;
  while (referencesStart > 0) {
    const previous = ordered[referencesStart - 1];
    if (!previous || foldKind(previous) !== "references") break;
    referencesStart -= 1;
  }
  if (referencesStart < ordered.length) ordered.splice(referencesStart, 0, ...ancillary);
  else ordered.push(...ancillary);
  return ordered;
}

function appendSourceTools(parent: HTMLElement, pages: number[], context: RenderContext): void {
  if (!pages.length) return;
  const tools = context.document.createElement("div");
  tools.className = "pdf-reader-block-tools";
  for (const page of pages) {
    const source = context.document.createElement("button");
    source.type = "button";
    source.textContent = `原文 p.${page}`;
    source.title = `查看原 PDF 第 ${page} 页`;
    source.setAttribute("aria-label", source.title);
    source.addEventListener("click", () => context.options.onSource(page));
    tools.append(source);
  }
  const page = pages[0];
  if (page !== undefined) {
    const copy = context.document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制页链";
    copy.title = `复制 PDF 第 ${page} 页的链接`;
    copy.setAttribute("aria-label", copy.title);
    copy.addEventListener("click", () => context.options.onCopy(page));
    tools.append(copy);
  }
  parent.append(tools);
}

function appendHtml(parent: HTMLElement, html: string, context: RenderContext, table: boolean, fallbackText: string): void {
  try {
    const fragment = sanitizeHTMLToDom(html);
    // Character references may produce adjacent text nodes; a TeX expression spans them.
    fragment.normalize();
    for (const node of Array.from(fragment.childNodes)) appendSafeNode(parent, node, context, table);
  } catch {
    // The caller's plain text remains preferable to executing parser markup.
    parent.textContent = fallbackText || "内容无法排版，请查看源页。";
  }
}

function appendSafeNode(parent: HTMLElement, node: Node, context: RenderContext, table: boolean): void {
  if (node.nodeType === 3) {
    appendTextWithMath(parent, node.textContent ?? "", context, false);
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (OMIT_TAGS.has(tag)) return;
  const latex = element.getAttribute("data-math") ?? element.getAttribute("data-latex");
  if (tag === "SPAN" && (latex !== null || element.classList.contains("math-inline") || element.classList.contains("math-display"))) {
    appendMath(parent, stripMathDelimiters(latex ?? element.textContent ?? ""), element.classList.contains("math-display"), context);
    return;
  }
  if (tag === "IMG") {
    if (table) {
      const url = resolveAsset(element.getAttribute("src") ?? "", context.options);
      if (url) appendImage(parent, url, element.getAttribute("alt") ?? "", context, undefined, element.getAttribute("src") ?? undefined);
    }
    return;
  }
  let output: HTMLElement | undefined;
  if (INLINE_TAGS.has(tag) || (table && TABLE_TAGS.has(tag))) {
    output = context.document.createElement(tag.toLowerCase());
    if (tag === "TD" || tag === "TH") {
      for (const attribute of ["colspan", "rowspan"]) {
        const value = Number(element.getAttribute(attribute));
        if (Number.isInteger(value) && value > 0 && value <= 100) output.setAttribute(attribute, String(value));
      }
      const scope = element.getAttribute("scope");
      if (tag === "TH" && (scope === "row" || scope === "col")) output.setAttribute("scope", scope);
    }
    parent.append(output);
  } else if (tag === "A" && !table) {
    const href = element.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      output = context.document.createElement("a");
      output.setAttribute("href", href);
      output.setAttribute("target", "_blank");
      output.setAttribute("rel", "noopener noreferrer");
      parent.append(output);
    }
  }
  for (const child of Array.from(element.childNodes)) appendSafeNode(output ?? parent, child, context, table);
  if (!table && (tag === "P" || tag === "DIV") && element.nextSibling) parent.append(context.document.createElement("br"));
}

function appendTextWithMath(parent: HTMLElement, text: string, context: RenderContext, inlineMarkup = true): void {
  // MinerU commonly includes <sub>/<sup> in text and captions, without a separate html field.
  if (inlineMarkup && (/<\/?(?:span|sup|sub|em|strong|b|i|u|s|small|br|code|a)\b[^<>]*>/i.test(text) || /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i.test(text))) {
    appendHtml(parent, prepareInlineHTML(text), context, false, text);
    return;
  }
  // A lone dollar sign remains normal text; only paired delimiters trigger MathJax.
  const pattern = mathPattern();
  let offset = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > offset) parent.append(context.document.createTextNode(text.slice(offset, match.index)));
    const source = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    appendMath(parent, source, match[1] !== undefined || match[2] !== undefined, context);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parent.append(context.document.createTextNode(text.slice(offset)));
}

function mathPattern(): RegExp {
  return /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
}

/** Escape prose and formulas while retaining only inline tags for the sanitizer to inspect. */
function prepareInlineHTML(text: string): string {
  const tokens = new RegExp(`${mathPattern().source}|(<\\/?(?:span|sup|sub|em|strong|b|i|u|s|small|br|code|a)\\b[^<>]*>)`, "gi");
  let html = "";
  let offset = 0;
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    html += escapeInlineText(text.slice(offset, match.index));
    // Formula text is escaped as a whole, so comparisons and TeX content cannot become HTML.
    html += match[5] !== undefined ? match[0] : escapeInlineText(match[0]);
    offset = match.index + match[0].length;
  }
  return html + escapeInlineText(text.slice(offset));
}

function escapeInlineText(text: string): string {
  return text.replace(/&(?!(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);)/gi, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appendMath(parent: HTMLElement, source: string, display: boolean, context: RenderContext): boolean {
  try {
    if (!source.trim()) throw new Error("empty equation");
    const math = renderMath(source, display);
    if (math.querySelector("mjx-merror, .mjx-merror, [data-mjx-error]")) throw new Error("invalid equation");
    context.mathDocuments.add(math.ownerDocument);
    const element = math.ownerDocument === context.document ? math : context.document.adoptNode(math);
    element.classList.add(display ? "pdf-reader-display-math" : "pdf-reader-inline-math");
    parent.append(element);
    return true;
  } catch {
    const fallback = context.document.createElement("code");
    fallback.className = "pdf-reader-math-fallback";
    fallback.textContent = source || "公式未能排版";
    fallback.title = "公式未能排版，请用原文按钮查看源页";
    parent.append(fallback);
    return false;
  }
}

function resolveAsset(path: string, options: ReaderRenderOptions): string | undefined {
  let value = path.trim();
  if (!value) return undefined;
  try { value = decodeURIComponent(value); } catch { return undefined; }
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(value) || value.split(/[\\/]/).includes("..")) return undefined;
  try {
    const resolved = options.assetUrl(value);
    return /^(?:app:|blob:|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(resolved) ? resolved : undefined;
  } catch { return undefined; }
}

function stripMathDelimiters(text: string): string {
  const source = text.trim();
  for (const [start, end] of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]]) {
    if (start && end && source.startsWith(start) && source.endsWith(end)) return source.slice(start.length, -end.length).trim();
  }
  return source;
}

function foldKind(block: ReaderBlock): string | undefined {
  if (block.kind === "heading" && /^(?:\d+[.)]?\s+)?(?:references|bibliography|literature cited|参考文献)\s*[:：]?$/i.test(block.text.trim())) return "references";
  if (block.kind === "metadata" || block.kind === "references") return block.kind;
  if (block.kind === "header" || block.kind === "footer") return "page-furniture";
  if (block.hiddenByDefault && block.kind !== "footnote") return "additional";
  return undefined;
}

function foldLabel(kind: string): string {
  if (kind === "metadata") return "文献信息";
  if (kind === "references") return "参考文献";
  if (kind === "page-furniture") return "页眉与页脚";
  return "附加内容";
}

function sourcePages(block: ReaderBlock): number[] {
  return Array.from(new Set(block.sources.map((source) => source.page).filter((page) => Number.isInteger(page) && page > 0)));
}

function setSources(element: HTMLElement, pages: number[]): void {
  if (pages.length) element.dataset.sourcePages = Array.from(new Set(pages)).join(",");
}

function pagesFromElement(element: HTMLElement): number[] {
  return (element.dataset.sourcePages ?? "").split(",").map(Number).filter((page) => Number.isInteger(page) && page > 0);
}

function finiteClamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
