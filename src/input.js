// Keyboard + pointer-lock mouse. Mouse deltas accumulate and are drained by the
// renderer each frame so looking around never lags behind the display.
//
// Look speed is `SENS_BASE` scaled by a user multiplier that survives a reload, so a
// sensitivity set once never has to be set again.
//
// Presses are latched as well as held: a trackpad tap can start and finish between
// two frames, so `consumeClick` remembers the press rather than asking whether the
// button happens to be down right now.

// Radians of yaw per pixel of mouse travel at a scale of 1.
const SENS_BASE = 0.0022;
const SENS_MIN = 0.15;
const SENS_MAX = 4;
const SENS_KEY = 'game-alpha.sensitivity';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Private mode and file:// URLs can both make storage throw rather than return null.
function loadScale() {
  try {
    const v = parseFloat(localStorage.getItem(SENS_KEY));
    return Number.isFinite(v) ? clamp(v, SENS_MIN, SENS_MAX) : 1;
  } catch { return 1; }
}

export class Input {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.down = new Set();
    this.tapped = new Set();
    this.buttons = new Set();
    this.clicked = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.sensScale = loadScale();
    this.sensitivity = SENS_BASE * this.sensScale;
    this.onSensitivity = null;    // set by the HUD so the slider and toast follow
    this.locked = false;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.tapped.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => { this.down.clear(); this.buttons.clear(); this.clicked.clear(); });

    const lock = () => {
      const req = canvas.requestPointerLock();
      if (req && req.catch) req.catch(() => {}); // browsers throttle re-locking after Esc
    };
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) { lock(); return; }
      this.buttons.add(e.button);
      this.clicked.add(e.button);
    });
    // Anything marked `data-nolock` — the settings panel — is a real control, so a
    // press there must not be swallowed as a request to start playing.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-nolock]')) return;
      lock();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      overlay.classList.toggle('hidden', this.locked);
      if (!this.locked) { this.down.clear(); this.buttons.clear(); this.clicked.clear(); }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX * this.sensitivity;
      this.mouseDY += e.movementY * this.sensitivity;
    });
  }

  // Sensitivity as a multiplier, so the UI never has to know about radians per pixel.
  setSensitivity(scale, silent = false) {
    this.sensScale = clamp(Number(scale) || 1, SENS_MIN, SENS_MAX);
    this.sensitivity = SENS_BASE * this.sensScale;
    try { localStorage.setItem(SENS_KEY, String(this.sensScale)); } catch { /* storage is optional */ }
    if (this.onSensitivity) this.onSensitivity(this.sensScale, silent);
    return this.sensScale;
  }

  get sensRange() { return { min: SENS_MIN, max: SENS_MAX }; }

  isDown(code) { return this.down.has(code); }
  mouseDown(button) { return this.locked && this.buttons.has(button); }

  // Edge-trigger for a mouse button, fired once per press.
  consumeClick(button) { return this.locked && this.clicked.delete(button); }
  anyDown(...codes) { return codes.some((c) => this.down.has(c)); }
  wasTapped(...codes) { return codes.some((c) => this.tapped.has(c)); }

  // Edge-trigger that fires exactly once, even across several fixed physics steps.
  consumeTap(...codes) {
    let hit = false;
    for (const c of codes) if (this.tapped.delete(c)) hit = true;
    return hit;
  }

  takeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  endFrame() { this.tapped.clear(); this.clicked.clear(); }
}
