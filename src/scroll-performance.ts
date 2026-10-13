export interface ScrollPerformanceReport {
  /** Number of frame intervals retained, capped at the most recent 1000. */
  frames: number;
  medianIntervalMs: number;
  p95IntervalMs: number;
  maxIntervalMs: number;
  framesOver25ms: number;
  longTasks: number;
  longTaskMs: number;
  focused: 0 | 1;
  viewportWidth: number;
  viewportHeight: number;
  domNodes: number;
  mathContainers: number;
  images: number;
  loadedImages: number;
}

const IDLE_MS = 200;
const MAX_SAMPLES = 1000;

/** Collect local numeric diagnostics only while scrolling and its short idle tail. */
export function observeScrollPerformance(root: HTMLElement, onReport: (report: ScrollPerformanceReport) => void): () => void {
  const document = root.ownerDocument;
  const win = document.defaultView;
  if (!win) return () => {};
  const now = () => win.performance.now();
  const useAnimationFrame = typeof win.requestAnimationFrame === 'function';
  const requestFrame = (callback: FrameRequestCallback): number => useAnimationFrame
    ? win.requestAnimationFrame(callback) : win.setTimeout(() => callback(now()), 16);
  const cancelFrame = (id: number) => useAnimationFrame ? win.cancelAnimationFrame(id) : win.clearTimeout(id);
  let active = false;
  let disposed = false;
  let startedAt = 0;
  let lastScrollAt = 0;
  let lastFrameAt: number | undefined;
  let frame: number | undefined;
  let idleTimer: number | undefined;
  const intervals: number[] = [];
  const tasks: number[] = [];
  let observer: PerformanceObserver | undefined;
  let domCounts: { nodes: number; math: number; images: HTMLImageElement[] } | undefined;

  const retain = (values: number[], value: number) => {
    values.push(value);
    if (values.length > MAX_SAMPLES) values.shift();
  };
  const collectTasks = (entries: PerformanceEntry[]) => {
    if (disposed || !active || document.hidden) return;
    const end = lastScrollAt + IDLE_MS;
    for (const entry of entries) {
      if (entry.entryType === 'longtask' && entry.startTime >= startedAt && entry.startTime < end &&
          Number.isFinite(entry.duration) && entry.duration > 0) retain(tasks, entry.duration);
    }
  };
  try {
    if (win.PerformanceObserver) {
      observer = new win.PerformanceObserver(list => collectTasks(list.getEntries()));
      observer.observe({ type: 'longtask' });
    }
  } catch { observer?.disconnect(); observer = undefined; }

  const reset = () => {
    active = false;
    if (frame !== undefined) cancelFrame(frame);
    if (idleTimer !== undefined) win.clearTimeout(idleTimer);
    frame = idleTimer = lastFrameAt = undefined;
    intervals.length = tasks.length = 0;
  };
  const tick = (timestamp: number) => {
    frame = undefined;
    if (disposed || !active) return;
    if (document.hidden) { reset(); return; }
    if (Number.isFinite(timestamp)) {
      if (lastFrameAt !== undefined) {
        const interval = timestamp - lastFrameAt;
        if (Number.isFinite(interval) && interval > 0) retain(intervals, interval);
      }
      lastFrameAt = timestamp;
    }
    if (now() - lastScrollAt < IDLE_MS) frame = requestFrame(tick);
  };
  const report = () => {
    idleTimer = undefined;
    if (disposed || !active) return;
    if (document.hidden) { reset(); return; }
    const remaining = IDLE_MS - (now() - lastScrollAt);
    if (remaining > 0) { idleTimer = win.setTimeout(report, remaining); return; }
    if (observer) collectTasks(observer.takeRecords());
    const sorted = [...intervals].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : 0;
    const rounded = (value: number) => Math.round(value * 100) / 100;
    // Query the DOM after scrolling has stopped, never from a scroll/frame callback.
    domCounts ??= {
      nodes: root.querySelectorAll('*').length,
      math: root.querySelectorAll('.pdf-reader-inline-math, .pdf-reader-display-math, .pdf-reader-math-fallback').length,
      images: Array.from(root.querySelectorAll<HTMLImageElement>('img')),
    };
    const images = domCounts.images;
    const result: ScrollPerformanceReport = {
      frames: sorted.length,
      medianIntervalMs: rounded(median),
      p95IntervalMs: rounded(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0),
      maxIntervalMs: rounded(sorted[sorted.length - 1] ?? 0),
      framesOver25ms: intervals.filter(interval => interval > 25).length,
      longTasks: tasks.length,
      longTaskMs: rounded(tasks.reduce((total, duration) => total + duration, 0)),
      focused: typeof document.hasFocus === 'function' && document.hasFocus() ? 1 : 0,
      viewportWidth: root.clientWidth,
      viewportHeight: root.clientHeight,
      domNodes: domCounts.nodes,
      mathContainers: domCounts.math,
      images: images.length,
      loadedImages: images.filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).length,
    };
    reset();
    onReport(result);
  };
  const scroll = () => {
    if (disposed || document.hidden) return;
    const timestamp = now();
    if (!active) { active = true; startedAt = timestamp; }
    lastScrollAt = timestamp;
    if (frame === undefined) frame = requestFrame(tick);
    if (idleTimer !== undefined) win.clearTimeout(idleTimer);
    idleTimer = win.setTimeout(report, IDLE_MS);
  };
  const visibility = () => { if (document.hidden) reset(); };
  root.addEventListener('scroll', scroll, { passive: true });
  document.addEventListener('visibilitychange', visibility);
  return () => {
    if (disposed) return;
    disposed = true;
    reset();
    observer?.disconnect();
    domCounts = undefined;
    root.removeEventListener('scroll', scroll);
    document.removeEventListener('visibilitychange', visibility);
  };
}
