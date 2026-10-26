import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Windows console input mode flags.
const ENABLE_PROCESSED_INPUT = 0x0001; // keep Ctrl-C as SIGINT
const ENABLE_EXTENDED_FLAGS = 0x0080; // required to switch QuickEdit off
const KEY_EVENT = 0x0001;
const INPUT_RECORD_SIZE = 20;
const RECORDS_PER_READ = 64;

// Virtual-key codes the game uses, as the codepoints nesterm's Kitty decoder expects.
const CODEPOINT_BY_VK = new Map([
  [0x0d, 13], // Enter
  [0x20, 32], // Space
  [0x10, 57441], [0xa0, 57441], [0xa1, 57447], // Shift
]);
for (let vk = 0x41; vk <= 0x5a; vk += 1) CODEPOINT_BY_VK.set(vk, vk + 32); // A-Z as a-z

const ARROW_BY_VK = new Map([[0x26, 'A'], [0x28, 'B'], [0x27, 'C'], [0x25, 'D']]);

/** Encode one console key event as the Kitty sequence nesterm already decodes, or '' if unused. */
export function encodeKeyEvent({ vk, action }) {
  const type = action === 'release' ? 3 : action === 'repeat' ? 2 : 1;
  const arrow = ARROW_BY_VK.get(vk);
  if (arrow) return `\x1b[1;1:${type}${arrow}`;
  const codepoint = CODEPOINT_BY_VK.get(vk);
  return codepoint === undefined ? '' : `\x1b[${codepoint};1:${type}u`;
}

/**
 * Reads key presses and releases straight from the console input buffer. Node's TTY
 * drops key-up records, so without this held keys are guessed with a 120 ms timeout.
 * Returns null when the runtime has no FFI or stdin is not a console.
 */
export async function openConsoleKeys() {
  let ffi;
  try {
    ffi = await import('node:ffi');
  } catch {
    return null;
  }
  const { functions: k32 } = ffi.dlopen('kernel32.dll', {
    GetStdHandle: { arguments: ['int32'], return: 'pointer' },
    GetConsoleMode: { arguments: ['pointer', 'buffer'], return: 'int32' },
    SetConsoleMode: { arguments: ['pointer', 'uint32'], return: 'int32' },
    GetNumberOfConsoleInputEvents: { arguments: ['pointer', 'buffer'], return: 'int32' },
    ReadConsoleInputW: { arguments: ['pointer', 'buffer', 'uint32', 'buffer'], return: 'int32' },
  });
  const handle = k32.GetStdHandle(-10);
  const word = Buffer.alloc(4);
  if (!k32.GetConsoleMode(handle, word)) return null;
  const savedMode = word.readUInt32LE(0);
  const records = Buffer.alloc(INPUT_RECORD_SIZE * RECORDS_PER_READ);
  const held = new Set();

  return {
    start() {
      // No line editing or echo, and no QuickEdit: a click would otherwise freeze the output.
      k32.SetConsoleMode(handle, ENABLE_PROCESSED_INPUT | ENABLE_EXTENDED_FLAGS);
    },
    stop() {
      k32.SetConsoleMode(handle, savedMode);
      held.clear();
    },
    /** Drain pending console input and return [{ vk, action }] without blocking. */
    poll() {
      const events = [];
      while (k32.GetNumberOfConsoleInputEvents(handle, word) && word.readUInt32LE(0) > 0) {
        const wanted = Math.min(word.readUInt32LE(0), RECORDS_PER_READ);
        if (!k32.ReadConsoleInputW(handle, records, wanted, word)) break;
        const read = word.readUInt32LE(0);
        for (let index = 0; index < read; index += 1) {
          const offset = index * INPUT_RECORD_SIZE;
          if (records.readUInt16LE(offset) !== KEY_EVENT) continue;
          const down = records.readInt32LE(offset + 4) !== 0;
          const vk = records.readUInt16LE(offset + 10);
          if (!down) {
            held.delete(vk);
            events.push({ vk, action: 'release' });
          } else {
            events.push({ vk, action: held.has(vk) ? 'repeat' : 'press' });
            held.add(vk);
          }
        }
        if (read < wanted) break;
      }
      return events;
    },
  };
}

/** A stdin stand-in for runTerminal that emits console key events as Kitty sequences. */
export function createKeyStream(keys, intervalMs = 4) {
  const stream = new EventEmitter();
  let timer = null;
  stream.isTTY = false;
  stream.resume = () => {
    if (timer) return;
    keys.start();
    timer = setInterval(() => {
      const data = keys.poll().map(encodeKeyEvent).join('');
      if (data) stream.emit('data', data);
    }, intervalMs);
  };
  stream.pause = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    keys.stop();
  };
  return stream;
}

/** Resolve on the next key press (not a release or repeat). */
export function waitForKeyPress(keys) {
  keys.start();
  keys.poll();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const press = keys.poll().find(event => event.action === 'press');
      if (!press) return;
      clearInterval(timer);
      keys.stop();
      resolve(press.vk);
    }, 10);
  });
}

const PICK_ROM_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose an NES ROM to play'
$dialog.Filter = 'NES ROMs (*.nes, *.zip)|*.nes;*.zip|All files (*.*)|*.*'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }
`;

/** Show the standard Windows Open dialog; resolves to the chosen path or null. */
export function pickRomFile() {
  const encoded = Buffer.from(PICK_ROM_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
        if (error) reject(new Error(`could not open the file dialog: ${error.message}`));
        else resolve(stdout.trim() || null);
      });
  });
}
