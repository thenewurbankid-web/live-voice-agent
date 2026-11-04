// Aware mode: watches the camera while the user is quiet and speaks up when something new appears.
// Deterministic gates first (cheap frame difference, rate limits); the captioner runs only on a settled change.
const TEXTY = /\b(sign|menu|text|writing|words|letter|paper|poster|label|book|page|screen|board|notice|ticket|map|document)\b/i;

export class Aware {
  // eyes: Eyes; canSpeak: () => boolean (user quiet and agent idle); onRemark: ({ text, scene, texty, frame }) => void
  constructor({ eyes, canSpeak, onRemark, everyMs = 2500, describeGapMs = 10000, remarkGapMs = 30000 }) {
    Object.assign(this, { eyes, canSpeak, onRemark, everyMs, describeGapMs, remarkGapMs });
    this.small = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
    this.prev = null; this.changedAt = 0; this.lastDescribe = 0; this.lastRemark = 0; this.lastScene = '';
  }

  start() { this.stop(); this.timer = setInterval(() => this.tick().catch(() => {}), this.everyMs); }
  stop() { clearInterval(this.timer); this.timer = null; }
  get running() { return !!this.timer; }

  // Mean absolute grey-level difference between this frame and the previous one (0..255).
  _diff() {
    const v = this.eyes.video;
    if (!this.eyes.enabled || !v?.videoWidth) return -1;
    const g = this.small.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, 64, 48);
    const px = g.getImageData(0, 0, 64, 48).data;
    const grey = new Uint8Array(64 * 48);
    for (let i = 0; i < grey.length; i++) grey[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
    let d = 0;
    if (this.prev) for (let i = 0; i < grey.length; i++) d += Math.abs(grey[i] - this.prev[i]);
    const first = !this.prev;
    this.prev = grey;
    return first ? 255 : d / grey.length;
  }

  async tick() {
    if (this.busy) return;
    const d = this._diff();
    if (d < 0) return;
    const now = Date.now();
    if (d > 14) { this.changedAt = now; return; }                  // still moving: wait until it settles
    const settledAfterChange = this.changedAt && now - this.changedAt > this.everyMs;
    if (!settledAfterChange || now - this.lastDescribe < this.describeGapMs || !this.canSpeak()) return;
    this.changedAt = 0; this.lastDescribe = now; this.busy = true;
    try {
      const frame = this.eyes.snapshot(384);
      const scene = (await this.eyes.describe(frame))?.trim();
      if (!scene || similar(scene, this.lastScene)) return;
      this.lastScene = scene;
      if (Date.now() - this.lastRemark < this.remarkGapMs || !this.canSpeak()) return;
      this.lastRemark = Date.now();
      const texty = TEXTY.test(scene);
      const s = scene.replace(/^(the image shows|this image shows|in this image,?|there is|i see)\s*/i, '').replace(/\.$/, '');
      const text = `I can see ${s.charAt(0).toLowerCase() + s.slice(1)}.` + (texty ? ' Want me to read or translate it?' : '');
      this.onRemark({ text, scene, texty, frame });
    } finally { this.busy = false; }
  }
}

// Word-overlap similarity so the same scene isn't announced twice.
function similar(a, b) {
  if (!b) return false;
  const w = (s) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) || []);
  const A = w(a), B = w(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.max(1, Math.min(A.size, B.size)) > 0.6;
}
