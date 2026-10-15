import { App, FileSystemAdapter, FileView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, loadPdfJs, setIcon, type View } from 'obsidian';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ReaderService, resolveAssetReference, PDF_RESOURCE_OPTIONS, type CachedReader } from './service';
import { renderReader, scrollToSourcePage, getVisibleSourcePage, createSourcePageTracker, blockSearchText } from './render';
import { readImageDimensions } from './image-size';
import { observeScrollPerformance } from './scroll-performance';
import { prepareNearbyImages } from './image-decode';

const SECRET_ID = 'pdf-reading-mode-mineru-api-token';
interface ReaderSettings { fontSize: number; lineHeight: number; scrollDiagnostics: boolean; positions: Record<string, number> }
interface NativeElement { element: HTMLElement; visibility: string; inert: boolean; ariaHidden: string | null }
interface LeafState {
  leaf: WorkspaceLeaf; view: View; file: TFile; filePath: string; revision: number; button: HTMLButtonElement;
  content: HTMLElement; document: Document; desired: boolean; generation: number; page: number;
  shell?: HTMLElement; root?: HTMLElement; waiting?: HTMLElement; pageLabel?: HTMLElement; search?: HTMLInputElement;
  nativeElements: NativeElement[]; cached?: CachedReader;
  originalEphemeral: View['setEphemeralState']; wrappedEphemeral: View['setEphemeralState'];
  saveTimer?: number;
  pageTracker?: ReturnType<typeof createSourcePageTracker>;
  stopScrollProfile?: () => void;
  stopImageDecoding?: () => void;
}

export default class PdfReadingModePlugin extends Plugin {
  settings: ReaderSettings = { fontSize: 18, lineHeight: 1.5, scrollDiagnostics: false, positions: {} };
  private states = new Map<WorkspaceLeaf, LeafState>();
  private service!: ReaderService;
  private assetJobs = new Map<string, Promise<CachedReader>>();
  private refreshTimer = 0;
  private disposed = false;

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<ReaderSettings> | null;
    this.settings = { fontSize: clamp(saved?.fontSize ?? 18, 16, 24), lineHeight: clamp(saved?.lineHeight ?? 1.5, 1.3, 1.8), scrollDiagnostics: saved?.scrollDiagnostics === true, positions: saved?.positions ?? {} };
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error('PDF Reading Mode 需要桌面版文件系统。');
    const directory = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir ?? this.app.vault.configDir + '/plugins/pdf-reading-mode');
    this.service = new ReaderService(this.app, directory, () => this.app.secretStorage.getSecret(SECRET_ID)?.trim() || null);
    this.addSettingTab(new ReaderSettingTab(this.app, this));
    this.addCommand({ id: 'toggle-reading-mode', name: '切换当前 PDF 的单栏阅读模式', checkCallback: checking => {
      const leaf = this.app.workspace.activeLeaf;
      if (!leaf || leaf.view.getViewType() !== 'pdf') return false;
      if (!checking) { this.refresh(); const state = this.states.get(leaf); if (state) void this.toggle(state); }
      return true;
    } });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.queueRefresh()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.queueRefresh()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.queueRefresh()));
    this.registerEvent(this.app.workspace.on('window-open', () => this.queueRefresh()));
    this.registerEvent(this.app.vault.on('modify', file => {
      for (const state of this.states.values()) if (state.file === file) {
        const reopen = state.desired; this.exit(state); state.cached = undefined; state.revision = state.file.stat.mtime;
        if (reopen) void this.toggle(state);
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      // Keep the reader open and its saved position when the open PDF is renamed or moved.
      if (file instanceof TFile && oldPath in this.settings.positions) {
        this.settings.positions[file.path] = this.settings.positions[oldPath]!;
        delete this.settings.positions[oldPath];
        void this.saveSettings();
      }
      for (const state of this.states.values()) if (state.file === file) state.filePath = file.path;
      this.queueRefresh();
    }));
    this.app.workspace.onLayoutReady(() => this.refresh());
  }

  onunload(): void {
    this.disposed = true; window.clearTimeout(this.refreshTimer); this.service?.stop();
    for (const state of this.states.values()) this.removeState(state);
    this.states.clear();
  }

  setToken(token: string): void { this.app.secretStorage.setSecret(SECRET_ID, token.trim()); }
  hasToken(): boolean { return Boolean(this.app.secretStorage.getSecret(SECRET_ID)); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  refreshTypography(): void {
    for (const state of this.states.values()) {
      state.root?.style.setProperty('--pdf-reader-font-size', this.settings.fontSize + 'px');
      state.root?.style.setProperty('--pdf-reader-line-height', String(this.settings.lineHeight));
    }
  }

  private queueRefresh(): void {
    window.clearTimeout(this.refreshTimer); this.refreshTimer = window.setTimeout(() => this.refresh(), 60);
  }

  private refresh(): void {
    if (this.disposed) return;
    const leaves = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (view.getViewType() !== 'pdf' || !view.containerEl.isConnected) return;
      const file = (view as FileView).file;
      if (!file) { this.queueRefresh(); return; }
      leaves.add(leaf);
      let state = this.states.get(leaf);
      if (state && (state.view !== view || state.filePath !== file.path || state.document !== view.containerEl.ownerDocument || !state.button.isConnected || !state.content.isConnected || state.content !== view.containerEl.querySelector('.view-content'))) {
        this.removeState(state); this.states.delete(leaf); state = undefined;
      }
      if (!state) { state = this.createState(leaf, file); if (state) this.states.set(leaf, state); }
      if (state && state.file !== file) {
        state.file = file;
        if (state.revision !== file.stat.mtime) {
          const reopen = state.desired; this.exit(state); state.cached = undefined; state.revision = file.stat.mtime;
          if (reopen) void this.toggle(state);
        }
      }
      if (state) this.placeButton(state);
    });
    for (const [leaf, state] of this.states) if (!leaves.has(leaf)) { this.removeState(state); this.states.delete(leaf); }
  }

  private createState(leaf: WorkspaceLeaf, file: TFile): LeafState | undefined {
    const view = leaf.view;
    const content = view.containerEl.querySelector<HTMLElement>('.view-content');
    const actions = view.containerEl.querySelector<HTMLElement>('.view-actions');
    if (!content || !actions) { this.queueRefresh(); return; }
    const document = view.containerEl.ownerDocument;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'clickable-icon pdf-reader-toggle';
    setIcon(button, 'book-open');
    const originalEphemeral = view.setEphemeralState;
    const state: LeafState = { leaf, view, file, filePath: file.path, revision: file.stat.mtime, content, document, button,
      desired: false, generation: 0, page: 1, nativeElements: [], originalEphemeral, wrappedEphemeral: originalEphemeral };
    state.wrappedEphemeral = (value: unknown) => {
      const incoming = value as { subpath?: unknown } | undefined;
      const subpath = typeof incoming?.subpath === 'string' ? incoming.subpath : '';
      const page = Number(/(?:^#?|&)page=(\d+)/.exec(subpath)?.[1]);
      const precise = /(?:^#?|&)(?:selection|annotation|offset)=/.test(subpath);
      if (precise && state.desired) this.exit(state, false);
      originalEphemeral.call(view, value);
      if (page > 0 && Number.isFinite(page)) {
        state.page = page;
        if (state.desired && state.root) this.navigateReader(state, page);
      }
    };
    view.setEphemeralState = state.wrappedEphemeral;
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void this.toggle(state); });
    actions.prepend(button); this.updateButton(state); return state;
  }

  private placeButton(state: LeafState): void {
    const translation = state.view.containerEl.querySelector('.pdf-translator-toggle');
    if (translation?.parentElement && state.button.previousElementSibling !== translation) translation.after(state.button);
  }

  private updateButton(state: LeafState): void {
    const label = state.desired ? '单栏阅读模式：已开启（点击返回原 PDF）' : '开启单栏阅读模式';
    state.button.classList.toggle('is-enabled', state.desired);
    state.button.setAttribute('aria-label', label); state.button.setAttribute('aria-pressed', String(state.desired)); state.button.title = label;
  }

  private async toggle(state: LeafState): Promise<void> {
    if (state.desired) { this.exit(state); return; }
    state.desired = true; state.generation++; this.updateButton(state);
    state.page = currentNativePage(state) || this.settings.positions[state.file.path] || 1;
    const generation = state.generation;
    const waiting = state.content.createDiv({ cls: 'pdf-reader-processing', attr: { role: 'status', 'aria-live': 'polite' } }); state.waiting = waiting;
    waiting.createSpan({ text: '正在准备单栏阅读…' });
    const cancel = waiting.createEl('button', { text: '继续原 PDF' }); cancel.addEventListener('click', () => this.exit(state));
    try {
      let cached = state.cached ?? await this.service.getDocument(state.file, message => {
        if (state.generation === generation && state.desired && state.waiting) state.waiting.querySelector('span')!.textContent = message;
      });
      if (!this.isCurrent(state, generation)) return;
      cached = await this.makeFallbackAssets(state, cached);
      if (!this.isCurrent(state, generation)) return;
      state.cached = cached; state.waiting?.remove(); state.waiting = undefined;
      await this.mountReader(state, generation);
    } catch (error) {
      if (!this.isCurrent(state, generation)) return;
      this.exit(state, false);
      const banner = state.content.createDiv({ cls: 'pdf-reader-processing is-error', attr: { role: 'alert' } }); state.waiting = banner;
      banner.createSpan({ text: error instanceof Error ? error.message : '阅读模式处理失败，请重试。' });
      banner.createEl('button', { text: '重试' }).addEventListener('click', () => { banner.remove(); state.waiting = undefined; void this.toggle(state); });
      banner.createEl('button', { text: '关闭' }).addEventListener('click', () => { banner.remove(); state.waiting = undefined; });
    }
  }

  private isCurrent(state: LeafState, generation: number): boolean {
    const file = (state.view as FileView).file;
    return !this.disposed && state.desired && state.generation === generation && state.view === state.leaf.view && file?.path === state.filePath && file.stat.mtime === state.revision && state.content.isConnected && state.view.containerEl.isConnected && state.view.containerEl.ownerDocument === state.document;
  }

  private async mountReader(state: LeafState, generation: number): Promise<void> {
    if (!state.cached) return;
    state.shell?.remove();
    const native = Array.from(state.content.children).filter(element => !element.classList.contains('pdf-reader-processing')) as HTMLElement[];
    const shell = state.content.createDiv({ cls: 'pdf-reader-shell' }); state.shell = shell;
    const toolbar = shell.createDiv({ cls: 'pdf-reader-toolbar' });
    state.pageLabel = toolbar.createSpan({ cls: 'pdf-reader-page-label', text: 'PDF p.' + state.page });
    const page = toolbar.createEl('input', { type: 'number', attr: { min: '1', max: String(state.cached.document.pageCount), 'aria-label': '跳转原文页码' } });
    page.value = String(state.page); page.style.width = '48px';
    page.addEventListener('change', () => this.navigateReader(state, clamp(Number(page.value), 1, state.cached!.document.pageCount)));
    const smaller = toolbar.createEl('button', { text: 'A−', attr: { 'aria-label': '减小字号' } });
    const larger = toolbar.createEl('button', { text: 'A+', attr: { 'aria-label': '增大字号' } });
    for (const [control, delta] of [[smaller, -1], [larger, 1]] as const) control.addEventListener('click', () => {
      this.settings.fontSize = clamp(this.settings.fontSize + delta, 16, 24); this.refreshTypography(); void this.saveSettings();
    });
    const search = toolbar.createEl('input', { type: 'search', placeholder: '查找正文', attr: { 'aria-label': '查找阅读内容' } }); state.search = search;
    const original = toolbar.createEl('button', { text: '原 PDF' }); original.addEventListener('click', () => this.exit(state));
    const root = shell.createDiv({ cls: 'pdf-reader-content', attr: { 'data-pdf-reader-active': 'false', tabindex: '0', 'aria-label': 'PDF 单栏阅读内容' } }); state.root = root;
    root.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); search.focus(); } });
    let searchIndex = 0;
    const find = () => {
      root.querySelectorAll('.pdf-reader-search-hit').forEach(element => element.classList.remove('pdf-reader-search-hit'));
      const term = search.value.trim().toLowerCase(); if (!term) return;
      const matches = Array.from(root.querySelectorAll<HTMLElement>('[data-reader-block-id]')).filter(element => blockSearchText(element).toLowerCase().includes(term));
      const match = matches[searchIndex % matches.length]; if (!match) return;
      match.closest('details')?.setAttribute('open', ''); match.classList.add('pdf-reader-search-hit'); match.scrollIntoView({ block: 'center' });
    };
    search.addEventListener('input', () => { searchIndex = 0; find(); }); search.addEventListener('keydown', event => { if (event.key === 'Enter') { searchIndex++; find(); } });
    await renderReader(root, state.cached.document, { fontSize: this.settings.fontSize, lineHeight: this.settings.lineHeight,
      assetUrl: reference => this.assetUrl(state.cached!, reference),
      assetDimensions: reference => state.cached!.assetDimensions?.[reference],
      isCurrent: () => this.isCurrent(state, generation),
      onSource: sourcePage => this.showOriginal(state, sourcePage), onCopy: sourcePage => void this.copySource(state, sourcePage),
      onZoom: (url, caption) => new FigureModal(this.app, url, caption).open() });
    if (!this.isCurrent(state, generation)) { shell.remove(); return; }
    if (state.cached.document.warnings.length) {
      const warnings = toolbar.createEl('button', { cls: 'pdf-reader-warnings', text: '核对提示 ' + state.cached.document.warnings.length });
      warnings.addEventListener('click', () => new MessageModal(this.app, state.cached!.document.warnings).open());
    }
    state.nativeElements = native.map(element => ({ element, visibility: element.style.visibility, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const { element } of state.nativeElements) { element.style.visibility = 'hidden'; element.inert = true; element.setAttribute('aria-hidden', 'true'); }
    state.content.classList.add('pdf-reading-mode-active'); root.dataset.pdfReaderActive = 'true';
    this.emitMode(state); this.navigateReader(state, state.page);
    state.stopImageDecoding = prepareNearbyImages(root);
    state.pageTracker = createSourcePageTracker(root, current => {
      state.page = current; page.value = String(current); state.pageLabel!.textContent = `PDF p.${current} / ${state.cached!.document.pageCount}`;
      const win = state.document.defaultView!; win.clearTimeout(state.saveTimer);
      state.saveTimer = win.setTimeout(() => { this.settings.positions[state.file.path] = state.page; void this.saveSettings(); }, 800);
    });
    if (!this.settings.scrollDiagnostics) return;
    const scrollReports: object[] = [];
    state.stopScrollProfile = observeScrollPerformance(root, report => {
      if (!this.isCurrent(state, generation)) return;
      scrollReports.push({ ...report, pageIndex: state.pageTracker?.getStats() });
      if (scrollReports.length > 12) scrollReports.shift();
      const profile = { version: this.manifest.version, reports: scrollReports };
      void fs.writeFile(path.join(state.cached!.directory, 'performance.json'), JSON.stringify(profile, null, 2)).catch(() => {});
    });
  }

  private navigateReader(state: LeafState, page: number): void {
    state.page = page;
    if (!state.root) return;
    scrollToSourcePage(state.root, page);
    if (state.pageLabel) state.pageLabel.textContent = `PDF p.${page} / ${state.cached?.document.pageCount ?? '?'}`;
  }

  private exit(state: LeafState, synchronize = true): void {
    const wasActive = state.root?.dataset.pdfReaderActive === 'true';
    const page = state.pageTracker?.getPage() ?? (state.root ? getVisibleSourcePage(state.root) || state.page : state.page);
    state.pageTracker?.dispose(); state.pageTracker = undefined;
    state.stopScrollProfile?.(); state.stopScrollProfile = undefined;
    state.stopImageDecoding?.(); state.stopImageDecoding = undefined;
    state.document.defaultView?.clearTimeout(state.saveTimer);
    if (wasActive) { this.settings.positions[state.file.path] = page; void this.saveSettings(); }
    state.desired = false; state.generation++; state.waiting?.remove(); state.waiting = undefined;
    if (state.root) state.root.dataset.pdfReaderActive = 'false';
    this.emitMode(state);
    for (const saved of state.nativeElements) {
      saved.element.style.visibility = saved.visibility; saved.element.inert = saved.inert;
      if (saved.ariaHidden === null) saved.element.removeAttribute('aria-hidden'); else saved.element.setAttribute('aria-hidden', saved.ariaHidden);
    }
    state.nativeElements = []; state.shell?.remove(); state.shell = undefined; state.root = undefined; state.pageLabel = undefined;
    state.content.classList.remove('pdf-reading-mode-active'); this.updateButton(state);
    if (wasActive && synchronize) {
      state.content.getBoundingClientRect(); state.originalEphemeral.call(state.view, { subpath: '#page=' + page, focus: false });
    }
  }

  private removeState(state: LeafState): void {
    state.document.defaultView?.clearTimeout(state.saveTimer); this.exit(state, false); state.button.remove();
    if (state.view.setEphemeralState === state.wrappedEphemeral) state.view.setEphemeralState = state.originalEphemeral;
  }
  private emitMode(state: LeafState): void {
    const CustomEvent = state.document.defaultView?.CustomEvent ?? window.CustomEvent;
    state.view.containerEl.dispatchEvent(new CustomEvent('pdf-reading-mode:mode-change', { bubbles: true, detail: { active: state.root?.dataset.pdfReaderActive === 'true' } }));
  }
  private showOriginal(state: LeafState, page: number): void {
    this.exit(state, false); state.content.getBoundingClientRect(); state.originalEphemeral.call(state.view, { subpath: '#page=' + page, focus: true });
  }
  private async copySource(state: LeafState, page: number): Promise<void> {
    // Follow the vault's link format settings (wikilink/Markdown, path style).
    const link = this.app.fileManager.generateMarkdownLink(state.file, '', '#page=' + page, 'PDF p.' + page);
    await state.document.defaultView!.navigator.clipboard.writeText(link); new Notice('原 PDF 页码链接已复制', 1800);
  }
  private assetUrl(cached: CachedReader, reference: string): string {
    const asset = resolveAssetReference(reference, cached.contentBase, cached.assets);
    if (!asset || !(this.app.vault.adapter instanceof FileSystemAdapter)) return '';
    const relative = path.relative(this.app.vault.adapter.getBasePath(), path.join(cached.directory, asset)).split(path.sep).join('/');
    return this.app.vault.adapter.getResourcePath(relative);
  }

  private async makeFallbackAssets(state: LeafState, cached: CachedReader): Promise<CachedReader> {
    const existing = this.assetJobs.get(cached.directory);
    if (existing) return await existing;
    const job = (async () => {
      const changed = await this.cropFallbackAssets(state, cached);
      const measured = await this.prepareAssetDimensions(cached);
      if (changed || measured) {
        await fs.writeFile(path.join(cached.directory, 'result.json.tmp'), JSON.stringify(cached));
        await fs.rename(path.join(cached.directory, 'result.json.tmp'), path.join(cached.directory, 'result.json'));
      }
      return cached;
    })();
    this.assetJobs.set(cached.directory, job);
    try { return await job; }
    finally { if (this.assetJobs.get(cached.directory) === job) this.assetJobs.delete(cached.directory); }
  }

  private async prepareAssetDimensions(cached: CachedReader): Promise<boolean> {
    const dimensions = cached.assetDimensions ??= {};
    const assets = Array.from(new Set(cached.document.blocks.map(block => block.asset).filter((asset): asset is string => Boolean(asset))));
    let changed = false;
    // Bound file reads; only the encoded header is needed to reserve layout space.
    for (let index = 0; index < assets.length; index += 8) {
      await Promise.all(assets.slice(index, index + 8).map(async asset => {
        if (dimensions[asset]) return;
        const resolved = resolveAssetReference(asset, cached.contentBase, cached.assets);
        if (!resolved) return;
        try {
          const measured = await readImageDimensions(path.join(cached.directory, resolved));
          if (measured) { dimensions[asset] = measured; changed = true; }
        } catch { /* The renderer provides a source-page fallback for unavailable images. */ }
      }));
    }
    return changed;
  }

  private async cropFallbackAssets(state: LeafState, cached: CachedReader): Promise<boolean> {
    const missing = cached.document.blocks.filter(block => block.sources[0]?.bbox && (
      block.kind === 'table' ? block.asset !== 'source-tables-v1/' + block.id + '.png' :
      ['figure', 'equation'].includes(block.kind) && !block.asset
    ));
    if (!missing.length) return false;
    const pending: typeof missing = [];
    for (const block of missing) {
      const asset = (block.kind === 'table' ? 'source-tables-v1/' : 'fallback-v2/') + block.id + '.png';
      try {
        await fs.access(path.join(cached.directory, asset)); block.asset = asset;
        if (!cached.assets.includes(asset)) cached.assets.push(asset);
      } catch { pending.push(block); }
    }
    // Existing source crops do not require opening the original PDF again.
    if (!pending.length) return true;
    const pages = new Map<number, typeof pending>();
    for (const block of pending) {
      const page = block.sources[0]!.page;
      const group = pages.get(page) ?? []; group.push(block); pages.set(page, group);
    }
    const pdfjs = await loadPdfJs(); const binary = await this.app.vault.readBinary(state.file);
    const pdf = await pdfjs.getDocument({ ...PDF_RESOURCE_OPTIONS, data: new Uint8Array(binary), useSystemFonts: true }).promise;
    try {
      for (const [pageNumber, blocks] of pages) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 * Math.min(state.document.defaultView?.devicePixelRatio ?? 1, 2) });
        const full = state.document.createElement('canvas'); full.width = Math.ceil(viewport.width); full.height = Math.ceil(viewport.height);
        try {
          await page.render({ canvas: full, canvasContext: full.getContext('2d'), viewport, intent: 'print' }).promise;
          for (const block of blocks) {
            const source = block.sources[0]!;
            const asset = (block.kind === 'table' ? 'source-tables-v1/' : 'fallback-v2/') + block.id + '.png';
            const box = source.bbox!;
            const padding = block.kind === 'table' ? 2 : 10;
            const padX = padding * viewport.scale / full.width, padY = padding * viewport.scale / full.height;
            const bottomPadY = (block.kind === 'table' ? 4 : 10) * viewport.scale / full.height;
            const [x0, y0, x1, y1] = [Math.max(0, box[0] - padX), Math.max(0, box[1] - (block.kind === 'table' ? 0 : padY)), Math.min(1, box[2] + padX), Math.min(1, box[3] + bottomPadY)];
            const crop = state.document.createElement('canvas');
            crop.width = Math.max(1, Math.ceil((x1 - x0) * full.width)); crop.height = Math.max(1, Math.ceil((y1 - y0) * full.height));
            try {
              const context = crop.getContext('2d')!;
              context.drawImage(full, x0 * full.width, y0 * full.height, crop.width, crop.height, 0, 0, crop.width, crop.height);
              // Preserve selectable captions, with the same original-PDF crop boundaries.
              if (block.kind === 'figure') for (const caption of block.sources.slice(1)) {
                if (caption.page !== source.page || !caption.bbox) continue;
                const [cx0, cy0, cx1, cy1] = caption.bbox;
                context.fillStyle = '#fff';
                context.fillRect((cx0 - x0) * full.width - 1, (cy0 - y0) * full.height - 1, (cx1 - cx0) * full.width + 2, (cy1 - cy0) * full.height + 2);
              }
              await fs.mkdir(path.dirname(path.join(cached.directory, asset)), { recursive: true });
              await fs.writeFile(path.join(cached.directory, asset), await encodeCanvas(crop));
              (cached.assetDimensions ??= {})[asset] = { width: crop.width, height: crop.height };
              block.asset = asset; if (!cached.assets.includes(asset)) cached.assets.push(asset);
            } finally { crop.width = 0; crop.height = 0; }
          }
        } finally { full.width = 0; full.height = 0; page.cleanup(); }
        // Give the UI a turn between source pages rather than occupying a long task.
        await new Promise<void>(resolve => state.document.defaultView!.setTimeout(resolve, 0));
      }
      return true;
    } finally { await pdf.destroy(); }
  }

}

class ReaderSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PdfReadingModePlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl('h2', { text: 'PDF Reading Mode' });
    containerEl.createEl('p', { text: '将文献 PDF 重排为连续单栏。首次开启会将当前 PDF 上传至 MinerU；缓存后可以离线阅读。原 PDF 和笔记保持原有链接。' });
    let token = '';
    const keySetting = new Setting(containerEl).setName('MinerU API Token').setDesc(this.plugin.hasToken() ? '密钥已保存在 Obsidian 安全凭据存储中。' : '输入精准解析 API Token，点击保存。');
    keySetting.addText(text => { text.inputEl.type = 'password'; text.setPlaceholder('输入 Token').onChange(value => { token = value; }); });
    keySetting.addButton(button => button.setButtonText('保存密钥').setCta().onClick(() => {
      if (!token.trim()) { new Notice('请输入 MinerU Token。'); return; }
      this.plugin.setToken(token); token = ''; this.display(); new Notice('MinerU 密钥已保存到安全凭据存储。');
    }));
    new Setting(containerEl).setName('正文字号').addSlider(slider => slider.setLimits(16, 24, 1).setValue(this.plugin.settings.fontSize).setDynamicTooltip().onChange(value => { this.plugin.settings.fontSize = value; this.plugin.refreshTypography(); void this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('正文行距').addSlider(slider => slider.setLimits(1.3, 1.8, 0.05).setValue(this.plugin.settings.lineHeight).setDynamicTooltip().onChange(value => { this.plugin.settings.lineHeight = value; this.plugin.refreshTypography(); void this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('滚动性能诊断').setDesc('排查卡顿时开启：在本地缓存目录记录 performance.json，不含正文且不上传。下次开启阅读模式时生效。')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.scrollDiagnostics).onChange(value => { this.plugin.settings.scrollDiagnostics = value; void this.plugin.saveSettings(); }));
    containerEl.createEl('p', { text: '阅读模式默认折叠作者及出版信息、参考文献，保留科学脚注与完整图注。旧选区或注释链接会恢复原 PDF 高亮。点击标签页右上角书本图标开始。' });
  }
}
class FigureModal extends Modal {
  constructor(app: App, private url: string, private caption: string) { super(app); }
  onOpen(): void { this.modalEl.classList.add('pdf-reader-figure-modal'); const image = this.contentEl.createEl('img', { attr: { src: this.url, alt: this.caption || '原文图表' } }); image.style.maxWidth = '100%'; image.style.height = 'auto'; this.contentEl.createEl('p', { text: this.caption }); }
  onClose(): void { this.contentEl.empty(); }
}
class MessageModal extends Modal {
  constructor(app: App, private messages: string[]) { super(app); }
  onOpen(): void { this.contentEl.createEl('h3', { text: '原文核对提示' }); const list = this.contentEl.createEl('ul'); for (const message of this.messages) list.createEl('li', { text: message }); }
  onClose(): void { this.contentEl.empty(); }
}
function clamp(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min; }
function currentNativePage(state: LeafState): number | undefined {
  const container = state.content.getBoundingClientRect();
  let best = 0, page: number | undefined;
  for (const element of Array.from(state.content.querySelectorAll<HTMLElement>('.page[data-page-number]'))) {
    const rect = element.getBoundingClientRect(); const area = Math.max(0, Math.min(container.bottom, rect.bottom) - Math.max(container.top, rect.top));
    if (area > best) { best = area; page = Number(element.dataset.pageNumber); }
  }
  const current = state.content.querySelector<HTMLInputElement>('.page-number input, input.page-number, input[type="number"]');
  return page || Number(current?.value) || undefined;
}

async function encodeCanvas(canvas: HTMLCanvasElement): Promise<Buffer> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
    if (value) resolve(value); else reject(new Error('原文图表生成失败，请重试。'));
  }, 'image/png'));
  return Buffer.from(await blob.arrayBuffer());
}
