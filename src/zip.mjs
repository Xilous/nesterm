import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function findEndOfCentralDirectory(zip) {
  // The record is 22 bytes plus a comment of at most 65535 bytes, at the very end.
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('The ZIP file is damaged.');
}

/** Return the first .nes file inside a ZIP archive (stored or deflated). */
export function extractNesFromZip(zip) {
  const end = findEndOfCentralDirectory(zip);
  const entries = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_HEADER) throw new Error('The ZIP file is damaged.');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.nes$/i.test(name)) continue;

    if (flags & 1) throw new Error(`${name} is encrypted inside the ZIP file.`);
    if (zip.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error('The ZIP file is damaged.');
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(start, start + compressedSize);
    if (method === 0) return new Uint8Array(data);
    if (method === 8) return new Uint8Array(inflateRawSync(data));
    throw new Error(`${name} uses an unsupported ZIP compression method.`);
  }
  throw new Error('The ZIP file does not contain a .nes ROM.');
}

/** Read a ROM from a .nes file, or from the first .nes file inside a .zip. */
export async function readRom(path) {
  const bytes = await readFile(path);
  const isZip = bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER;
  return isZip ? extractNesFromZip(bytes) : new Uint8Array(bytes);
}
