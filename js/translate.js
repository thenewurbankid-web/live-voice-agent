// Offline German→English text translation: Opus-MT (MarianMT) via transformers.js.
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';

export class Translator {
  async load(onProgress = () => {}) {
    if (this.pipe) return;
    const { pipeline } = await import(TRANSFORMERS);
    const files = {};
    this.pipe = await pipeline('translation', 'Xenova/opus-mt-de-en', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files[p.file] = [p.loaded, p.total];
        const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
        onProgress(l / t, 'Loading translator');
      },
    });
    onProgress(1, 'Translator ready');
  }

  async deToEn(text) {
    if (!this.pipe || !text.trim()) return '';
    // Opus-MT tends to drop everything after the first sentence, so translate per sentence.
    const parts = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
    const out = [];
    for (const p of parts) {
      const [r] = await this.pipe(p);
      if (r?.translation_text) out.push(r.translation_text.trim());
    }
    return out.join(' ');
  }
}
