import { App, TFile, loadPdfJs, requestUrl } from 'obsidian';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { normalizeContentList } from './normalize';
import { auditNativeText } from './audit';
import type { ReaderDocument } from './types';

const API = 'https://mineru.net/api/v4';
export const CACHE_SIGNATURE = 'mineru-cloud-vlm-content-list-v1-reader-v6';
export const PDF_RESOURCE_OPTIONS = { cMapUrl: '/lib/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/lib/pdfjs/standard_fonts/', wasmUrl: '/lib/pdfjs/wasm/', iccUrl: '/lib/pdfjs/iccs/', isEvalSupported: false };
export interface CachedReader { document: ReaderDocument; directory: string; contentBase: string; assets: string[] }
interface PendingJob { batchId: string; uploaded: boolean }

export function resolveAssetReference(reference: string, contentBase: string, assets: string[]): string | undefined {
  if (!reference || /^(?:[a-z]+:|\/|\\)/i.test(reference)) return undefined;
  const normalized = reference.replace(/\\/g, '/');
  const direct = path.posix.normalize(normalized);
  const relative = path.posix.normalize(path.posix.join(contentBase, normalized));
  return [direct, relative].find(candidate => !candidate.startsWith('../') && assets.includes(candidate));
}

export function unpackResult(bytes: Uint8Array): { items: unknown; entries: Record<string, Uint8Array>; contentBase: string; assets: string[] } {
  const entries = unzipSync(bytes, { filter: entry => entry.originalSize <= 64 * 1024 * 1024 });
  let size = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('解析包包含非法资源路径。');
    size += data.byteLength;
  }
  if (size > 512 * 1024 * 1024) throw new Error('解析结果过大，请继续使用原 PDF。');
  const lists = Object.keys(entries).filter(name => /(?:^|\/)(?:.*_)?content_list\.json$/.test(name));
  if (lists.length !== 1) throw new Error('MinerU 未返回兼容的结构化内容列表，请保留原 PDF 并重试。');
  const name = lists[0]!;
  const items: unknown = JSON.parse(strFromU8(entries[name]!));
  if (!Array.isArray(items)) throw new Error('MinerU 内容列表格式不兼容。');
  return { items, entries, contentBase: path.posix.dirname(name), assets: Object.keys(entries).filter(name => /\.(?:png|jpe?g|webp|gif)$/i.test(name)) };
}

export class ReaderService {
  private jobs = new Map<string, Promise<CachedReader>>();
  private listeners = new Map<string, Set<(status: string) => void>>();
  private stopped = false;
  constructor(private app: App, readonly pluginDirectory: string, private token: () => string | null) {}

  stop(): void { this.stopped = true; this.listeners.clear(); }

  async getDocument(file: TFile, status: (message: string) => void): Promise<CachedReader> {
    const binary = await this.app.vault.readBinary(file);
    const hash = createHash('sha256').update(new Uint8Array(binary)).digest('hex');
    const listeners = this.listeners.get(hash) ?? new Set<(status: string) => void>();
    listeners.add(status); this.listeners.set(hash, listeners);
    let job = this.jobs.get(hash);
    if (!job) {
      job = this.process(file, binary, hash, message => this.listeners.get(hash)?.forEach(fn => fn(message)));
      this.jobs.set(hash, job);
    }
    try { return await job; }
    finally { listeners.delete(status); if (this.jobs.get(hash) === job) this.jobs.delete(hash); }
  }

  private async process(file: TFile, binary: ArrayBuffer, hash: string, status: (message: string) => void): Promise<CachedReader> {
    const directory = path.join(this.pluginDirectory, 'cache', hash + '-vlm-v1');
    const resultPath = path.join(directory, 'result.json');
    let cachedRaw: ReturnType<typeof unpackResult> | undefined;
    try {
      const saved = JSON.parse(await fs.readFile(resultPath, 'utf8')) as CachedReader;
      if (saved.document.schemaVersion === 1 && saved.document.sourceHash === hash && saved.document.parserSignature === CACHE_SIGNATURE && Array.isArray(saved.document.blocks)) {
        status('已载入离线阅读缓存'); return { ...saved, directory };
      }
      if (saved.document.sourceHash === hash && Array.isArray(saved.assets)) {
        const names = await fs.readdir(directory, { recursive: true });
        const contentName = names.find(name => /(?:^|\/)(?:.*_)?content_list\.json$/.test(name));
        if (contentName) cachedRaw = { items: JSON.parse(await fs.readFile(path.join(directory, contentName), 'utf8')), entries: {}, contentBase: path.posix.dirname(contentName), assets: saved.assets };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (!cachedRaw && !this.token()) throw new Error('请在 PDF Reading Mode 设置中保存 MinerU API Token。');
    if (binary.byteLength > 200 * 1024 * 1024) throw new Error('MinerU 云端支持最大 200 MB 文件，请继续使用原 PDF。');
    status('正在检查原 PDF');
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ ...PDF_RESOURCE_OPTIONS, data: new Uint8Array(binary.slice(0)), useSystemFonts: true }).promise;
    try {
      if (cachedRaw) { status('正在从离线缓存补齐原文'); return await this.finalize(cachedRaw, pdf, hash, directory, resultPath, status); }
      if (pdf.numPages > 200) throw new Error('MinerU 云端支持最多 200 页，请继续使用原 PDF。');
      await fs.mkdir(directory, { recursive: true });
      const jobPath = path.join(directory, 'job.json');
      let pending: PendingJob | undefined;
      try { pending = JSON.parse(await fs.readFile(jobPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (!pending?.batchId || !pending.uploaded) {
        status('正在上传到 MinerU');
        const created = await this.api('/file-urls/batch', 'POST', { files: [{ name: 'paper.pdf', data_id: 'reader_' + hash.slice(0, 24) }], model_version: 'vlm', enable_formula: true, enable_table: true, language: 'en' });
        const uploadUrl = created.data?.file_urls?.[0];
        if (typeof created.data?.batch_id !== 'string' || typeof uploadUrl !== 'string' || !uploadUrl.startsWith('https://')) throw new Error('MinerU 没有返回有效的上传地址。');
        const upload = await requestUrl({ url: uploadUrl, method: 'PUT', body: binary, throw: false });
        if (upload.status < 200 || upload.status >= 300) throw new Error('PDF 上传失败，请重试。');
        pending = { batchId: created.data.batch_id, uploaded: true };
        await this.atomicWrite(jobPath, JSON.stringify(pending));
      }
      const deadline = Date.now() + 30 * 60 * 1000;
      let zipUrl = '';
      while (!zipUrl) {
        if (this.stopped) throw new Error('插件已关闭；下次开启时将继续获取解析结果。');
        const polled = await this.api('/extract-results/batch/' + encodeURIComponent(pending!.batchId), 'GET');
        const result = polled.data?.extract_result?.[0];
        if (!result) throw new Error('MinerU 未返回任务状态，请重试。');
        if (result.state === 'failed') { await fs.unlink(jobPath).catch(() => {}); throw new Error('MinerU 解析失败，请重试或查看原 PDF。'); }
        if (result.state === 'done') {
          if (typeof result.full_zip_url !== 'string' || !result.full_zip_url.startsWith('https://')) throw new Error('MinerU 未返回有效结果地址。');
          zipUrl = result.full_zip_url; break;
        }
        const progress = result.extract_progress;
        status(result.state === 'running' ? `正在解析${progress ? '：' + progress.extracted_pages + '/' + progress.total_pages + ' 页' : ''}` : result.state === 'converting' ? '正在生成阅读内容' : 'MinerU 排队中，可继续阅读原 PDF');
        if (Date.now() > deadline) throw new Error('解析仍在处理中，稍后重试将继续获取同一任务。');
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      status('正在整理单栏图文');
      const archive = await requestUrl({ url: zipUrl, throw: false });
      if (archive.status !== 200) throw new Error('解析结果下载失败，重试将继续获取同一任务。');
      const unpacked = unpackResult(new Uint8Array(archive.arrayBuffer));
      const saved = await this.finalize(unpacked, pdf, hash, directory, resultPath, status);
      await fs.unlink(jobPath).catch(() => {});
      return saved;
    } finally { await pdf.destroy(); }
  }

  private async finalize(unpacked: ReturnType<typeof unpackResult>, pdf: any, hash: string, directory: string, resultPath: string, status: (message: string) => void): Promise<CachedReader> {
      const document = normalizeContentList(unpacked.items, hash, CACHE_SIGNATURE, pdf.numPages);
      for (const block of document.blocks) {
        if (block.asset) {
          const asset = resolveAssetReference(block.asset, unpacked.contentBase, unpacked.assets);
          if (!asset) document.warnings.push(`第 ${block.sources[0]?.page ?? '?'} 页图片资源缺失，请核对原页。`);
          block.asset = asset;
        }
      }
      await auditNativeText(pdf, document);
      for (const [name, bytes] of Object.entries(unpacked.entries)) {
        if (!/\.(?:json|md|png|jpe?g|webp|gif)$/i.test(name)) continue;
        const destination = path.join(directory, name);
        await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes);
      }
      const saved: CachedReader = { document, directory, contentBase: unpacked.contentBase, assets: unpacked.assets };
      await this.atomicWrite(resultPath, JSON.stringify(saved));
      status('单栏阅读已就绪'); return saved;
  }

  private async api(endpoint: string, method: string, body?: object): Promise<any> {
    const token = this.token();
    if (!token) throw new Error('MinerU API Token 未配置。');
    const response = await requestUrl({ url: API + endpoint, method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, throw: false });
    if (response.status === 401 || response.status === 403) throw new Error('MinerU Token 无效或已过期，请在设置中更新。');
    if (response.status === 429) throw new Error('MinerU 请求受限，请稍后重试。');
    if (response.status >= 400) throw new Error('MinerU 请求失败，HTTP ' + response.status + '。');
    const data = response.json;
    if (data?.code !== 0) throw new Error('MinerU 返回错误，状态码 ' + String(data?.code ?? 'unknown') + '。');
    return data;
  }

  private async atomicWrite(destination: string, contents: string): Promise<void> {
    await fs.writeFile(destination + '.tmp', contents); await fs.rename(destination + '.tmp', destination);
  }
}

