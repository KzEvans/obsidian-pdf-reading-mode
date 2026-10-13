import test from 'node:test';
import assert from 'node:assert/strict';
import { observeScrollPerformance, type ScrollPerformanceReport } from '../src/scroll-performance';

class Events {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const group = this.listeners.get(type) ?? new Set(); group.add(listener); this.listeners.set(type, group);
  }
  removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
  emit(type: string): void { for (const listener of [...this.listeners.get(type) ?? []]) listener(); }
}

function entry(startTime: number, duration: number, entryType = 'longtask'): PerformanceEntry {
  return { startTime, duration, entryType } as PerformanceEntry;
}

function harness(withObserver = false) {
  let clock = 0, nextId = 0, frameRequests = 0, domQueries = 0, disconnects = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const reports: ScrollPerformanceReport[] = [];
  const document = Object.assign(new Events(), { hidden: false, focused: true, hasFocus() { return this.focused; }, defaultView: undefined as any });
  class Observer {
    pending: PerformanceEntry[] = [];
    constructor(private callback: (list: { getEntries(): PerformanceEntry[] }) => void) { observer = this; }
    observe(options: object): void { assert.deepEqual(options, { type: 'longtask' }); }
    takeRecords(): PerformanceEntry[] { const records = this.pending; this.pending = []; return records; }
    disconnect(): void { disconnects++; }
    emit(entries: PerformanceEntry[]): void { this.callback({ getEntries: () => entries }); }
  }
  let observer: Observer | undefined;
  document.defaultView = {
    performance: { now: () => clock },
    requestAnimationFrame(callback: FrameRequestCallback) { frameRequests++; const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    setTimeout(callback: () => void, delay: number) { const id = ++nextId; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    PerformanceObserver: withObserver ? Observer : undefined,
  };
  const root = Object.assign(new Events(), {
    ownerDocument: document, clientWidth: 640, clientHeight: 480,
    querySelectorAll(selector: string) {
      domQueries++;
      if (selector === 'img') return [{ complete: true, naturalWidth: 640, naturalHeight: 480 }, { complete: false, naturalWidth: 0, naturalHeight: 0 }];
      if (selector === '*') return [{}, {}, {}, {}];
      return [{}, {}];
    },
  });
  const attach = () => observeScrollPerformance(root as unknown as HTMLElement, report => reports.push(report));
  return {
    root, document, frames, timers, reports, attach,
    observer: () => observer!,
    counts: () => ({ frameRequests, domQueries, disconnects }),
    time: (timestamp: number) => { clock = timestamp; },
    frame: (timestamp: number) => { clock = timestamp; const queued = [...frames.values()]; frames.clear(); for (const callback of queued) callback(timestamp); },
    timersAt: (timestamp: number) => {
      clock = timestamp;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); due[1].callback();
      }
    },
  };
}

test('scroll bursts share one frame, measure intervals, and query the DOM only after 200ms idle', () => {
  const h = harness(); const cleanup = h.attach();
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  for (let count = 0; count < 100; count++) h.root.emit('scroll');
  assert.equal(h.frames.size, 1); assert.equal(h.counts().frameRequests, 1); assert.equal(h.timers.size, 1);
  for (const timestamp of [16, 32, 72, 88]) h.frame(timestamp);
  h.time(100); for (let count = 0; count < 100; count++) h.root.emit('scroll');
  assert.equal(h.frames.size, 1); assert.equal(h.timers.size, 1);
  for (const timestamp of [104, 120, 160]) h.frame(timestamp);
  h.timersAt(299); assert.equal(h.reports.length, 0); assert.equal(h.counts().domQueries, 0);
  h.timersAt(300);
  assert.deepEqual(h.reports, [{
    frames: 6, medianIntervalMs: 16, p95IntervalMs: 40, maxIntervalMs: 40, framesOver25ms: 2,
    longTasks: 0, longTaskMs: 0, focused: 1, viewportWidth: 640, viewportHeight: 480,
    domNodes: 4, mathContainers: 2, images: 2, loadedImages: 1,
  }]);
  assert.ok(Object.values(h.reports[0]!).every(value => typeof value === 'number' && Number.isFinite(value)));
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  h.frame(1000); h.timersAt(1000); assert.equal(h.reports.length, 1);
  assert.equal(h.counts().domQueries, 3);
  h.time(1100); h.root.emit('scroll'); h.frame(1116); h.frame(1148); h.timersAt(1300);
  assert.equal(h.reports.length, 2); assert.equal(h.reports[1]!.maxIntervalMs, 32);
  assert.equal(h.counts().domQueries, 3);
  cleanup();
});

test('hidden documents discard sampling while an unfocused visible window reports focus zero', () => {
  const h = harness(true); const cleanup = h.attach();
  h.document.hidden = true; h.root.emit('scroll');
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.document.emit('visibilitychange'); h.root.emit('scroll'); h.frame(16);
  h.document.hidden = true; h.document.emit('visibilitychange');
  h.observer().emit([entry(16, 80)]);
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  h.timersAt(1000); assert.equal(h.reports.length, 0); assert.equal(h.counts().domQueries, 0);
  h.document.hidden = false; h.document.focused = false; h.document.emit('visibilitychange');
  h.time(1100); h.root.emit('scroll'); h.frame(1116); h.frame(1156); h.timersAt(1300);
  assert.equal(h.reports.length, 1); assert.equal(h.reports[0]!.focused, 0);
  assert.equal(h.reports[0]!.frames, 1); assert.equal(h.reports[0]!.maxIntervalMs, 40);
  assert.equal(h.reports[0]!.longTasks, 0);
  cleanup();
});

test('long tasks are filtered to the current scroll window and pending observer records are included at idle', () => {
  const h = harness(true); const cleanup = h.attach();
  h.observer().emit([entry(10, 100)]);
  h.time(100); h.root.emit('scroll');
  h.observer().emit([entry(80, 50), entry(110, 60), entry(300, 55), entry(120, 900, 'mark'), entry(140, NaN)]);
  h.frame(116); h.frame(132); h.time(160); h.root.emit('scroll');
  h.time(340); h.observer().emit([entry(320, 70)]);
  h.observer().pending.push(entry(250, 75), entry(95, 52));
  h.timersAt(360);
  assert.equal(h.reports[0]!.longTasks, 3); assert.equal(h.reports[0]!.longTaskMs, 205);
  h.observer().emit([entry(370, 80)]); h.timersAt(1000);
  assert.equal(h.reports.length, 1);
  cleanup();
});

test('cleanup cancels pending work, removes listeners and ignores already queued observer delivery', () => {
  const h = harness(true); const cleanup = h.attach();
  h.root.emit('scroll'); h.frame(16);
  cleanup(); cleanup();
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0); assert.equal(h.counts().disconnects, 1);
  assert.equal(h.root.listeners.get('scroll')!.size, 0); assert.equal(h.document.listeners.get('visibilitychange')!.size, 0);
  h.root.emit('scroll'); h.observer().emit([entry(20, 90)]); h.frame(100); h.timersAt(1000);
  assert.equal(h.reports.length, 0); assert.equal(h.counts().domQueries, 0); assert.equal(h.frames.size, 0);
});

test('long continuous scrolls retain at most the most recent 1000 frame and task samples', () => {
  const h = harness(true); const cleanup = h.attach();
  h.root.emit('scroll'); h.frame(0); h.frame(50);
  for (let count = 1; count <= 1005; count++) {
    h.frame(50 + count);
    if (count % 100 === 0) h.root.emit('scroll');
    h.observer().emit([entry(50 + count, 51)]);
  }
  h.timersAt(1250);
  const report = h.reports[0]!;
  assert.equal(report.frames, 1000); assert.equal(report.maxIntervalMs, 1); assert.equal(report.framesOver25ms, 0);
  assert.equal(report.longTasks, 1000); assert.equal(report.longTaskMs, 51000);
  assert.equal(h.frames.size, 0);
  cleanup();
});
