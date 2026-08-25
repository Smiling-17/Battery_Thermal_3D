export class DigitalTwinDataLoader {
  constructor(baseUrl = "./processed/", maxCached = 3) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.manifest = null;
    this.chunkCache = new Map();
    this._inFlight = new Map();
    this._maxCached = maxCached;
  }

  async loadManifest() {
    const response = await fetch(`${this.baseUrl}manifest.json`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Cannot load processed manifest (${response.status}). Run tools/build_sys5_digital_twin.py first.`);
    }
    this.manifest = await response.json();
    return this.manifest;
  }

  getDefaultChunk() {
    if (!this.manifest?.chunks?.length) return null;
    const defaultDate = this.manifest.default_chunk?.date;
    return this.manifest.chunks.find((chunk) => chunk.date === defaultDate) ?? this.manifest.chunks[0];
  }

  getChunkByDate(date) {
    return this.manifest?.chunks?.find((chunk) => chunk.date === date) ?? null;
  }

  async loadChunk(chunkOrDate) {
    const chunk = typeof chunkOrDate === "string" ? this.getChunkByDate(chunkOrDate) : chunkOrDate;
    if (!chunk) throw new Error(`Unknown processed chunk: ${chunkOrDate}`);

    if (this.chunkCache.has(chunk.date)) {
      const payload = this.chunkCache.get(chunk.date);
      this.chunkCache.delete(chunk.date);
      this.chunkCache.set(chunk.date, payload);
      return payload;
    }

    if (this._inFlight.has(chunk.date)) return this._inFlight.get(chunk.date);

    const promise = (async () => {
      const response = await fetch(`${this.baseUrl}${chunk.path}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Cannot load ${chunk.path} (${response.status})`);
      const payload = await response.json();
      this._inFlight.delete(chunk.date);
      this.chunkCache.set(chunk.date, payload);
      this._evictOldChunks();
      return payload;
    })();

    this._inFlight.set(chunk.date, promise);
    return promise;
  }

  _evictOldChunks() {
    while (this.chunkCache.size > this._maxCached) {
      const oldestKey = this.chunkCache.keys().next().value;
      this.chunkCache.delete(oldestKey);
    }
  }

  getNextChunk(currentDate) {
    const chunks = this.manifest?.chunks;
    if (!chunks) return null;
    const idx = chunks.findIndex((c) => c.date === currentDate);
    return idx >= 0 && idx < chunks.length - 1 ? chunks[idx + 1] : null;
  }

  prefetchChunk(chunk) {
    if (!chunk) return;
    this.loadChunk(chunk).catch(() => {});
  }
}
