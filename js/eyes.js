// Eyes: camera + SmolVLM-256M captioner (for brains that cannot take images directly), captioning off-thread.
import { getMlWorker, progress } from './ml.js';

export class Eyes {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facing = 'user';
    this._enabled = true;
    this.ml = null;
    this.lite = false;
    this.captionerReady = false;
    this.canvas = document.createElement('canvas');
  }

  async open(facing = 'user') {
    this.facing = facing;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // lite (phones): smaller frames at a low frame rate. Plenty for snapshots, far less battery and heat.
      video: this.lite ? { facingMode: { ideal: facing }, width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 10, max: 12 } }
        : { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
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

  // SmolVLM runs in the shared ML worker: the main thread only sends the frame (data URL or Blob).
  async loadCaptioner(profile, onProgress = () => {}) {
    this.ml = getMlWorker();
    await this.ml.loadCaptioner({ device: profile && profile.webgpu ? 'webgpu' : 'wasm' }, progress(onProgress));
    onProgress(1, 'Vision model ready');
  }

  async describe(frame) {
    if (!this.ml || !frame) return '';
    return this.ml.caption(frame);
  }
}
