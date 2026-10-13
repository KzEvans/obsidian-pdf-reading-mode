/** Decode only nearby images, one at a time, without delaying reader mounting. */
export function prepareNearbyImages(root: HTMLElement): () => void {
  const Observer = root.ownerDocument.defaultView?.IntersectionObserver;
  if (!Observer) return () => {};

  const nearby = new Set<HTMLImageElement>();
  const queued = new Set<HTMLImageElement>();
  const started = new WeakSet<HTMLImageElement>();
  const queue: HTMLImageElement[] = [];
  let running = false;
  let disposed = false;

  const drain = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (!disposed && queue.length) {
        const image = queue.shift()!;
        queued.delete(image);
        if (!nearby.has(image) || !root.contains(image)) continue;
        started.add(image);
        nearby.delete(image);
        observer.unobserve(image);
        image.loading = "eager";
        try {
          await image.decode?.();
        } catch {
          // The renderer's image error handler owns the original-PDF fallback.
        }
      }
    } finally {
      running = false;
    }
  };

  const observer = new Observer(entries => {
    if (disposed) return;
    for (const entry of entries) {
      const image = entry.target as HTMLImageElement;
      if (started.has(image)) continue;
      if (!entry.isIntersecting) { nearby.delete(image); continue; }
      nearby.add(image);
      if (!queued.has(image)) { queued.add(image); queue.push(image); }
    }
    void drain();
  }, { root, rootMargin: `${Math.ceil(Math.max(0, root.clientHeight || 0) * 2)}px 0px`, threshold: 0 });
  root.querySelectorAll<HTMLImageElement>("img").forEach(image => observer.observe(image));

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    queue.length = 0;
    queued.clear();
    nearby.clear();
  };
}
