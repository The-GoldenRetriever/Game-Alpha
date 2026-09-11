// Keyboard + pointer-lock mouse. Mouse deltas accumulate and are drained by the
// renderer each frame so looking around never lags behind the display.
//
// Presses are latched as well as held: a trackpad tap can start and finish between
// two frames, so `consumeClick` remembers the press rather than asking whether the
// button happens to be down right now.
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
    this.sensitivity = 0.0022;
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
    overlay.addEventListener('mousedown', lock);
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
