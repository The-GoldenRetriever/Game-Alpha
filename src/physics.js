import * as THREE from 'three';

// Everything in the world is an axis-aligned box: { pos: Vector3 (center), half: Vector3 }.
// Static boxes never move. Dynamic bodies (crates, the player) are swept one axis at a
// time, which keeps resolution predictable and jitter-free.

const OVERLAP_EPS = 1e-4;
const MAX_PUSH_DEPTH = 4;

export function box(cx, cy, cz, hx, hy, hz) {
  return { pos: new THREE.Vector3(cx, cy, cz), half: new THREE.Vector3(hx, hy, hz) };
}

const lo = (b, a) => b.pos[a] - b.half[a];
const hi = (b, a) => b.pos[a] + b.half[a];

export function overlap(a, b) {
  return hi(a, 'x') - lo(b, 'x') > OVERLAP_EPS && hi(b, 'x') - lo(a, 'x') > OVERLAP_EPS &&
         hi(a, 'y') - lo(b, 'y') > OVERLAP_EPS && hi(b, 'y') - lo(a, 'y') > OVERLAP_EPS &&
         hi(a, 'z') - lo(b, 'z') > OVERLAP_EPS && hi(b, 'z') - lo(a, 'z') > OVERLAP_EPS;
}

// How deep `a` has driven into `b` along `axis` while travelling in `dir`.
function penetration(a, b, axis, dir) {
  return dir > 0 ? hi(a, axis) - lo(b, axis) : hi(b, axis) - lo(a, axis);
}

export function collidesAt(body, pos, half, world, ignore) {
  const probe = { pos, half };
  for (const s of world.statics) if (overlap(probe, s)) return true;
  for (const c of world.crates) if (c !== body && c !== ignore && overlap(probe, c)) return true;
  return false;
}

// Move `body` along one axis, resolving collisions. Crates in the way get pushed
// (recursively, so a crate can shove the crate behind it) and whatever distance they
// could not move is subtracted from the mover.
export function moveAxis(body, axis, amount, world, depth = 0) {
  const result = { moved: 0, blocked: false, pushed: false };
  if (amount === 0) return result;

  body.pos[axis] += amount;
  const dir = Math.sign(amount);
  let correction = 0;

  for (const s of world.statics) {
    if (!overlap(body, s)) continue;
    const p = penetration(body, s, axis, dir);
    if (p > correction) correction = p;
  }

  for (const c of world.crates) {
    if (c === body || !overlap(body, c)) continue;
    let p = penetration(body, c, axis, dir);
    if (p <= 0) continue;
    if (axis !== 'y' && depth < MAX_PUSH_DEPTH) {
      const sub = moveAxis(c, axis, p * dir, world, depth + 1);
      c.vel.x = 0; c.vel.z = 0; // crates are heavy: they stop the moment you stop shoving
      p -= Math.abs(sub.moved);
      result.pushed = true;
    }
    if (p > correction) correction = p;
  }

  if (correction > 0) {
    body.pos[axis] -= correction * dir;
    result.blocked = true;
  }
  result.moved = amount - correction * dir;
  return result;
}

export function makeCrate(cx, cy, cz, size) {
  const b = box(cx, cy, cz, size / 2, size / 2, size / 2);
  b.vel = new THREE.Vector3();
  b.grounded = false;
  b.size = size;
  b.spawn = b.pos.clone();
  return b;
}

export function stepCrate(crate, dt, world, gravity) {
  crate.vel.y -= gravity * dt;
  if (crate.vel.y < -60) crate.vel.y = -60;

  if (crate.vel.x !== 0) moveAxis(crate, 'x', crate.vel.x * dt, world);
  if (crate.vel.z !== 0) moveAxis(crate, 'z', crate.vel.z * dt, world);

  const vertical = moveAxis(crate, 'y', crate.vel.y * dt, world);
  crate.grounded = vertical.blocked && crate.vel.y < 0;
  if (vertical.blocked) crate.vel.y = 0;

  const damp = crate.grounded ? 12 : 0.4;
  const k = Math.exp(-damp * dt);
  crate.vel.x *= k;
  crate.vel.z *= k;
  if (Math.abs(crate.vel.x) < 0.01) crate.vel.x = 0;
  if (Math.abs(crate.vel.z) < 0.01) crate.vel.z = 0;
}

// Slab test, used to keep the third-person camera out of walls.
function rayBox(origin, dir, b, maxDist) {
  let tmin = 0, tmax = maxDist;
  for (const a of ['x', 'y', 'z']) {
    const d = dir[a];
    if (Math.abs(d) < 1e-8) {
      if (origin[a] < lo(b, a) || origin[a] > hi(b, a)) return null;
      continue;
    }
    let t1 = (lo(b, a) - origin[a]) / d;
    let t2 = (hi(b, a) - origin[a]) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

export function castRay(origin, dir, maxDist, world) {
  let nearest = maxDist;
  for (const s of world.statics) {
    const t = rayBox(origin, dir, s, maxDist);
    if (t !== null && t < nearest) nearest = t;
  }
  for (const c of world.crates) {
    const t = rayBox(origin, dir, c, maxDist);
    if (t !== null && t < nearest) nearest = t;
  }
  return nearest;
}
