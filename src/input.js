// Keyboard + pointer-lock mouse. Mouse deltas accumulate and are drained by the
// renderer each frame so looking around never lags behind the display.
export class Input {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.down = new Set();
    this.tapped = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.sensitivity = 0.0022;
    this.locked = false;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.tapped.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    const lock = () => {
      const req = canvas.requestPointerLock();
      if (req && req.catch) req.catch(() => {}); // browsers throttle re-locking after Esc
    };
    canvas.addEventListener('mousedown', () => { if (!this.locked) lock(); });
    overlay.addEventListener('mousedown', lock);

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      overlay.classList.toggle('hidden', this.locked);
      if (!this.locked) this.down.clear();
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX * this.sensitivity;
      this.mouseDY += e.movementY * this.sensitivity;
    });
  }

  isDown(code) { return this.down.has(code); }
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

  endFrame() { this.tapped.clear(); }
}
