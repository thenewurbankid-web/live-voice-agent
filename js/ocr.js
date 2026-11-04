// OCR: German text in the camera frame, via Tesseract.js (OSS). Everything is on cdn.jsdelivr.net
// (pinned) so sw.js caches the worker, wasm core and traineddata for offline use.
const TESS_VERSION = '7.0.0';
const CORE_VERSION = '6.1.2';
const TESS_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/+esm`;
const WORKER_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/worker.min.js`;
const CORE_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE_VERSION}`; // directory; picks the right wasm build
const LANG_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/deu@1.0.0/4.0.0_best_int'; // deu.traineddata.gz
const MIN_CONFIDENCE = 60;
const MIN_WORD_LEN = 3;

export class GermanOCR {
  constructor() {
    this.worker = null;
    this._loading = null;
    this._onProgress = null;
  }

  async load(onProgress) {
    if (onProgress) this._onProgress = onProgress;
    if (this.worker) return;
    if (!this._loading) {
      this._loading = (async () => {
        const mod = await import(TESS_URL);
        const T = mod.default && mod.default.createWorker ? mod.default : mod;
        this.worker = await T.createWorker('deu', 1, {
          workerPath: WORKER_PATH,
          corePath: CORE_PATH,
          langPath: LANG_PATH,
          logger: (m) => {
            if (this._onProgress && typeof m.progress === 'number') this._onProgress(m.progress, m.status);
          },
        });
      })().catch((e) => { this._loading = null; throw e; });
    }
    await this._loading;
  }

  async read(dataUrl) {
    if (!this.worker) await this.load();
    const { data } = await this.worker.recognize(dataUrl);
    const words = [];
    const walk = (lines) => {
      for (const line of lines || []) {
        const kept = (line.words || [])
          .filter((w) => w.confidence > MIN_CONFIDENCE && (w.text || '').trim().length >= MIN_WORD_LEN)
          .map((w) => w.text.trim());
        words.push(...kept);
      }
    };
    if (data.lines) walk(data.lines);
    else if (data.words) {
      words.push(...data.words
        .filter((w) => w.confidence > MIN_CONFIDENCE && (w.text || '').trim().length >= MIN_WORD_LEN)
        .map((w) => w.text.trim()));
    } else if (data.blocks) {
      for (const b of data.blocks) for (const p of b.paragraphs || []) walk(p.lines);
    }
    return words.join(' ').replace(/\s+/g, ' ').trim();
  }
}
