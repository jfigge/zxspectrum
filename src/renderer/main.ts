import { loadFile } from '../emu/files';
import { Spectrum } from '../emu/machine';
import { writeSna } from '../emu/snapshot/sna';
import { applySnapshot, captureSnapshot } from '../emu/snapshot/snapshot';
import { writeZ80 } from '../emu/snapshot/z80format';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../emu/ula';
import type { Command, ModelId, OpenedFile, Roms, Settings, SnapshotFormat, ZxApi } from '../shared/api';
import { AudioOutput } from './audio';
import { KeyboardInput } from './input';

declare global {
  interface Window {
    zx: ZxApi;
  }
}

const zx = window.zx;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const display = document.getElementById('display')!;
const overlay = document.getElementById('overlay')!;
const statusModel = document.getElementById('status-model')!;
const statusTape = document.getElementById('status-tape')!;
const statusMessage = document.getElementById('status-message')!;

/** Audio to keep queued when pacing off the audio clock. */
const AUDIO_TARGET_SECONDS = 0.06;
/** Upper bound on frames run per tick, so a stall can't snowball. */
const MAX_FRAMES_PER_TICK = 6;
/** Wall-clock budget per tick for extra frames while a tape loader is running. */
const ACCELERATE_MS = 12;

let roms: Roms;
let settings: Settings;
let machine: Spectrum;
let audio: AudioOutput | null = null;
let input: KeyboardInput;
let image: ImageData;
let paused = false;
let accelerating = false;
let snapshotName = 'snapshot';
let lastTick = performance.now();
let owedMs = 0;
let messageTimer = 0;

// Menu commands can arrive before initialisation completes.
let ready = false;
const pending: Command[] = [];
zx.onCommand((cmd) => (ready ? handleCommand(cmd) : pending.push(cmd)));

function showMessage(text: string, isError = false): void {
  statusMessage.textContent = text;
  statusMessage.classList.toggle('error', isError);
  clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => (statusMessage.textContent = ''), isError ? 8000 : 4000);
}

function showOverlay(text: string | null): void {
  overlay.hidden = text === null;
  overlay.textContent = text ?? '';
}

function createMachine(model: ModelId): void {
  const tape = machine?.tape.tape ?? null;
  machine = new Spectrum(model, roms, audio?.sampleRate ?? 48000);
  machine.fastLoad = settings.fastLoad;
  if (tape) machine.insertTape(tape);
  image = new ImageData(new Uint8ClampedArray(machine.framebuffer.buffer as ArrayBuffer), SCREEN_WIDTH, SCREEN_HEIGHT);
  input?.setKeyboard(machine.keyboard);
  audio?.flush();
  owedMs = 0;
  updateStatus();
}

function switchModel(model: ModelId): void {
  settings.model = model;
  void zx.setModel(model);
  createMachine(model);
}

function openFile(file: OpenedFile): void {
  try {
    const loaded = loadFile(file.name, file.data);
    snapshotName = file.name.replace(/\.[^.]+$/, '');
    if (loaded.kind === 'snapshot') {
      if (loaded.snapshot.model !== machine.model.id) switchModel(loaded.snapshot.model);
      applySnapshot(machine, loaded.snapshot);
      showMessage(`Loaded ${file.name}`);
    } else {
      machine.insertTape(loaded.tape);
      machine.autoLoad();
      showMessage(`Loading ${file.name}…`);
    }
    audio?.flush();
    paused = false;
    showOverlay(null);
  } catch (err) {
    showMessage(`${file.name}: ${(err as Error).message}`, true);
  }
}

async function saveSnapshot(format: SnapshotFormat): Promise<void> {
  const snap = captureSnapshot(machine);
  const data = format === 'z80' ? writeZ80(snap) : writeSna(snap);
  if (await zx.saveFile(`${snapshotName}.${format}`, data)) showMessage('Snapshot saved');
}

function handleCommand(cmd: Command): void {
  switch (cmd.type) {
    case 'open-file': openFile(cmd.file); break;
    case 'set-model': settings.model = cmd.model; createMachine(cmd.model); break;
    case 'reset': machine.reset(); audio?.flush(); break;
    case 'toggle-pause':
      paused = !paused;
      showOverlay(paused ? 'Paused' : null);
      audio?.flush();
      owedMs = 0;
      break;
    case 'save-snapshot': void saveSnapshot(cmd.format); break;
    case 'tape-toggle':
      if (!machine.tape.tape) showMessage('No tape inserted');
      else if (machine.tape.playing) machine.stopTape();
      else machine.playTape();
      break;
    case 'tape-rewind': machine.tape.rewind(); break;
    case 'tape-eject': machine.tape.eject(); break;
    case 'set-fast-load': settings.fastLoad = machine.fastLoad = cmd.enabled; break;
    case 'set-accelerate': settings.accelerateLoading = cmd.enabled; break;
  }
  updateStatus();
}

function updateStatus(): void {
  statusModel.textContent = machine.model.name;
  const tape = machine.tape.status();
  statusTape.textContent = tape
    ? `${tape.playing ? '▶' : '■'} ${tape.name} — ${tape.block}/${tape.blockCount} ${tape.description}${accelerating ? '  ⚡' : ''}`
    : '';
}

// ---- Main loop ----------------------------------------------------------------

function tick(): void {
  const now = performance.now();
  const elapsed = now - lastTick;
  lastTick = now;
  if (paused) return;

  const frameMs = (1000 * machine.model.frameLength) / machine.model.cpuHz;
  let frames = 0;
  if (audio?.running) {
    // Pace off the audio clock: keep a small amount of audio queued.
    const target = audio.sampleRate * AUDIO_TARGET_SECONDS;
    while (audio.buffered < target && frames < MAX_FRAMES_PER_TICK) {
      audio.push(machine.runFrame());
      frames++;
      framesRun++;
    }
  } else {
    owedMs += elapsed;
    while (owedMs >= frameMs && frames < MAX_FRAMES_PER_TICK) {
      machine.runFrame();
      owedMs -= frameMs;
      frames++;
      framesRun++;
    }
    if (frames === MAX_FRAMES_PER_TICK) owedMs = 0;
  }

  // While a tape loader is running, spend spare time running extra (silent) frames.
  accelerating = settings.accelerateLoading && machine.tape.playing && machine.loaderActive;
  if (accelerating) {
    const until = performance.now() + ACCELERATE_MS;
    while (performance.now() < until && machine.tape.playing && machine.loaderActive) machine.runFrame();
  }
}

function draw(): void {
  ctx.putImageData(image, 0, 0);
  requestAnimationFrame(draw);
}

// ---- Drag and drop -------------------------------------------------------------

function setupDragAndDrop(): void {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (depth++ === 0) display.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--depth === 0) display.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    display.classList.remove('dragging');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const path = zx.pathForFile(file);
    if (path) void zx.addRecent(path);
    openFile({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  });
}

async function init(): Promise<void> {
  try {
    [roms, settings] = await Promise.all([zx.getRoms(), zx.getSettings()]);
  } catch (err) {
    showOverlay((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return;
  }
  canvas.width = SCREEN_WIDTH;
  canvas.height = SCREEN_HEIGHT;
  audio = await AudioOutput.create();
  createMachine(settings.model);
  input = new KeyboardInput(machine.keyboard);
  input.attach(window);
  // Some platforms only start audio after a user gesture.
  const resume = () => audio?.resume();
  window.addEventListener('keydown', resume);
  window.addEventListener('mousedown', resume);
  setupDragAndDrop();

  ready = true;
  for (const cmd of pending.splice(0)) handleCommand(cmd);
  setInterval(tick, 4);
  setInterval(updateStatus, 250);
  requestAnimationFrame(draw);
}

// Introspection hook for automated testing and debugging from DevTools.
let framesRun = 0;
Object.defineProperty(window, 'zxDebug', {
  value: () => ({
    machine,
    framesRun,
    audio,
    paused,
    accelerating,
  }),
});

void init();
