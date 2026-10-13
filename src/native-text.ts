interface NativeTextItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName?: string;
}

interface NativeViewport {
  width: number;
  height: number;
  scale: number;
  convertToViewportPoint: (x: number, y: number) => [number, number];
}

interface Span {
  text: string;
  left: number;
  right: number;
  baseline: number;
  size: number;
  leadingSpace: boolean;
  trailingSpace: boolean;
  ligature: boolean;
}

interface Line {
  baseline: number;
  size: number;
  spans: Span[];
}

/** Extract one normalized, top-left PDF bbox as escaped inline HTML. */
export function extractNativeRegion(
  items: NativeTextItem[],
  viewport: NativeViewport,
  bbox: [number, number, number, number],
): string {
  if (!bbox.every(Number.isFinite) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return "";
  const [left, top, right, bottom] = [
    bbox[0] * viewport.width, bbox[1] * viewport.height,
    bbox[2] * viewport.width, bbox[3] * viewport.height,
  ];
  const spans: Span[] = [];
  for (const item of items) {
    const [a, b, c, d, x, y] = item.transform;
    if ([a, b, c, d, x, y].some(value => value === undefined || !Number.isFinite(value))) continue;
    const text = item.str.replace(/[\uFB00-\uFB06]/g, value => value.normalize("NFKC")).trim();
    if (!text || item.width <= 0) continue;
    const [startX, baseline] = viewport.convertToViewportPoint(x!, y!);
    const length = Math.hypot(a!, b!);
    if (!length) continue;
    const [endX, endY] = viewport.convertToViewportPoint(
      x! + item.width * a! / length, y! + item.width * b! / length,
    );
    // Rotated/vertical writing needs the source crop, not a guessed reading order.
    if (endX <= startX || Math.abs(endY - baseline) > Math.max(1, (endX - startX) * 0.05)) continue;
    const size = (Math.hypot(c!, d!) || Math.abs(item.height)) * viewport.scale;
    if (!Number.isFinite(size) || size <= 0) continue;
    const centerX = (startX + endX) / 2;
    const centerY = baseline - size * 0.5;
    const tolerance = Math.max(1, size * 0.12);
    if (centerX < left! - tolerance || centerX > right! + tolerance ||
        centerY < top! - tolerance || centerY > bottom! + tolerance) continue;
    spans.push({ text, left: startX, right: endX, baseline, size,
      leadingSpace: /^\s/.test(item.str), trailingSpace: /\s$/.test(item.str),
      ligature: /[\uFB00-\uFB06]/.test(item.str) });
  }
  if (!spans.length) return "";
  const mainSize = weightedFontSize(spans);
  const normal = spans.filter(span => span.size >= mainSize * 0.85);
  const small = spans.filter(span => span.size < mainSize * 0.85);
  const lines: Line[] = [];
  for (const span of normal.sort((a, b) => a.baseline - b.baseline)) {
    const line = nearestLine(lines, span.baseline, mainSize * 0.55);
    if (line) {
      line.baseline = (line.baseline * line.spans.length + span.baseline) / (line.spans.length + 1);
      line.spans.push(span);
    } else lines.push({ baseline: span.baseline, size: span.size, spans: [span] });
  }
  for (const span of small) {
    const line = nearestLine(lines, span.baseline, mainSize * 0.55);
    if (line) line.spans.push(span);
    else lines.push({ baseline: span.baseline, size: span.size, spans: [span] });
  }
  if (hasColumnGutter(normal, mainSize, right! - left!)) return "";
  return lines.sort((a, b) => a.baseline - b.baseline).map(renderLine).join(" ");
}

function weightedFontSize(spans: Span[]): number {
  const sorted = [...spans].sort((a, b) => a.size - b.size);
  const weight = (span: Span) => span.text.replace(/\s/g, "").length * span.size;
  const midpoint = sorted.reduce((sum, span) => sum + weight(span), 0) / 2;
  let cumulative = 0;
  for (const span of sorted) {
    cumulative += weight(span);
    if (cumulative >= midpoint) return span.size;
  }
  return sorted[sorted.length - 1]!.size;
}

function nearestLine(lines: Line[], baseline: number, tolerance: number): Line | undefined {
  return lines.filter(line => Math.abs(line.baseline - baseline) <= tolerance)
    .sort((a, b) => Math.abs(a.baseline - baseline) - Math.abs(b.baseline - baseline))[0];
}

/** A persistent empty gutter with multiple baselines on both sides is not one region. */
function hasColumnGutter(spans: Span[], size: number, regionWidth: number): boolean {
  const sorted = [...spans].sort((a, b) => a.left - b.left);
  let occupiedRight = sorted[0]!.right;
  const minimumGap = Math.max(size * 1.8, regionWidth * 0.035);
  for (let index = 1; index < sorted.length; index++) {
    const span = sorted[index]!;
    if (span.left - occupiedRight > minimumGap) {
      const leftSide = spans.filter(item => item.right <= occupiedRight);
      const rightSide = spans.filter(item => item.left >= span.left);
      const multiline = (side: Span[]) => side.some(item =>
        side.some(other => Math.abs(item.baseline - other.baseline) > size * 0.8));
      if (multiline(leftSide) && multiline(rightSide)) return true;
    }
    occupiedRight = Math.max(occupiedRight, span.right);
  }
  return false;
}

function renderLine(line: Line): string {
  const spans = line.spans.sort((a, b) => a.left - b.left);
  let html = "";
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!;
    const previous = spans[index - 1];
    if (previous) {
      const glyphWidth = Math.min(
        (previous.right - previous.left) / previous.text.length,
        (span.right - span.left) / span.text.length,
      );
      const wordGap = Math.max(line.size * 0.1, glyphWidth * 0.35);
      if (previous.trailingSpace || span.leadingSpace || span.left - previous.right > wordGap) html += " ";
    }
    const text = escapeHtml(span.text);
    const offset = span.baseline - line.baseline;
    if (!span.ligature && span.size < line.size * 0.85 && Math.abs(offset) > line.size * 0.15) {
      const tag = offset > 0 ? "sub" : "sup";
      html += `<${tag}>${text}</${tag}>`;
    } else html += text;
  }
  return html.replace(/<\/sub><sub>/g, "").replace(/<\/sup><sup>/g, "");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}
