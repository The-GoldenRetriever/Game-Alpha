import * as THREE from 'three';
import { moveAxis, collidesAt } from './physics.js';

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
  slideBoost: 1.55,          // multiplier applied on entry
  slideMaxSpeed: 13.5,
  slideFriction: 1.4,
  slideExitSpeed: 5.0,
  slideTurnRate: 2.3,       // rad/s you can steer the slide
  slideCooldown: 0.35,

  coyoteTime: 0.12,
  jumpBuffer: 0.15,
};

const V_WISH = new THREE.Vector3();
const V_PROBE = new THREE.Vector3();
const V_PROBE_HALF = new THREE.Vector3();
const V_RENDER = new THREE.Vector3();

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
    this.sliding = false;
    this.height = T.standHeight;
    this.viewHeight = T.eyeHeight;

    this.coyote = 0;
    this.buffer = 0;
    this.cooldown = 0;
    this.slideWasHeld = false;

    this.mesh = this.#buildMesh();
    scene.add(this.mesh);
  }

  #buildMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(TUNING.radius, TUNING.standHeight - TUNING.radius * 2, 6, 14),
      new THREE.MeshStandardMaterial({ color: 0xe4e9ee, roughness: 0.55, metalness: 0.1 })
    );
    body.castShadow = true;
    g.add(body);
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.16, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x4fa39d, emissive: 0x123a38, roughness: 0.4 })
    );
    visor.position.set(0, TUNING.standHeight / 2 - 0.42, -TUNING.radius);
    visor.castShadow = true;
    g.add(visor);
    return g;
  }

  get feetY() { return this.pos.y - this.half.y; }
  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  look(dx, dy) {
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  respawn() {
    this.pos.copy(this.world.spawn);
    this.prev.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.#setHeight(TUNING.standHeight);
    this.sliding = false;
  }

  #setHeight(h) {
    this.pos.y += (h - this.height) / 2;
    this.height = h;
    this.half.y = h / 2;
  }

  #canStand() {
    const h = TUNING.standHeight;
    V_PROBE.set(this.pos.x, this.pos.y + (h - this.height) / 2, this.pos.z);
    V_PROBE_HALF.set(this.half.x, h / 2, this.half.z);
    return !collidesAt(this, V_PROBE, V_PROBE_HALF, this.world);
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

  update(dt, input) {
    const T = TUNING;
    this.prev.copy(this.pos);

    // --- wish direction, relative to where we are looking --------------------
    const f = input.anyDown('KeyW', 'ArrowUp') - input.anyDown('KeyS', 'ArrowDown');
    const r = input.anyDown('KeyD', 'ArrowRight') - input.anyDown('KeyA', 'ArrowLeft');
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wish = V_WISH.set(-sin * f + cos * r, 0, -cos * f - sin * r);
    const wishing = wish.lengthSq() > 0;
    if (wishing) wish.normalize();

    // --- timers ---------------------------------------------------------------
    this.coyote = this.grounded ? T.coyoteTime : Math.max(0, this.coyote - dt);
    this.buffer = input.consumeTap('Space') ? T.jumpBuffer : Math.max(0, this.buffer - dt);
    this.cooldown = Math.max(0, this.cooldown - dt);

    // --- slide ----------------------------------------------------------------
    const slideHeld = input.anyDown('ShiftLeft', 'ShiftRight', 'ControlLeft', 'KeyC');
    // Entry is edge-triggered, so holding the key down does not chain slide after
    // slide into a permanent sprint.
    const slideTapped = slideHeld && !this.slideWasHeld;
    this.slideWasHeld = slideHeld;
    if (!this.sliding && slideTapped && this.grounded && this.cooldown === 0 && this.speed > T.slideEntrySpeed) {
      this.sliding = true;
      this.#setHeight(T.slideHeight);
      const boosted = Math.min(this.speed * T.slideBoost, T.slideMaxSpeed);
      const s = this.speed;
      this.vel.x = (this.vel.x / s) * boosted;
      this.vel.z = (this.vel.z / s) * boosted;
    } else if (this.sliding) {
      const tooSlow = this.grounded && this.speed < T.slideExitSpeed;
      if ((!slideHeld || tooSlow) && this.#canStand()) {
        this.sliding = false;
        this.#setHeight(T.standHeight);
        this.cooldown = T.slideCooldown;
      }
    }

    // --- horizontal movement --------------------------------------------------
    if (this.sliding) {
      if (this.grounded) this.#applyFriction(dt, T.slideFriction);
      if (wishing) {
        // Steering during a slide rotates momentum instead of adding to it.
        const s = this.speed;
        if (s > 0.1) {
          const cur = Math.atan2(this.vel.z, this.vel.x);
          let diff = Math.atan2(wish.z, wish.x) - cur;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const turn = THREE.MathUtils.clamp(diff, -T.slideTurnRate * dt, T.slideTurnRate * dt);
          const a = cur + turn;
          this.vel.x = Math.cos(a) * s;
          this.vel.z = Math.sin(a) * s;
        }
        if (!this.grounded) this.#accelerate(wish, T.walkSpeed, T.airAccel, dt);
      }
    } else if (this.grounded) {
      this.#applyFriction(dt, T.friction);
      if (wishing) this.#accelerate(wish, T.walkSpeed, T.groundAccel, dt);
    } else if (wishing) {
      this.#accelerate(wish, T.walkSpeed, T.airAccel, dt);
    }

    // --- jump ------------------------------------------------------------------
    if (this.buffer > 0 && (this.grounded || this.coyote > 0)) {
      this.vel.y = T.jumpVelocity;
      this.grounded = false;
      this.coyote = 0;
      this.buffer = 0;
      // Jumping out of a slide keeps the speed you earned.
      if (this.sliding && this.#canStand()) {
        this.sliding = false;
        this.#setHeight(T.standHeight);
        this.cooldown = T.slideCooldown;
      }
    }

    // --- gravity + integration --------------------------------------------------
    this.vel.y = Math.max(this.vel.y - T.gravity * dt, -T.maxFallSpeed);

    const hitX = moveAxis(this, 'x', this.vel.x * dt, this.world);
    if (hitX.blocked && !hitX.pushed) this.vel.x = 0;
    if (hitX.pushed) this.vel.x *= 0.5;

    const hitZ = moveAxis(this, 'z', this.vel.z * dt, this.world);
    if (hitZ.blocked && !hitZ.pushed) this.vel.z = 0;
    if (hitZ.pushed) this.vel.z *= 0.5;

    const hitY = moveAxis(this, 'y', this.vel.y * dt, this.world);
    this.grounded = hitY.blocked && this.vel.y <= 0;
    if (hitY.blocked) this.vel.y = 0;

    // --- stand back up as soon as there is room ---------------------------------
    if (!this.sliding && this.height !== T.standHeight && this.#canStand()) this.#setHeight(T.standHeight);

    if (this.pos.y < -25) this.respawn();
  }

  // Called once per rendered frame; `alpha` blends the last two fixed steps.
  render(alpha, thirdPerson) {
    const p = V_RENDER.copy(this.prev).lerp(this.pos, alpha);
    this.mesh.visible = thirdPerson;
    if (thirdPerson) {
      const squash = this.height / TUNING.standHeight;
      this.mesh.position.set(p.x, p.y - this.half.y + (TUNING.standHeight / 2) * squash, p.z);
      this.mesh.scale.set(1, squash, 1);
      this.mesh.rotation.y = this.yaw;
    }
    return p;
  }
}
