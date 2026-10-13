import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { prepareNearbyImages } from "../src/image-decode";

function setup(count = 3) {
  const { document: dom } = parseHTML("<!doctype html><html><body></body></html>");
  const document = dom as unknown as Document;
  const root = document.createElement("div");
  Object.defineProperty(root, "clientHeight", { value: 400 });
  document.body.append(root);
  const images = Array.from({ length: count }, () => {
    const image = document.createElement("img"); image.loading = "lazy"; root.append(image); return image;
  });
  let callback: IntersectionObserverCallback | undefined;
  let options: IntersectionObserverInit | undefined;
  let disconnected = false;
  const observed = new Set<Element>();
  document.defaultView!.IntersectionObserver = class {
    constructor(next: IntersectionObserverCallback, init: IntersectionObserverInit) { callback = next; options = init; }
    observe(image: Element) { observed.add(image); }
    unobserve(image: Element) { observed.delete(image); }
    disconnect() { disconnected = true; observed.clear(); }
  } as unknown as typeof IntersectionObserver;
  const enter = (...entries: Array<[HTMLImageElement, boolean]>) => callback!(entries.map(([target, isIntersecting]) =>
    ({ target, isIntersecting }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
  return { root, images, enter, observed, get options() { return options; }, get disconnected() { return disconnected; } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("only nearby images decode serially, and a queued image leaving the margin is skipped", async () => {
  const h = setup();
  const first = deferred();
  const calls: number[] = [];
  h.images.forEach((image, index) => { image.decode = () => { calls.push(index); return index === 0 ? first.promise : Promise.resolve(); }; });
  const stop = prepareNearbyImages(h.root);
  try {
    assert.equal(h.observed.size, 3);
    assert.equal(h.options!.root, h.root);
    assert.equal(h.options!.rootMargin, "800px 0px");
    assert.equal(h.options!.threshold, 0);
    h.enter([h.images[0]!, true], [h.images[1]!, true]);
    assert.deepEqual(calls, [0]);
    assert.equal(h.images[0]!.loading, "eager");
    assert.equal(h.images[1]!.loading, "lazy");
    assert.equal(h.images[2]!.loading, "lazy");
    h.enter([h.images[1]!, false]);
    first.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls, [0]);
    h.enter([h.images[1]!, true]);
    await Promise.resolve();
    assert.deepEqual(calls, [0, 1]);
  } finally { stop(); }
});

test("decode failures are handled and disposing during a decode stops the remaining queue", async () => {
  const h = setup();
  const second = deferred();
  const calls: number[] = [];
  h.images[0]!.decode = () => { calls.push(0); return Promise.reject(new Error("invalid image")); };
  h.images[1]!.decode = () => { calls.push(1); return second.promise; };
  h.images[2]!.decode = () => { calls.push(2); return Promise.resolve(); };
  const stop = prepareNearbyImages(h.root);
  h.enter(...h.images.map(image => [image, true] as [HTMLImageElement, boolean]));
  await Promise.resolve();
  assert.deepEqual(calls, [0, 1]);
  stop(); stop();
  assert.equal(h.disconnected, true);
  second.resolve(); await Promise.resolve(); await Promise.resolve();
  h.enter([h.images[2]!, true]);
  assert.deepEqual(calls, [0, 1]);
  assert.equal(h.images[2]!.loading, "lazy");
});

test("without IntersectionObserver images retain native lazy loading and are not decoded", () => {
  const h = setup();
  h.root.ownerDocument.defaultView!.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
  let calls = 0;
  h.images.forEach(image => { image.decode = () => { calls++; return Promise.resolve(); }; });
  const stop = prepareNearbyImages(h.root);
  stop();
  assert.equal(calls, 0);
  assert.ok(h.images.every(image => image.loading === "lazy"));
});
