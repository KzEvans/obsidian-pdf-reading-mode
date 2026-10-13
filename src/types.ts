export type ReaderBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "figure"
  | "table"
  | "equation"
  | "footnote"
  | "metadata"
  | "references"
  | "header"
  | "footer";

/** Original PDF location: page is one-based; bbox is normalized, top-left origin. */
export interface SourceRef {
  page: number;
  bbox?: [number, number, number, number];
}

export interface ReaderBlock {
  id: string;
  kind: ReaderBlockKind;
  sources: SourceRef[];
  /** Provider HTML is untrusted and must be sanitized by the renderer. */
  html?: string;
  text: string;
  level?: number;
  /** Relative member path in the parser's result ZIP. */
  asset?: string;
  captions?: string[];
  footnotes?: string[];
  hiddenByDefault?: boolean;
}

export interface ReaderDocument {
  schemaVersion: 1;
  sourceHash: string;
  parserSignature: string;
  pageCount: number;
  blocks: ReaderBlock[];
  warnings: string[];
}
