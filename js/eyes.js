// Eyes: camera + SmolVLM-256M captioner (for brains that cannot take images directly).
const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';
const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const PROMPT = 'Describe what you see in one short sentence.';

export class Eyes {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facing = 'user';
    this._enabled = true;
    this.tf = null;
    this.processor = null;
    this.model = null;
    this.canvas = document.createElement('canvas');
  }

  async open(facing = 'user') {
    this.facing = facing;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.classList.toggle('mirror', facing === 'user');
    try { await this.video.play(); } catch { /* autoplay may need a gesture */ }
  }

  async flip() {
    await this.open(this.facing === 'user' ? 'environment' : 'user');
  }

  setEnabled(on) {
    this._enabled = !!on;
    if (this.stream) this.stream.getVideoTracks().forEach((t) => { t.enabled = this._enabled; });
  }

  get enabled() { return this._enabled; }

  snapshot(maxSide = 448) {
    const v = this.video;
    if (!this._enabled || !this.stream || !v.videoWidth || !v.videoHeight) return null;
    const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').drawImage(v, 0, 0, w, h); // unmirrored: CSS handles the mirror
    return this.canvas.toDataURL('image/jpeg', 0.8);
  }

  async loadCaptioner(profile, onProgress = () => {}) {
    this.tf = await import(TF_URL);
    const { AutoProcessor, AutoModelForVision2Seq } = this.tf;
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let l = 0, t = 0;
        for (const f of files.values()) { l += f.loaded; t += f.total; }
        onProgress(t ? l / t : 0, 'Loading vision model');
      }
    };
    this.processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
    this.model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
      dtype: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' },
      device: profile && profile.webgpu ? 'webgpu' : 'wasm',
      progress_callback,
    });
    onProgress(1, 'Vision model ready');
  }

  async describe(dataUrl) {
    if (!this.model || !dataUrl) return '';
    const { RawImage } = this.tf;
    const image = await RawImage.fromURL(dataUrl);
    const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: PROMPT }] }];
    const text = this.processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await this.processor(text, [image], { do_image_splitting: false });
    const out = await this.model.generate({ ...inputs, max_new_tokens: 48 });
    const [caption] = this.processor.batch_decode(
      out.slice(null, [inputs.input_ids.dims.at(-1), null]),
      { skip_special_tokens: true },
    );
    return (caption || '').trim();
  }
}
