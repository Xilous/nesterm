import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { parseInputSequences } from '../src/terminal.mjs';
import { encodeKeyEvent } from '../src/windows.mjs';
import { extractNesFromZip, readRom } from '../src/zip.mjs';

test('console key events decode as Kitty presses and releases', () => {
  const data = [
    { vk: 0x27, action: 'press' }, // Right
    { vk: 0x58, action: 'press' }, // X
    { vk: 0x58, action: 'repeat' },
    { vk: 0x58, action: 'release' },
    { vk: 0x27, action: 'release' },
    { vk: 0x0d, action: 'press' }, // Enter
    { vk: 0xa0, action: 'press' }, // left Shift
    { vk: 0x51, action: 'press' }, // Q
  ].map(encodeKeyEvent).join('');
  const { events, rest } = parseInputSequences(data);
  assert.equal(rest, '');
  assert.deepEqual(events.map(({ kind, name, action, extended }) => [kind, name, action, extended]), [
    ['key', 'right', 'press', true],
    ['key', 'a', 'press', true],
    ['key', 'a', 'repeat', true],
    ['key', 'a', 'release', true],
    ['key', 'right', 'release', true],
    ['key', 'start', 'press', true],
    ['key', 'select', 'press', true],
    ['control', 'quit', 'press', true],
  ]);
});

test('keys the game does not use encode to nothing', () => {
  assert.equal(encodeKeyEvent({ vk: 0x70, action: 'press' }), ''); // F1
  assert.equal(encodeKeyEvent({ vk: 0x31, action: 'press' }), ''); // 1
});

function zipOf(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of files) {
    const nameBytes = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const rom = Buffer.concat([Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1]), Buffer.alloc(10), Buffer.alloc(24576, 0xea)]);

test('the first .nes file is read from a stored or deflated ZIP', () => {
  for (const deflate of [false, true]) {
    const zip = zipOf([{ name: 'readme.txt', data: Buffer.from('hi') }, { name: 'Game (World).NES', data: rom, deflate }]);
    assert.deepEqual(Buffer.from(extractNesFromZip(zip)), rom);
  }
});

test('a ZIP without a ROM is rejected clearly', () => {
  assert.throws(() => extractNesFromZip(zipOf([{ name: 'readme.txt', data: Buffer.from('hi') }])), /does not contain a \.nes ROM/);
  assert.throws(() => extractNesFromZip(Buffer.from('PK\x03\x04 not really a zip')), /damaged/);
});

test('readRom accepts a plain .nes file or a .zip holding one', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nesterm-rom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'game.nes'), rom);
  await writeFile(join(directory, 'game.zip'), zipOf([{ name: 'game.nes', data: rom, deflate: true }]));
  assert.deepEqual(Buffer.from(await readRom(join(directory, 'game.nes'))), rom);
  assert.deepEqual(Buffer.from(await readRom(join(directory, 'game.zip'))), rom);
});
