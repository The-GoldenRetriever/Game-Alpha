import * as THREE from 'three';
import { Input } from './input.js';
import { buildWorld } from './world.js';
import { Player, TUNING } from './player.js';
import { stepCrate, castRay } from './physics.js';
import { createTargets } from './targets.js';
import { Effects } from './effects.js';
import { Weapon } from './weapon.js';

const STEP = 1 / 120;        // fixed physics tick
const MAX_STEPS = 8;
const GRAVITY = TUNING.gravity;

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');
const hudSpeed = document.getElementById('speed');
const hudView = document.getElementById('view');
const hudHits = document.getElementById('hits');
const crosshair = document.getElementById('crosshair');
const hitmarker = document.getElementById('hitmarker');
const chargeRing = document.getElementById('charge');
const chargeFill = chargeRing.querySelector('.fill');
const ammoBox = document.getElementById('ammo');
const ammoCount = document.getElementById('ammo-count');
const ammoPips = document.getElementById('ammo-pips');
const CHARGE_CIRCUMFERENCE = 2 * Math.PI * 27;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.autoClear = false;  // the first-person viewmodel is drawn as a second pass

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
camera.rotation.order = 'YXZ';

const world = buildWorld(scene);
renderer.setClearColor(world.sky);

// The viewmodel lives in its own scene, seen by a camera parked at the origin, so it
// can never clip into the level and keeps a tighter field of view than the world.
const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(66, 1, 0.01, 6);
viewScene.add(new THREE.HemisphereLight(0xc4dbff, 0x2a3138, 2.0));
const viewKey = new THREE.DirectionalLight(0xfff1dd, 2.4);
viewKey.position.set(-0.7, 1, 0.75);
viewScene.add(viewKey);

const input = new Input(canvas, overlay);
const player = new Player(world, scene);
const effects = new Effects(scene);

world.targets = createTargets(scene, world.spawn);
const weapon = new Weapon({ scene, viewScene, world, effects, character: player.character });

let thirdPerson = false;
let boom = 5.2;              // smoothed third-person camera distance
const BOOM_MAX = 5.2;
const head = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const lookDir = new THREE.Vector3();
const boomDir = new THREE.Vector3();
let camRoll = 0;

document.getElementById('ammo-max').textContent = weapon.magSize;
for (let i = 0; i < weapon.magSize; i++) ammoPips.appendChild(document.createElement('i'));
const pips = [...ammoPips.children];

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  viewCamera.aspect = w / h;
  viewCamera.updateProjectionMatrix();
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
  player.viewHeight += (player.eyeTarget - player.viewHeight) * (1 - Math.exp(-16 * dt));

  head.set(playerPos.x, playerPos.y - player.half.y + player.viewHeight, playerPos.z);

  // Bank the view with a slide, and lurch through the landing flip without putting
  // the player through a full 360 in first person.
  const flip = player.rolling ? Math.sin(player.rollT * Math.PI) : 0;
  const wantRoll = (player.sliding || player.diving ? -player.slideLean * 0.13 : 0)
                 - player.strafe * 0.018 + flip * 0.22 * player.slideLean;
  camRoll += (wantRoll - camRoll) * (1 - Math.exp(-9 * dt));

  camera.rotation.set(
    player.pitch + weapon.recoilPitch - flip * 0.35,
    player.yaw + weapon.recoilYaw,
    camRoll,
  );

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
  const targetFov = (75 + over * 10 + weapon.boost * 7) * (1 - weapon.ads * 0.22);
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-9 * dt));
  camera.updateProjectionMatrix();
}

// The crosshair opens up with the gun's spread, so it always shows real accuracy, and
// greys out while the shot is still on cooldown.
function updateCrosshair() {
  const px = Math.tan(weapon.baseSpread) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (innerHeight / 2);
  crosshair.style.setProperty('--gap', `${Math.max(3, px).toFixed(1)}px`);
  crosshair.classList.toggle('on-target', weapon.onTarget && !thirdPerson);
  crosshair.classList.toggle('cooling', weapon.cooldown > 0 || weapon.reloading > 0);
  hitmarker.style.opacity = weapon.hitFlash;
  hitmarker.style.transform = `translate(-50%, -50%) scale(${1.35 - weapon.hitFlash * 0.3})`;

  // Charge ring. It is only ever visible once the wind-up has started, which is well
  // after a normal shot has gone.
  const c = weapon.charge;
  chargeRing.style.opacity = c > 0 ? 1 : 0;
  chargeFill.style.strokeDashoffset = CHARGE_CIRCUMFERENCE * (1 - c);
  chargeRing.classList.toggle('full', c >= 1);
}

function updateAmmo() {
  const reloading = weapon.reloading > 0;
  ammoCount.textContent = reloading ? '--' : weapon.ammo;
  ammoBox.classList.toggle('reloading', reloading);
  ammoBox.classList.toggle('low', !reloading && weapon.ammo <= 3);
  // Mid-reload the pips fill back up in order, so the bar reads as the magazine.
  const filled = reloading ? Math.round(weapon.reloadProgress * weapon.magSize) : weapon.ammo;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('spent', i >= filled);
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
  if (input.consumeTap('Backspace')) {
    player.respawn();
    world.resetCrates();
    for (const t of world.targets) t.reset();
    weapon.ammo = weapon.magSize;
  }

  // Aiming slows the player down, so the weapon's aim weight drives movement too.
  player.aiming = weapon.ads;

  accumulator += dt;
  let steps = 0;
  while (accumulator >= STEP && steps < MAX_STEPS) {
    fixedStep(STEP);
    accumulator -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS) accumulator = 0;

  const alpha = accumulator / STEP;
  const playerPos = player.render(dt, alpha, thirdPerson, weapon);
  for (const crate of world.crates) crate.mesh.position.lerpVectors(crate.prev, crate.pos, alpha);
  for (const target of world.targets) target.update(dt);

  updateCamera(dt, playerPos);
  weapon.update(dt, { input, player, camera, eye: head, thirdPerson, mouseDelta: mouse });
  effects.update(dt);

  renderer.clear();
  renderer.render(scene, camera);
  if (!thirdPerson) {
    renderer.clearDepth();
    renderer.render(viewScene, viewCamera);
  }

  hudSpeed.textContent = player.speed.toFixed(1);
  hudView.textContent = thirdPerson ? 'third' : 'first';
  hudHits.textContent = weapon.shotsLanded;
  updateCrosshair();
  updateAmmo();
  input.endFrame();
}

requestAnimationFrame(frame);
