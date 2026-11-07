import { CreateWebWorkerMLCEngine } from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm';

export const BRAINS = [
  { key: 'phi-vision', label: 'Phi-3.5 Vision (sees images)', id: 'Phi-3.5-vision-instruct-q4f16_1-MLC', idF32: 'Phi-3.5-vision-instruct-q4f32_1-MLC', vision: true, qwen3: false, mobileOk: false },
  { key: 'qwen3-1.7', label: 'Qwen3 1.7B', id: 'Qwen3-1.7B-q4f16_1-MLC', idF32: 'Qwen3-1.7B-q4f32_1-MLC', vision: false, qwen3: true, mobileOk: true },
  { key: 'llama1b', label: 'Llama 3.2 1B (fast)', id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', idF32: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', vision: false, qwen3: false, mobileOk: true },
  { key: 'qwen0.5', label: 'Qwen2.5 0.5B (tiny)', id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', idF32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC', vision: false, qwen3: false, mobileOk: true },
];

export function defaultBrainKey(profile) {
  return profile && profile.mobile ? 'llama1b' : 'phi-vision';
}

const SYSTEM = [
  'You are Live, a friendly real-time voice and video assistant running fully on the user\'s phone.',
  'You CAN hear: the user talks to you and their speech is transcribed for you. Never say you are text-only or cannot hear.',
  'You CAN see: when the camera is on you get the live camera image or a description of it ("Camera view: ..."). Use it naturally.',
  'You HAVE memory: facts the user shared and earlier conversations are stored privately on this device and given to you. Never say you cannot remember or store information.',
  'You can also plan Berlin days and nights out, find places, give walking directions, translate German and Telugu, and search the web when it is on.',
  'Your replies are spoken aloud: answer in 1 to 3 short sentences, plain spoken English, no markdown, no lists, no emoji.',
].join(' ');

export class Brain {
  constructor(key, profile) {
    this.cfg = BRAINS.find((b) => b.key === key) || BRAINS.find((b) => b.key === defaultBrainKey(profile));
    this.profile = profile || {};
    this.engine = null;
    this.history = [];
    this.tail = Promise.resolve();
  }

  get vision() { return this.cfg.vision; }

  async load(onProgress) {
    const id = this.profile.f16 === false ? this.cfg.idF32 : this.cfg.id;
    const worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
    this.engine = await CreateWebWorkerMLCEngine(worker, id, {
      initProgressCallback: (r) => onProgress && onProgress(Math.min(0.97, r.progress ?? 0), r.text || 'Loading language model'),
    });
    // Warm-up: the first generation compiles GPU kernels (tens of seconds on phones). Do it now, while the
    // loading screen is up, so the user's first question doesn't sit on "Thinking".
    onProgress && onProgress(0.98, 'Warming up the brain (first time is slowest)');
    try {
      await Promise.race([
        this.engine.chat.completions.create({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 2, ...(this.cfg.qwen3 ? { extra_body: { enable_thinking: false } } : {}) }),
        new Promise((r) => setTimeout(r, 90000)),
      ]);
    } catch {}
    try { await this.engine.resetChat(); } catch {}
    onProgress && onProgress(1, 'Brain ready');
  }

  async *reply(text, { image = null, scene = null } = {}) {
    const prev = this.tail;
    let release;
    this.tail = new Promise((r) => (release = r));
    // A new question supersedes any unfinished answer: stop it and drain its stream, or the engine stays
    // locked by a half-read stream and every later reply sits on "Thinking" (seen on phones).
    const superseded = !!this.active;
    if (this.active) {
      const old = this.active; this.active = null;
      try { this.engine.interruptGenerate(); } catch {}
      await Promise.race([(async () => { try { for await (const _ of old) { /* drain */ } } catch {} })(), new Promise((r) => setTimeout(r, 1500))]);
    }
    if (!superseded) await Promise.race([prev, new Promise((r) => setTimeout(r, 3000))]);
    let stream = null;
    try {
      const userText = scene ? `Camera view: ${scene}\n${text}` : text;
      const content = image && this.vision
        ? [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: userText }]
        : userText;
      const mobile = this.profile.mobile;
      const past = this.history.slice(mobile ? -4 : -8);      // phones: shorter prompt = much faster first word
      const run = (fold) => {
        const msgs = fold
          ? [...past, { role: 'user', content: typeof content === 'string' ? `${SYSTEM}\n\n${content}` : [...content.slice(0, -1), { type: 'text', text: `${SYSTEM}\n\n${userText}` }] }]
          : [{ role: 'system', content: SYSTEM }, ...past, { role: 'user', content }];
        const req = { messages: msgs, stream: true, max_tokens: mobile ? 120 : 200, temperature: 0.7 };
        if (this.cfg.qwen3) req.extra_body = { enable_thinking: false };
        return this.engine.chat.completions.create(req);
      };
      try { stream = await run(false); } catch { stream = await run(true); }
      this.active = stream;

      let full = '', raw = '', emitted = 0, done = false;
      try {
        for await (const chunk of stream) {
          raw += chunk.choices[0]?.delta?.content || '';
          // strip complete <think>…</think>; hold back anything after an open <think>
          let clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
          const open = clean.indexOf('<think>');
          if (open >= 0) clean = clean.slice(0, open);
          else if (this.cfg.qwen3) clean = clean.replace(/<(t(h(i(n(k)?)?)?)?)?$/, '');
          if (this.cfg.qwen3 && emitted === 0) clean = clean.replace(/^\s+/, '');
          if (clean.length > emitted) {
            const delta = clean.slice(emitted);
            emitted = clean.length;
            full += delta;
            yield delta;
          }
        }
        done = true;
      } finally {
        // early exit (generator return) or error: stop generation and drain
        if (!done) this.engine.interruptGenerate();
        try { for await (const _ of stream) { /* drain */ } } catch { /* ignore */ }
      }
      if (this.active === stream) this.active = null;
      this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: full });
      this.history = this.history.slice(-8);
    } finally {
      release();
    }
  }

  interrupt() {
    if (this.engine) this.engine.interruptGenerate();
  }
}
