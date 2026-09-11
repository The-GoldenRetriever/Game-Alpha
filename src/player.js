import * as THREE from 'three';
import { moveAxis, collidesAt } from './physics.js';
import { Character } from './character.js';

export const TUNING = {
  radius: 0.35,
  standHeight: 1.8,
  slideHeight: 0.9,
  eyeHeight: 1.62,
  slideEyeHeight: 0.62,

  gravity: 26,
  jumpVelocity: 8.4,        // ~1.35 m of hang
  maxFallSpeed: 55,

  walkSpeed: 6.4,
  groundAccel: 11,
  airAccel: 2.6,
  friction: 9,
  stopSpeed: 3,             // keeps low-speed stops crisp instead of sliding to a halt

  slideEntrySpeed: 3.2,     // need some momentum before a slide will start
  slideBoost: 1.55,         // multiplier applied on entry
  slideMaxSpeed: 13.5,
  slideFriction: 1.4,
  slideExitSpeed: 5.0,
  slideTurnRate: 2.3,       // rad/s you can steer the slide
  slideCooldown: 0.35,

  diveBoost: 1.3,           // sliding in the air throws you into a dive instead
  diveKick: 1.6,            // downward nudge so a dive actually commits
  diveTurnRate: 1.1,
  rollTime: 0.5,            // the front flip you land the dive with
  rollFriction: 1.7,
  rollTurnRate: 1.6,

  backSpeedScale: 0.72,     // backpedalling is slower than running forward
  adsSpeedScale: 0.45,      // and aiming down the sight slower still
  dashCeiling: 15,          // upward limit on a charged-shot dash
  dashTime: 0.42,           // window where a dash keeps its speed
  dashFriction: 0.1,

  coyoteTime: 0.12,
  jumpBuffer: 0.15,
};

const TAU = Math.PI * 2;
const V_WISH = new THREE.Vector3();
const V_PROBE = new THREE.Vector3();
const V_PROBE_HALF = new THREE.Vector3();
const V_RENDER = new THREE.Vector3();

const wrapPi = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};

export class Player {
  constructor(world, scene) {
    const T = TUNING;
    this.world = world;
    this.pos = world.spawn.clone();
    this.prev = this.pos.clone();
    this.half = new THREE.Vector3(T.radius, T.standHeight / 2, T.radius);
    this.vel = new THREE.Vector3();

    this.yaw = 0;            // looking down -Z, into the level
    this.pitch = 0;
    this.grounded = false;
    this.backAim = false;    // firing over the shoulder: the body turns, the view does not
    this.sliding = false;
    this.diving = false;     // airborne slide
    this.rolling = false;    // the landing flip
    this.height = T.standHeight;
    this.viewHeight = T.eyeHeight;

    this.coyote = 0;
    this.buffer = 0;
    this.cooldown = 0;
    this.slideWasHeld = false;

    // Animation-facing state.
    this.bodyYaw = 0;
    this.bodyPitch = 0;      // raw dive pitch / flip rotation, never smoothed twice
    this.slideLean = 1;
    this.rollT = 0;
    this.flipFrom = 0;
    this.landing = 0;
    this.stateT = 0;
    this.lastMode = 'idle';
    this.lastYaw = 0;
    this.turnRate = 0;
    this.strafe = 0;
    this.aiming = 0;         // the weapon's smoothed ADS weight, set from outside
    this.moveF = 0;          // travel direction in body space, for the leg cycle
    this.moveR = 0;
    this.dashTimer = 0;

    this.character = new Character();
    this.mesh = this.character.root;
    scene.add(this.mesh);
  }

  get feetY() { return this.pos.y - this.half.y; }
  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get lowProfile() { return this.sliding || this.diving || this.rolling; }

  get mode() {
    if (this.rolling) return 'roll';
    if (this.diving) return 'dive';
    if (this.sliding) return 'slide';
    if (!this.grounded) return 'air';
    return this.speed > 0.7 ? 'move' : 'idle';
  }

  get eyeTarget() {
    const T = TUNING;
    if (this.rolling) return T.slideEyeHeight * 0.75;
    if (this.diving || this.sliding) return T.slideEyeHeight;
    return T.eyeHeight;
  }

  look(dx, dy) {
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    this.yaw = wrapPi(this.yaw);
  }

  respawn() {
    this.pos.copy(this.world.spawn);
    this.prev.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.#setHeight(TUNING.standHeight);
    this.sliding = this.diving = this.rolling = false;
    this.bodyPitch = 0;
    this.landing = 0;
    this.cooldown = 0;
  }

  #setHeight(h) {
    this.pos.y += (h - this.height) / 2;   // grows and shrinks about the feet
    this.height = h;
    this.half.y = h / 2;
  }

  #canStand() {
    const h = TUNING.standHeight;
    V_PROBE.set(this.pos.x, this.pos.y + (h - this.height) / 2, this.pos.z);
    V_PROBE_HALF.set(this.half.x, h / 2, this.half.z);
    return !collidesAt(this, V_PROBE, V_PROBE_HALF, this.world);
  }

  // Public so a recoil launch can pop you out of a slide as it throws you.
  standUp(cooldown = TUNING.slideCooldown) { return this.#standUp(cooldown); }

  // A charged shot throws the player the opposite way. Horizontal impulses stack onto
  // whatever speed is already there; upward ones are capped so they cannot be chained
  // into orbit. The dash window afterwards holds the speed instead of scrubbing it.
  dash(vx, vy, vz) {
    const T = TUNING;
    this.vel.x += vx;
    this.vel.z += vz;
    if (vy > 0) this.vel.y = Math.min(Math.max(this.vel.y, -3) + vy, T.dashCeiling);
    else this.vel.y = Math.max(this.vel.y + vy, -T.maxFallSpeed);
    this.grounded = false;
    this.coyote = 0;
    this.dashTimer = T.dashTime;
    if (this.lowProfile) this.#standUp(0);
  }

  #standUp(cooldown = TUNING.slideCooldown) {
    if (!this.#canStand()) return false;
    this.sliding = this.diving = this.rolling = false;
    this.#setHeight(TUNING.standHeight);
    this.cooldown = cooldown;
    return true;
  }

  // Quake-style acceleration: only adds speed along the wish direction up to a cap,
  // so momentum built up by sliding survives instead of being clamped away.
  #accelerate(wish, wishSpeed, accel, dt) {
    const current = this.vel.x * wish.x + this.vel.z * wish.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const a = Math.min(accel * wishSpeed * dt, add);
    this.vel.x += wish.x * a;
    this.vel.z += wish.z * a;
  }

  #applyFriction(dt, friction) {
    const speed = this.speed;
    if (speed < 1e-4) { this.vel.x = 0; this.vel.z = 0; return; }
    const drop = Math.max(speed, TUNING.stopSpeed) * friction * dt;
    const scale = Math.max(speed - drop, 0) / speed;
    this.vel.x *= scale;
    this.vel.z *= scale;
  }

  // Rotate existing momentum toward the wish direction instead of adding to it.
  #steer(wish, rate, dt) {
    const s = this.speed;
    if (s < 0.1) return;
    const cur = Math.atan2(this.vel.z, this.vel.x);
    const diff = wrapPi(Math.atan2(wish.z, wish.x) - cur);
    const a = cur + THREE.MathUtils.clamp(diff, -rate * dt, rate * dt);
    this.vel.x = Math.cos(a) * s;
    this.vel.z = Math.sin(a) * s;
  }

  update(dt, input) {
    const T = TUNING;
    this.prev.copy(this.pos);
    const wasGrounded = this.grounded;

    // --- wish direction, relative to where we are looking --------------------
    const f = input.anyDown('KeyW', 'ArrowUp') - input.anyDown('KeyS', 'ArrowDown');
    const r = input.anyDown('KeyD', 'ArrowRight') - input.anyDown('KeyA', 'ArrowLeft');
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wish = V_WISH.set(-sin * f + cos * r, 0, -cos * f - sin * r);
    const wishing = wish.lengthSq() > 0;
    if (wishing) wish.normalize();
    this.strafe = r;

    // Aiming and backpedalling both slow you down. Acceleration is scaled back up by
    // the same amount: otherwise a low top speed leaves ground friction — which has a
    // floor of `stopSpeed` — strong enough to cancel the acceleration entirely.
    let wishSpeed = T.walkSpeed;
    if (f < 0) wishSpeed *= T.backSpeedScale;
    wishSpeed *= 1 - this.aiming * (1 - T.adsSpeedScale);
    const accelScale = T.walkSpeed / wishSpeed;

    // --- timers ---------------------------------------------------------------
    this.coyote = this.grounded ? T.coyoteTime : Math.max(0, this.coyote - dt);
    this.buffer = input.consumeTap('Space') ? T.jumpBuffer : Math.max(0, this.buffer - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.landing = Math.max(0, this.landing - dt * 4.2);
    this.dashTimer = Math.max(0, this.dashTimer - dt);

    // --- slide / dive ----------------------------------------------------------
    const slideHeld = input.anyDown('ShiftLeft', 'ShiftRight', 'ControlLeft', 'KeyC');
    // Entry is edge-triggered, so holding the key down does not chain slide after
    // slide into a permanent sprint.
    const slideTapped = slideHeld && !this.slideWasHeld;
    this.slideWasHeld = slideHeld;

    if (!this.sliding && !this.rolling && slideTapped && this.cooldown === 0 && this.speed > T.slideEntrySpeed) {
      this.sliding = true;
      this.diving = !this.grounded;      // in the air it becomes a dive instead
      this.#setHeight(T.slideHeight);
      // Bank onto the side you are leaning toward, alternating if you are not.
      this.slideLean = r !== 0 ? Math.sign(r) : -this.slideLean;
      const s = this.speed;
      const boosted = Math.min(s * (this.diving ? T.diveBoost : T.slideBoost), T.slideMaxSpeed);
      this.vel.x = (this.vel.x / s) * boosted;
      this.vel.z = (this.vel.z / s) * boosted;
      if (this.diving) this.vel.y = this.vel.y * 0.3 - T.diveKick;
    } else if (this.sliding && !this.diving) {
      // A dive is deliberately not cancellable: once you commit in the air you are
      // riding it out through the landing flip.
      const tooSlow = this.grounded && this.speed < T.slideExitSpeed;
      if (!slideHeld || tooSlow) this.#standUp();
    }

    // --- the landing flip ------------------------------------------------------
    if (this.rolling) {
      this.rollT = Math.min(1, this.rollT + dt / T.rollTime);
      const e = 1 - (1 - this.rollT) * (1 - this.rollT);      // fast out of the dive, easing in to land
      this.bodyPitch = this.flipFrom + (-TAU - this.flipFrom) * e;
      if (this.rollT >= 1) {
        this.bodyPitch = 0;                                    // -2π and 0 are the same pose
        this.rolling = false;
        // Still holding slide with speed to spare? Carry straight into a slide.
        if (slideHeld && this.grounded && this.speed > T.slideExitSpeed) {
          this.sliding = true;
          this.stateT = 0;
        } else if (!this.#standUp(T.slideCooldown * 0.5)) {
          this.sliding = true;                                 // no headroom: stay low
        }
      }
    } else {
      const target = this.diving ? -1.35 : 0;
      this.bodyPitch += (target - this.bodyPitch) * (1 - Math.exp(-11 * dt));
    }

    // --- horizontal movement --------------------------------------------------
    if (this.rolling) {
      if (this.grounded) this.#applyFriction(dt, T.rollFriction);
      if (wishing) this.#steer(wish, T.rollTurnRate, dt);
    } else if (this.diving) {
      if (wishing) this.#steer(wish, T.diveTurnRate, dt);
    } else if (this.sliding) {
      if (this.grounded) this.#applyFriction(dt, T.slideFriction);
      if (wishing) {
        this.#steer(wish, T.slideTurnRate, dt);
        if (!this.grounded) this.#accelerate(wish, T.walkSpeed, T.airAccel, dt);
      }
    } else if (this.grounded) {
      this.#applyFriction(dt, this.dashTimer > 0 ? T.friction * T.dashFriction : T.friction);
      if (wishing) this.#accelerate(wish, wishSpeed, T.groundAccel * accelScale, dt);
    } else if (wishing) {
      this.#accelerate(wish, wishSpeed, T.airAccel * accelScale, dt);
    }

    // --- jump ------------------------------------------------------------------
    if (this.buffer > 0 && (this.grounded || this.coyote > 0)) {
      this.vel.y = T.jumpVelocity;
      this.grounded = false;
      this.coyote = 0;
      this.buffer = 0;
      // Jumping out of a slide or a roll keeps the speed you earned.
      if (this.lowProfile) { this.rolling = false; this.#standUp(); }
    }

    // --- gravity + integration --------------------------------------------------
    this.vel.y = Math.max(this.vel.y - T.gravity * dt, -T.maxFallSpeed);

    const hitX = moveAxis(this, 'x', this.vel.x * dt, this.world);
    if (hitX.blocked && !hitX.pushed) this.vel.x = 0;
    if (hitX.pushed) this.vel.x *= 0.5;

    const hitZ = moveAxis(this, 'z', this.vel.z * dt, this.world);
    if (hitZ.blocked && !hitZ.pushed) this.vel.z = 0;
    if (hitZ.pushed) this.vel.z *= 0.5;

    const impactVy = this.vel.y;
    const hitY = moveAxis(this, 'y', this.vel.y * dt, this.world);
    this.grounded = hitY.blocked && this.vel.y <= 0;
    if (hitY.blocked) this.vel.y = 0;

    // --- touchdown ---------------------------------------------------------------
    if (this.grounded && !wasGrounded) {
      if (this.diving) {
        this.diving = false;
        this.sliding = false;
        this.rolling = true;
        this.rollT = 0;
        this.flipFrom = this.bodyPitch;
        this.stateT = 0;
      } else {
        this.landing = THREE.MathUtils.clamp(-impactVy / 15, 0.12, 1);
      }
    }

    // --- stand back up as soon as there is room ---------------------------------
    if (!this.lowProfile && this.height !== T.standHeight && this.#canStand()) this.#setHeight(T.standHeight);

    if (this.pos.y < -25) this.respawn();

    const mode = this.mode;
    if (mode !== this.lastMode) { this.lastMode = mode; this.stateT = 0; }
    this.stateT += dt;
  }

  // The body faces wherever the gun is pointed, so strafing and backpedalling read as
  // sidesteps rather than the character turning away from its aim. Slides and dives
  // are the exception: those line up with travel, which is the whole look of them.
  #updateBodyYaw(dt) {
    // Reverse aim spins the body a full half-turn while the camera keeps looking
    // where it was: the character is genuinely shooting behind itself.
    let target = this.backAim ? this.yaw + Math.PI : this.yaw;
    let rate = this.backAim ? 13 : 16;
    if (this.lowProfile && this.speed > 0.9) {
      target = Math.atan2(-this.vel.x, -this.vel.z);
      rate = 8;
    }
    this.bodyYaw += wrapPi(target - this.bodyYaw) * (1 - Math.exp(-rate * dt));
    this.bodyYaw = wrapPi(this.bodyYaw);

    // Travel direction in body space: +F is forward, +R is to the character's right.
    const sin = Math.sin(this.bodyYaw), cos = Math.cos(this.bodyYaw);
    const sp = this.speed;
    if (sp > 0.2) {
      this.moveF = (this.vel.x * -sin + this.vel.z * -cos) / sp;
      this.moveR = (this.vel.x * cos + this.vel.z * -sin) / sp;
    } else {
      this.moveF += (0 - this.moveF) * (1 - Math.exp(-8 * dt));
      this.moveR += (0 - this.moveR) * (1 - Math.exp(-8 * dt));
    }
  }

  // Called once per rendered frame; `alpha` blends the last two fixed steps.
  render(dt, alpha, thirdPerson, weapon) {
    const p = V_RENDER.copy(this.prev).lerp(this.pos, alpha);

    this.#updateBodyYaw(dt);
    const dy = wrapPi(this.yaw - this.lastYaw);
    this.lastYaw = this.yaw;
    this.turnRate += (THREE.MathUtils.clamp(dy / Math.max(dt, 1e-4) / 7, -1, 1) - this.turnRate)
                   * (1 - Math.exp(-9 * dt));

    this.character.setVisibleToCamera(thirdPerson);
    this.character.update(dt, {
      x: p.x,
      z: p.z,
      feetY: p.y - this.half.y,
      bodyYaw: this.bodyYaw,
      // The backward shot line is the view mirrored, so the gun tips the other way.
      aimPitch: this.backAim && !this.lowProfile ? -this.pitch : this.pitch,
      flip: this.bodyPitch,
      mode: this.mode,
      stateT: this.rolling ? this.rollT : this.stateT,
      speed: this.speed,
      velY: this.vel.y,
      grounded: this.grounded,
      slideLean: this.slideLean,
      landing: this.landing,
      strafe: this.strafe,
      turn: this.turnRate,
      moveF: this.moveF,
      moveR: this.moveR,
      aiming: weapon ? weapon.ads : 0,
      fire: weapon ? Math.min(1, weapon.recoil * 2) : 0,
      fireHold: weapon ? weapon.fireHold : 0,
      recoil: weapon ? weapon.recoil : 0,
      charge: weapon ? weapon.charge : 0,
      reload: weapon && weapon.reloading > 0 ? weapon.reloadProgress : -1,
    });

    return p;
  }
}
