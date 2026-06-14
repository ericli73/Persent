// Compresses embedded textures inside GLB files using sharp.
// Textures are resized to max 512px on longest side and re-encoded as JPEG 75%.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

const MODELS_DIR = './public/models';
const MAX_DIM = 512;
const JPEG_QUALITY = 78;

function readGlb(path) {
  const buf = readFileSync(path);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546C67) throw new Error('Not a GLB file');
  const totalLength = buf.readUInt32LE(8);

  let offset = 12;
  let jsonChunk, binChunk;

  while (offset < totalLength) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const data = buf.slice(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4E4F534A) jsonChunk = { offset: offset + 8, length: chunkLength, data };
    if (chunkType === 0x004E4942) binChunk = { offset: offset + 8, length: chunkLength, data };
    offset += 8 + chunkLength;
  }

  return { buf, jsonChunk, binChunk };
}

async function compressGlb(filePath) {
  const { buf, jsonChunk, binChunk } = readGlb(filePath);
  if (!binChunk) return false;

  const gltf = JSON.parse(jsonChunk.data.toString('utf8'));
  const images = gltf.images || [];
  const bufferViews = gltf.bufferViews || [];

  if (images.length === 0) return false;

  const binData = Buffer.from(binChunk.data);
  let changed = false;
  const replacements = [];

  for (const img of images) {
    if (img.bufferView === undefined) continue;
    const bv = bufferViews[img.bufferView];
    const byteOffset = bv.byteOffset || 0;
    const byteLength = bv.byteLength;
    const imgBuf = binData.slice(byteOffset, byteOffset + byteLength);

    let sharpImg;
    try { sharpImg = sharp(imgBuf); } catch { continue; }

    const meta = await sharpImg.metadata();
    const w = meta.width, h = meta.height;
    if (!w || !h) continue;

    // Skip tiny textures
    if (w <= MAX_DIM && h <= MAX_DIM && meta.format === 'jpeg') continue;

    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const newW = Math.round(w * scale);
    const newH = Math.round(h * scale);

    const compressed = await sharpImg
      .resize(newW, newH, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    replacements.push({ bufferViewIndex: img.bufferView, newBuf: compressed, oldOffset: byteOffset, oldLength: byteLength });
    img.mimeType = 'image/jpeg';
    changed = true;
  }

  if (!changed) return false;

  // Rebuild binary chunk with replaced textures
  // Strategy: rebuild the entire binary blob, remapping all bufferView offsets
  const sortedBvs = bufferViews
    .map((bv, i) => ({ ...bv, index: i }))
    .sort((a, b) => (a.byteOffset || 0) - (b.byteOffset || 0));

  const newBufs = [];
  let cursor = 0;
  const newOffsets = new Array(bufferViews.length);

  for (const bv of sortedBvs) {
    const byteOffset = bv.byteOffset || 0;
    const replacement = replacements.find(r => r.bufferViewIndex === bv.index);
    const srcBuf = replacement ? replacement.newBuf : binData.slice(byteOffset, byteOffset + bv.byteLength);
    // Align to 4 bytes
    const aligned = Math.ceil(cursor / 4) * 4;
    if (aligned > cursor) { newBufs.push(Buffer.alloc(aligned - cursor)); cursor = aligned; }
    newOffsets[bv.index] = cursor;
    newBufs.push(srcBuf);
    cursor += srcBuf.length;
  }

  // Align total to 4 bytes
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { newBufs.push(Buffer.alloc(pad, 0x20)); cursor += pad; }

  const newBinData = Buffer.concat(newBufs);

  // Update bufferViews with new offsets and lengths
  for (const bv of sortedBvs) {
    bufferViews[bv.index].byteOffset = newOffsets[bv.index];
    const replacement = replacements.find(r => r.bufferViewIndex === bv.index);
    if (replacement) bufferViews[bv.index].byteLength = replacement.newBuf.length;
  }

  // Update buffer total size
  if (gltf.buffers && gltf.buffers[0]) gltf.buffers[0].byteLength = newBinData.length;

  // Rebuild GLB
  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

  const totalLen = 12 + 8 + jsonPadded.length + 8 + newBinData.length;
  const out = Buffer.alloc(totalLen);
  let off = 0;

  // GLB header
  out.writeUInt32LE(0x46546C67, off); off += 4;
  out.writeUInt32LE(2, off); off += 4;
  out.writeUInt32LE(totalLen, off); off += 4;

  // JSON chunk
  out.writeUInt32LE(jsonPadded.length, off); off += 4;
  out.writeUInt32LE(0x4E4F534A, off); off += 4;
  jsonPadded.copy(out, off); off += jsonPadded.length;

  // BIN chunk
  out.writeUInt32LE(newBinData.length, off); off += 4;
  out.writeUInt32LE(0x004E4942, off); off += 4;
  newBinData.copy(out, off);

  writeFileSync(filePath, out);
  return true;
}

const files = readdirSync(MODELS_DIR).filter(f => f.endsWith('.glb'));

for (const file of files) {
  const filePath = join(MODELS_DIR, file);
  const before = statSync(filePath).size;
  try {
    const changed = await compressGlb(filePath);
    if (changed) {
      const after = statSync(filePath).size;
      console.log(`${file}: ${(before/1024/1024).toFixed(1)}MB -> ${(after/1024/1024).toFixed(1)}MB`);
    } else {
      console.log(`${file}: skipped (no embedded textures or already optimal)`);
    }
  } catch (e) {
    console.error(`${file}: ERROR - ${e.message}`);
  }
}
