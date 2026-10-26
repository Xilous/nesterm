#!/usr/bin/env node

// Entry point of nesterm.exe: asks for a ROM, shows the controls, fits the grid to the window, then plays.
import { basename } from 'node:path';
import { GRID_SIZES, main, parseArgs } from '../src/terminal.mjs';
import { createKeyStream, openConsoleKeys, pickRomFile, waitForKeyPress } from '../src/windows.mjs';

const CONTROLS = `
  Controls
    Arrow keys or WASD   D-pad
    X                    A (jump)
    Z                    B (run / fire)
    Enter                Start
    Space or Shift       Select
    P                    Pause / resume
    Q                    Quit
`;

function write(text) {
  process.stdout.write(text);
}

function windowSize() {
  const [columns, rows] = process.stdout.getWindowSize?.() ?? [process.stdout.columns, process.stdout.rows];
  return { columns, rows };
}

function fittingSize() {
  const { columns, rows } = windowSize();
  return Object.keys(GRID_SIZES).find(size => columns >= GRID_SIZES[size].cols && rows >= GRID_SIZES[size].rows) ?? null;
}

/** Wait until the window can hold at least the small grid, since programs cannot resize Windows Terminal. */
async function waitForFit() {
  let size = fittingSize();
  if (size) return size;
  const { cols, rows } = GRID_SIZES['40x25'];
  write(`\n  The window is too small. Make it at least ${cols} x ${rows} characters (maximize it, or press Ctrl and minus).\n`);
  while (!(size = fittingSize())) await new Promise(resolve => setTimeout(resolve, 250));
  return size;
}

function waitForKey(keys) {
  if (keys) return waitForKeyPress(keys);
  return new Promise((resolve) => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      resolve();
    });
  });
}

async function launch(argv) {
  write('\x1b]0;NESTERM\x07');
  const keys = await openConsoleKeys();
  // A ROM dropped onto the exe arrives as the only argument; any arguments skip the dialog.
  const args = [...argv];
  if (args.length === 0) {
    write('  Choose an NES ROM in the window that opened...\n');
    const rom = await pickRomFile();
    if (rom === null) {
      write('  No ROM was chosen. Press any key to close.\n');
      await waitForKey(keys);
      return 0;
    }
    args.push(rom);
  }
  const { rom, help } = parseArgs(args);
  if (help) return main(args);

  write(`\x1b[2J\x1b[H\n  NESTERM  -  ${basename(rom)}\n${CONTROLS}`);
  const size = await waitForFit();
  write(`\n  Press any key to start.\n`);
  await waitForKey(keys);

  if (!args.includes('--size')) args.push('--size', size);
  if (!args.includes('--fps')) args.push('--fps', size === '64x30' ? '60' : '30');
  return main(args, keys ? { stdin: createKeyStream(keys) } : {});
}

async function run() {
  try {
    process.exitCode = await launch(process.argv.slice(2));
  } catch (error) {
    write(`\n  nesterm: ${error instanceof Error ? error.message : String(error)}\n  Press any key to close.\n`);
    process.exitCode = 1;
    await waitForKey(await openConsoleKeys().catch(() => null));
  }
  process.exit();
}

run();
