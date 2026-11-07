// Offline text translation in the shared ML worker (transformers.js): Opus-MT de→en and en→de (MarianMT),
// NLLB-200 distilled 600M for English ↔ Telugu. The worker splits Opus-MT input per sentence.
import { getMlWorker, progress } from './ml.js';

export class Translator {
  constructor() { this.ml = getMlWorker(); }

  async load(onProgress = () => {}) {
    if (this.pipe) return;
    await this.ml.loadTranslator('de-en', progress(onProgress), 'Loading translator');
    this.pipe = true;
    onProgress(1, 'Translator ready');
  }

  // English → Telugu text, offline: NLLB-200 distilled 600M (~600 MB, downloaded on first use).
  async loadTelugu(onProgress = () => {}) {
    if (this.nllb) return;
    await this.ml.loadTranslator('nllb', progress(onProgress), 'Loading Telugu translator');
    this.nllb = true;
    onProgress(1, 'Telugu translator ready');
  }

  async enToTe(text) {
    if (!this.nllb || !text.trim()) return '';
    return this.ml.translate('nllb', text, { src_lang: 'eng_Latn', tgt_lang: 'tel_Telu' });
  }

  async teToEn(text) {
    if (!this.nllb) await this.loadTelugu();
    return this.ml.translate('nllb', text, { src_lang: 'tel_Telu', tgt_lang: 'eng_Latn' });
  }

  // English → German, offline: Opus-MT en-de (loaded on first use by the worker).
  async enToDe(text) {
    return this.ml.translate('en-de', text);
  }

  async deToEn(text) {
    if (!this.pipe || !text.trim()) return '';
    return this.ml.translate('de-en', text);
  }
}
