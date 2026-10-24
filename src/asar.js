'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const BLOCK_SIZE = 4 * 1024 * 1024;
const MAX_HEADER = 64 * 1024 * 1024;

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('无效 ASAR header');
    const size = prefix.readUInt32LE(4);
    const payloadSize = prefix.readUInt32LE(8);
    const jsonSize = prefix.readUInt32LE(12);
    if (size < 8 || size > MAX_HEADER || payloadSize + 4 !== size || jsonSize > size - 8 || size + 8 > fs.fstatSync(fd).size) throw new Error('无效 ASAR header 长度');
    const json = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, json, 0, jsonSize, 16) !== jsonSize) throw new Error('不完整 ASAR header');
    const header = JSON.parse(json.toString('utf8'));
    if (!header.files) throw new Error('ASAR 缺少 files');
    return { header, dataOffset: 8 + size };
  } finally { fs.closeSync(fd); }
}
function parts(name) {
  if (typeof name !== 'string' || name.includes('\\') || name.startsWith('/') || name.split('/').some(x => !x || x === '.' || x === '..' || x === '__proto__' || x === 'constructor' || x === 'prototype')) throw new Error('无效 ASAR 路径');
  return name.split('/');
}
function getEntry(header, name) {
  let entry = header;
  for (const part of parts(name)) entry = entry && entry.files && Object.hasOwn(entry.files, part) ? entry.files[part] : undefined;
  return entry;
}
function readFile(file, name, maxSize = 16 * 1024 * 1024) {
  const { header, dataOffset } = readHeader(file);
  const entry = getEntry(header, name);
  if (!entry || entry.files || entry.link) throw new Error(`ASAR 文件不存在或不是普通文件: ${name}`);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxSize) throw new Error(`ASAR 文件超过读取限制: ${name}`);
  if (entry.unpacked) {
    const root = fs.realpathSync(file + '.unpacked');
    const target = fs.realpathSync(path.join(root, ...parts(name)));
    if (!target.startsWith(root + path.sep)) throw new Error('ASAR 外置文件越界');
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size !== entry.size || stat.size > maxSize) throw new Error('ASAR 外置文件大小不符');
    return fs.readFileSync(target);
  }
  const offset = Number(entry.offset);
  const fd = fs.openSync(file, 'r');
  try {
    if (!Number.isSafeInteger(offset) || offset < 0 || dataOffset + offset + entry.size > fs.fstatSync(fd).size) throw new Error('ASAR 文件偏移越界');
    const buffer = Buffer.alloc(entry.size);
    if (fs.readSync(fd, buffer, 0, buffer.length, dataOffset + offset) !== buffer.length) throw new Error('ASAR 文件读取不完整');
    return buffer;
  } finally { fs.closeSync(fd); }
}
function integrity(buffer, blockSize = BLOCK_SIZE) {
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += blockSize) blocks.push(hash(buffer.subarray(offset, offset + blockSize)));
  return { algorithm: 'SHA256', hash: hash(buffer), blockSize, blocks };
}
function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4;
  const buffer = Buffer.alloc(12 + payloadSize);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(4 + payloadSize, 4);
  buffer.writeUInt32LE(payloadSize, 8);
  buffer.writeUInt32LE(json.length, 12);
  json.copy(buffer, 16);
  return buffer;
}
// 保留原有文件 offset，复制原始数据区，仅在尾部追加替换文件，不解包资源。
async function appendFiles(file, replacements) {
  const { header, dataOffset } = readHeader(file);
  const stat = fs.statSync(file);
  let offset = stat.size - dataOffset;
  const buffers = [];
  for (const [name, contents] of Object.entries(replacements)) {
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const segments = parts(name);
    let parent = header;
    for (const part of segments.slice(0, -1)) {
      if (!Object.hasOwn(parent.files, part)) parent.files[part] = { files: {} };
      parent = parent.files[part];
      if (!parent.files || parent.link) throw new Error(`ASAR 父路径不是目录: ${name}`);
    }
    parent.files[segments.at(-1)] = { size: buffer.length, offset: String(offset), integrity: integrity(buffer) };
    buffers.push(buffer);
    offset += buffer.length;
  }
  const temp = file + '.mtool-' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, encodeHeader(header), { flag: 'wx', mode: stat.mode });
    if (stat.size > dataOffset) await pipeline(fs.createReadStream(file, { start: dataOffset }), fs.createWriteStream(temp, { flags: 'a' }));
    const fd = fs.openSync(temp, 'a');
    try { for (const buffer of buffers) fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { readHeader, getEntry, readFile, integrity, encodeHeader, appendFiles, BLOCK_SIZE };
