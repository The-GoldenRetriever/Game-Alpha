import * as THREE from 'three';
import { Input } from './input.js';
import { buildWorld } from './world.js';
import { Player, TUNING } from './player.js';
import { stepCrate, castRay } from './physics.js';

const STEP = 1 / 120;        // fixed physics tick
const MAX_STEPS = 8;
const GRAVITY = TUNING.gravity;

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');
const hudSpeed = document.getElementById('speed');
const hudView = document.getElementById('view');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
camera.rotation.order = 'YXZ';

const world = buildWorld(scene);
const input = new Input(canvas, overlay);
const player = new Player(world, scene);

let thirdPerson = false;
let boom = 5.2;              // smoothed third-person camera distance
const BOOM_MAX = 5.2;
const head = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const lookDir = new THREE.Vector3();
const boomDir = new THREE.Vector3();

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

function fixedStep(dt) {
  player.update(dt, input);
  for (const crate of world.crates) {
    crate.prev.copy(crate.pos);
    stepCrate(crate, dt, world, GRAVITY);
  }
}

function updateCamera(dt, playerPos) {
  const T = TUNING;
  const targetView = player.sliding ? T.slideEyeHeight : T.eyeHeight;
  player.viewHeight += (targetView - player.viewHeight) * (1 - Math.exp(-16 * dt));

  head.set(playerPos.x, playerPos.y - player.half.y + player.viewHeight, playerPos.z);
  camera.rotation.set(player.pitch, player.yaw, 0);

  if (!thirdPerson) {
    camera.position.copy(head);
  } else {
    camera.getWorldDirection(lookDir);
    // Pull the boom in when something is between the player and the camera.
    boomDir.copy(lookDir).negate();
    const hit = castRay(head, boomDir, BOOM_MAX + 0.4, world) - 0.4;
    const wanted = Math.max(0.6, Math.min(BOOM_MAX, hit));
    // Snap in instantly, ease back out, so walls never clip through the view.
    boom = wanted < boom ? wanted : boom + (wanted - boom) * (1 - Math.exp(-8 * dt));
    camTarget.copy(head).addScaledVector(boomDir, boom);
    camTarget.y += 0.25;
    camera.position.copy(camTarget);
  }

  const over = THREE.MathUtils.clamp((player.speed - T.walkSpeed) / (T.slideMaxSpeed - T.walkSpeed), 0, 1);
  const targetFov = 75 + over * 10;
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-8 * dt));
  camera.updateProjectionMatrix();
}

let last = performance.now();
let accumulator = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  const mouse = input.takeMouse();
  if (mouse.x || mouse.y) player.look(mouse.x, mouse.y);

  if (input.consumeTap('KeyV')) thirdPerson = !thirdPerson;
  if (input.consumeTap('KeyR')) { player.respawn(); world.resetCrates(); }

  accumulator += dt;
  let steps = 0;
  while (accumulator >= STEP && steps < MAX_STEPS) {
    fixedStep(STEP);
    accumulator -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;

  const alpha = accumulator / STEP;
  const playerPos = player.render(alpha, thirdPerson);
  for (const crate of world.crates) crate.mesh.position.lerpVectors(crate.prev, crate.pos, alpha);

  updateCamera(dt, playerPos);
  renderer.render(scene, camera);

  hudSpeed.textContent = player.speed.toFixed(1);
  hudView.textContent = thirdPerson ? 'third' : 'first';
  input.endFrame();
}

requestAnimationFrame(frame);
