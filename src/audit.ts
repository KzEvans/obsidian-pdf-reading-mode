import { extractNativeRegion } from './native-text';
import type { ReaderBlock, ReaderDocument, SourceRef } from './types';

export async function auditNativeText(pdf: any, document: ReaderDocument): Promise<void> {
  const originallyEmpty = new Set(document.blocks.filter(block => block.kind === 'paragraph' && !block.text.trim()).map(block => block.id));
  const pageWordEvidence = new Map<number, {words:Set<string>;compact:string[]}>();
  for (let page = 1; page <= pdf.numPages; page++) {
    const pdfPage = await pdf.getPage(page);
    const content = await pdfPage.getTextContent();
    const viewport = pdfPage.getViewport({ scale: 1 });
    const native = content.items.map((item: {str?: string}) => item.str ?? '').join(' ').normalize('NFKC');
    if (native.replace(/\s/g, '').length < 80) continue;

    const pageBlocks = document.blocks.filter(block => block.sources.some(source => source.page === page));
    const regions = new Map<ReaderBlock, string[]>();
    const regionalTexts: string[] = [];
    for (const block of pageBlocks) {
      const texts = block.sources.filter(source => source.page === page && source.bbox).map(source =>
        extractNativeRegion(content.items.filter((item: any) => typeof item.str === 'string'), viewport, source.bbox!));
      regions.set(block, texts);
      regionalTexts.push(...texts.filter(Boolean));
    }
    const sourceTexts = [native, ...regionalTexts];
    for (const block of pageBlocks) repairBlockLigatures(block, sourceTexts, regions.get(block) ?? []);

    for (const block of pageBlocks) {
      if (!document.blocks.includes(block)) continue;
      const regional = regions.get(block)?.[0];
      if (regional && ['paragraph', 'heading'].includes(block.kind)) {
        if (originallyEmpty.has(block.id)) {
          const duplicate = findDuplicateOwner(document.blocks, block, regional, sourceTexts, regions, page);
          if (duplicate) {
            if (duplicate.correctedText !== undefined) duplicate.owner.text = duplicate.correctedText;
            mergeSources(duplicate.owner, block.sources);
            document.blocks.splice(document.blocks.indexOf(block), 1);
          } else {
            block.text = regional;
          }
          clearEmptyWarning(document, block);
        } else if (block.kind === 'heading' && !block.text.includes('$') && plainLetters(regional) === plainLetters(block.text) && regional !== block.text) {
          block.text = regional;
        }
      }
    }
    for (const block of pageBlocks) {
      if (document.blocks.includes(block)) restoreBlockSubscripts(block,regions.get(block) ?? []);
    }
    // pdf.js may split a ligature glyph into its own item ("o ﬀ ers"), so compare letters only.
    const nativeLetters = native.toLowerCase().replace(/[^a-z]/g, '');
    for (const block of pageBlocks) {
      if (document.blocks.includes(block)) restoreLostLigatureF(block, nativeLetters);
    }

    const blocks = document.blocks.filter(block => block.sources.some(source => source.page === page));
    if (!blocks.length) document.warnings.push(`第 ${page} 页没有可用重排内容，请查看原页。`);
    const sourceText = sourceTexts.join(' ').replace(/<[^>]*>/g, ' ').normalize('NFKC');
    pageWordEvidence.set(page,{
      words:new Set((sourceText.match(/[A-Za-z]{4,}/g) ?? []).map((word: string) => word.toLowerCase())),
      compact:sourceTexts.map(compactText),
    });
  }
  // Later pages can prove that an earlier cloud paragraph spans both pages.
  // Score only after that provenance has been merged, avoiding false alarms.
  for (const [page,evidence] of pageWordEvidence) {
    const blocks = document.blocks.filter(block => block.sources.some(source => source.page === page));
    const extracted = blocks.filter(block =>
      ['paragraph', 'heading', 'footnote', 'list'].includes(block.kind) &&
      new Set(block.sources.map(source => source.page)).size === 1,
    ).map(block => block.text).join(' ').replace(/<[^>]*>/g, ' ').normalize('NFKC');
    const words = extracted.match(/[A-Za-z]{4,}/g) ?? [];
    const verified = words.filter(word => {
      const lower=word.toLowerCase();
      return evidence.words.has(lower) || evidence.compact.some(source=>source.includes(lower));
    });
    if (words.length > 30 && verified.length / words.length < 0.7) document.warnings.push(`第 ${page} 页文本与原文差异较多，请核对原页。`);
  }
  document.warnings = [...new Set(document.warnings)];
}

function clearEmptyWarning(document: ReaderDocument, block: ReaderBlock): void {
  document.warnings = document.warnings.filter(warning => warning !== `内容块 ${block.id.replace('block-', '')} 没有可显示内容。`);
}

function repairBlockLigatures(block: ReaderBlock, nativeTexts: string[], regionalTexts: string[]): void {
  for (const field of ['text', 'html'] as const) {
    const value = block[field];
    if (value) block[field] = repairVerifiedLigatures(value, nativeTexts, regionalTexts);
  }
  for (const field of ['captions', 'footnotes'] as const) {
    if (block[field]) block[field] = block[field]!.map(value => repairVerifiedLigatures(value, nativeTexts, regionalTexts));
  }
}

function restoreBlockSubscripts(block: ReaderBlock, regions: string[]): void {
  if (['metadata','header','footer','references'].includes(block.kind)) return;
  for (const field of ['text','html'] as const) {
    if (block[field]) block[field]=restoreVerifiedSubscripts(block[field]!,regions);
  }
  for (const field of ['captions','footnotes'] as const) {
    if (block[field]) block[field]=block[field]!.map(value=>restoreVerifiedSubscripts(value,regions));
  }
}

/** OCR can read an ff/ffi ligature glyph as one f ("ofers", "eficient"). A word is
 * repaired only when the native page letters, read with its neighbouring words,
 * lack the cloud spelling and contain exactly one doubled-f spelling. Markup,
 * TeX and short words stay as-is. */
function restoreLostLigatureF(block: ReaderBlock, nativeLetters: string): void {
  if (['metadata','header','footer'].includes(block.kind)) return;
  const repair = (value: string) => {
    const tokens = [...value.matchAll(/<[^>]*>|\$\$?[\s\S]*?\$\$?|\\[A-Za-z]+|[A-Za-z]+/g)];
    const words = tokens.filter(token => /^[A-Za-z]+$/.test(token[0]));
    const replacements = new Map<number, string>();
    words.forEach((word, position) => {
      const token = word[0];
      if (token.length < 4 || !/f/i.test(token)) return;
      const lower = token.toLowerCase();
      const previous = words[position - 1]?.[0].toLowerCase() ?? '';
      const next = words[position + 1]?.[0].toLowerCase() ?? '';
      // Widest context first; a short word alone is too common to prove anything.
      for (const [left, right] of [[previous, next], [previous, ''], ['', next]]) {
        if (!left && !right) continue;
        if (nativeLetters.includes(left + lower + right)) return;
        const candidates = new Set<string>();
        for (let index = 0; index < token.length; index++) {
          if (lower[index] !== 'f') continue;
          const doubled = lower.slice(0, index + 1) + 'f' + lower.slice(index + 1);
          if (nativeLetters.includes(left + doubled + right)) candidates.add(token.slice(0, index + 1) + 'f' + token.slice(index + 1));
        }
        if (candidates.size > 1) return;
        if (candidates.size === 1) { replacements.set(word.index!, [...candidates][0]!); return; }
      }
    });
    let result = value;
    for (const [start, replacement] of [...replacements].sort((a, b) => b[0] - a[0])) {
      result = result.slice(0, start) + replacement + result.slice(start + replacement.length - 1);
    }
    return result;
  };
  for (const field of ['text','html'] as const) {
    if (block[field]) block[field] = repair(block[field]!);
  }
  for (const field of ['captions','footnotes'] as const) {
    if (block[field]) block[field] = block[field]!.map(repair);
  }
}

/** Existing subscript contents are not part of the baseline-letter anchors. */
function mapBaselineLetters(value: string): LetterMap {
  return mapLetters(value.replace(/<sub\b[^>]*>[\s\S]*?<\/sub>|_\s*\{[^{}]*\}|_[A-Za-z0-9+-]|[\u2080-\u209F]/gi,
    token=>' '.repeat(token.length)));
}

function restoreVerifiedSubscripts(cloud: string, regions: string[]): string {
  const mapped=mapBaselineLetters(cloud);
  const operations=new Map<number,{end:number;text:string}>();
  const conflicts=new Set<number>();
  for (const regional of regions) {
    const native=mapBaselineLetters(regional);
    for (const subscript of regional.matchAll(/<sub>([^<]+)<\/sub>/g)) {
      const code=subscript[1]!.normalize('NFKC').replace(/\s/g,'');
      if (!/^[A-Za-z0-9+-]{1,8}$/.test(code)) continue;
      const nativeIndex=native.spans.findIndex(span=>span.start>=subscript.index!);
      const split=nativeIndex<0 ? native.spans.length : nativeIndex;
      if (!split) continue;
      let target:number|undefined;
      for (const width of [24,16,8,4]) {
        const left=native.letters.slice(Math.max(0,split-width),split);
        const right=native.letters.slice(split,split+24);
        const anchor=left+right;
        if (anchor.length<16) continue;
        const match=mapped.letters.indexOf(anchor);
        if (match>=0 && mapped.letters.indexOf(anchor,match+1)<0) { target=match+left.length;break; }
      }
      if (target===undefined) continue;
      const before=mapped.spans[target-1];
      if (!before) continue;
      const next=mapped.spans[target];
      const nativeBefore=native.spans[split-1]!;
      const closing=regional.slice(nativeBefore.end,subscript.index).replace(/\s/g,'');
      if (!/^[)\]}]*$/.test(closing)) continue;
      const gap=cloud.slice(before.end,next?.start ?? cloud.length);
      const prefix=closing ? gap.match(new RegExp('^\\s*'+closing.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))) : [''];
      if (!prefix) continue;
      const position=before.end+prefix[0]!.length;
      const remaining=cloud.slice(position,next?.start ?? cloud.length);
      // Preserve existing indices, including cloud TeX with spaced digits.
      // This pass repairs omissions; differing existing values need a review.
      if (/<sub\b|_\s*(?:\{|[A-Za-z0-9+-])/.test(remaining)) continue;
      const existing=remaining.match(/^\s*(?:<sup>([^<]+)<\/sup>|([\u2080-\u209F]+)|([0-9]+))/);
      let end=position;
      if (existing) {
        if ((existing[1] ?? existing[2] ?? existing[3] ?? '').normalize('NFKC').replace(/\s/g,'')!==code) continue;
        end=position+existing[0].length;
      }
      const math=[...cloud.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)]
        .find(formula=>position>formula.index! && position<formula.index!+formula[0].length);
      const text=math ? `_{${code}}` : `<sub>${code}</sub>`;
      const previous=operations.get(position);
      if (previous && (previous.end!==end || previous.text!==text)) conflicts.add(position);
      else operations.set(position,{end,text});
    }
  }
  let result=cloud;
  for (const [start,operation] of [...operations].sort((a,b)=>b[0]-a[0])) {
    if (!conflicts.has(start)) result=result.slice(0,start)+operation.text+result.slice(operation.end);
  }
  return result;
}

function repairVerifiedLigatures(value: string, sourceTexts: string[], regionalTexts: string[]): string {
  const evidence = sourceTexts.map(compactText);
  return value.replace(/([A-Za-z]*)<sup\b[^>]*>(fi|fl|ff|ffi|ffl|f)<\/sup>([A-Za-z]*)/g,
    (original: string, before: string, ligature: string, after: string, offset: number) => {
      if (!before && !after) return original;
      if (!/[a-z]/.test(before + after)) return original;
      if (regionalTexts.some(text => text.includes(original))) return original;
      const variants = [...new Set([ligature, ...(ligature === 'f' ? ['ff'] : ligature === 'fi' ? ['ffi'] : ligature === 'fl' ? ['ffl'] : [])])];
      const prefix = stripMarkup(value.slice(0, offset)).match(/([A-Za-z]+)[^A-Za-z]*$/)?.[1] ?? '';
      const suffix = stripMarkup(value.slice(offset + original.length)).match(/^[^A-Za-z]*([A-Za-z]+)/)?.[1] ?? '';
      for (const variant of variants) {
        const candidate = before + variant + after;
        if ((prefix || suffix) && evidence.some(text => text.includes(compactText(prefix + candidate + suffix)))) return candidate;
      }
      for (const variant of variants) {
        const candidate = before + variant + after;
        if (candidate.length >= 4 && evidence.some(text => text.includes(compactText(candidate)))) return candidate;
      }
      return original;
    });
}

interface DuplicateOwner {
  owner: ReaderBlock;
  correctedText?: string;
}

function findDuplicateOwner(blocks: ReaderBlock[], empty: ReaderBlock, regional: string, sourceTexts: string[], regions: Map<ReaderBlock,string[]>, page: number): DuplicateOwner | undefined {
  const index = blocks.indexOf(empty);
  const candidates: ReaderBlock[] = [];
  // Count prose blocks, so headers, publisher controls, and floating figures do
  // not turn an adjacent-page continuation into a distant paragraph.
  for (const direction of [-1, 1]) {
    let prose = 0;
    for (let cursor = index + direction; cursor >= 0 && cursor < blocks.length && prose < 4; cursor += direction) {
      const candidate = blocks[cursor]!;
      if (candidate.kind !== 'paragraph' || !candidate.text.trim()) continue;
      prose++;
      if (connectedSources(empty.sources, candidate.sources)) candidates.push(candidate);
    }
  }
  const fragment = compactText(regional);
  if (fragment.length < 80) return undefined;
  // A repeated source passage can be genuine prose in both layout regions.
  const pageText = compactText(sourceTexts[0] ?? '');
  const nativeIndex = pageText.indexOf(fragment);
  if (nativeIndex >= 0 && pageText.indexOf(fragment,nativeIndex+1) >= 0) return undefined;
  // PDF item order need not match the geometric region's reading order.
  // Another disjoint original region containing the passage proves a repeat.
  const emptySource = empty.sources.find(source => source.page === page && source.bbox)!;
  if (candidates.some(owner => owner.sources.filter(source => source.page === page && source.bbox).some((source,index) => {
    const a=emptySource.bbox!,b=source.bbox!;
    const disjoint=a[2]<=b[0] || b[2]<=a[0] || a[3]<=b[1] || b[3]<=a[1];
    return disjoint && compactText(regions.get(owner)?.[index] ?? '').includes(fragment);
  }))) return undefined;
  for (const candidate of candidates) repairBlockLigatures(candidate, sourceTexts, []);
  const matches = candidates.flatMap(owner => findNativeSpans(owner.text, regional).map(span => ({owner,span})));
  if (matches.length !== 1) return undefined;
  const {owner,span} = matches[0]!;
  if (compactText(owner.text).includes(fragment)) return {owner};
  const correctedText = replaceUniqueNativeSpan(owner.text, regional, span);
  return correctedText === undefined ? undefined : {owner,correctedText};
}

interface LetterMap {
  letters: string;
  spans: {start:number;end:number}[];
}

/** Locate visible letters while retaining offsets into the original inline markup. */
function mapLetters(value: string): LetterMap {
  const spans: LetterMap['spans'] = [];
  let letters = '';
  const tokens = /<[^>]*>|&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:\d+|x[\da-f]+);|\\(?:mathrm|mathbf|mathsf|operatorname|mathit|text|left|right)\b|./gisu;
  for (const token of value.matchAll(tokens)) {
    const original = token[0];
    if (/^(?:<|&|\\)/.test(original)) continue;
    for (const letter of original.normalize('NFKC')) {
      if (!/[A-Za-z]/.test(letter)) continue;
      letters += letter.toLowerCase();
      spans.push({start:token.index!,end:token.index!+original.length});
    }
  }
  return {letters,spans};
}

interface LigatureMap extends LetterMap {
  widths: number[];
}

/** Collapse only a two-f glyph run, retaining offsets and its native width. */
function mapLigatureLetters(value: string): LigatureMap {
  const mapped = mapLetters(value);
  const result: LigatureMap = {letters:'',spans:[],widths:[]};
  const joined = (left: number, right: number) =>
    !stripMarkup(value.slice(mapped.spans[left]!.end,mapped.spans[right]!.start)).length;
  for (let index = 0; index < mapped.letters.length; index++) {
    const doubled = mapped.letters.slice(index,index+2) === 'ff' && joined(index,index+1) &&
      !(mapped.letters[index-1] === 'f' && joined(index-1,index)) &&
      !(mapped.letters[index+2] === 'f' && joined(index+1,index+2));
    result.letters += mapped.letters[index];
    result.spans.push({start:mapped.spans[index]!.start,end:mapped.spans[index+(doubled ? 1 : 0)]!.end});
    result.widths.push(doubled ? 2 : 1);
    if (doubled) index++;
  }
  return result;
}

interface NativeSpan {start:number;end:number}

function findNativeSpans(cloud: string, regional: string): NativeSpan[] {
  const native = mapLigatureLetters(regional);
  if (native.widths.reduce((total,width)=>total+width,0) < 80) return [];
  const mapped = mapLigatureLetters(cloud);
  const spans: NativeSpan[] = [];
  for (let index = mapped.letters.indexOf(native.letters); index >= 0; index = mapped.letters.indexOf(native.letters,index+1)) {
    // Only native ff/ffi/ffl may lose one f in cloud extraction.
    if (native.widths.some((width,offset) => mapped.widths[index+offset]! > width)) continue;
    spans.push({start:mapped.spans[index]!.start,end:mapped.spans[index+native.letters.length-1]!.end});
    if (spans.length > 1) break;
  }
  return spans;
}

function replaceUniqueNativeSpan(cloud: string, regional: string, span: NativeSpan): string | undefined {
  const native = mapLetters(regional);
  if (native.letters.length < 80) return undefined;
  let {start,end} = span;
  // An unfinished formula boundary cannot be replaced without changing nearby
  // math. Fully enclosed formulas inside the proven span are native evidence.
  for (const math of cloud.matchAll(/(?<!\\)\$\$?[\s\S]*?(?<!\\)\$\$?/g)) {
    const left = math.index!;
    const right = left+math[0].length;
    if ((start > left && start < right) || (end > left && end < right)) return undefined;
  }
  const nativeLeading = regional.slice(0,native.spans[0]!.start);
  if (/<(?:sup|sub)\b/i.test(nativeLeading)) {
    const leading = cloud.slice(0,start).match(/<(?:sup|sub)\b[^>]*>[\d\s,.†‡*⁎–−-]+<\/(?:sup|sub)>\s*$/i);
    if (leading) start-=leading[0].length;
  }
  // Consume the source span's own trailing indices/citations/punctuation while
  // leaving following whitespace, prose, and formulas in place.
  const trailing = cloud.slice(end).match(/^(?:(?:<\/(?:sup|sub)>|<(?:sup|sub)\b[^>]*>[\d\s,.†‡*⁎–−-]+<\/(?:sup|sub)>|\[[\d\s,.–−-]+\]|[\d.!?,;:])+)/i)?.[0];
  if (trailing) end+=trailing.length;
  return cloud.slice(0,start)+regional+cloud.slice(end);
}

function connectedSources(left: SourceRef[], right: SourceRef[]): boolean {
  return left.some(a => right.some(b => {
    if (Math.abs(a.page - b.page) === 1) return true;
    if (a.page !== b.page || !a.bbox || !b.bbox) return false;
    const horizontalGap = Math.max(0, a.bbox[0] - b.bbox[2], b.bbox[0] - a.bbox[2]);
    const verticalGap = Math.max(0, a.bbox[1] - b.bbox[3], b.bbox[1] - a.bbox[3]);
    return (horizontalGap > 0 && horizontalGap <= 0.08) || (verticalGap <= 0.04 && horizontalGap === 0);
  }));
}

function mergeSources(owner: ReaderBlock, sources: SourceRef[]): void {
  for (const source of sources) {
    if (!owner.sources.some(existing => existing.page === source.page && JSON.stringify(existing.bbox) === JSON.stringify(source.bbox))) {
      owner.sources.push(source);
    }
  }
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:\d+|x[\da-f]+);/gi, ' ').normalize('NFKC');
}

function compactText(value: string): string {
  return stripMarkup(value)
    .replace(/\\(?:mathrm|mathbf|mathsf|operatorname|mathit|text|left|right)\b/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function plainLetters(value: string): string {
  return stripMarkup(value).replace(/[^A-Za-z]/g, '').toLowerCase();
}
