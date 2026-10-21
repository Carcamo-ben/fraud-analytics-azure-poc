import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError } from '../src/errors.mjs';
import { GUID, MAX_RESPONSE_BYTES } from '../src/validation.mjs';

const MARKER = '.fraud-local-preview';
const FORMAT = 'fraud-local-preview-evidence-v1\n';
const LOCK = '.preview.lock';
const noFollow = constants.O_NOFOLLOW ?? 0;
const fail = (detail) => { throw new AppError(503, 'LOCAL_EVIDENCE_UNAVAILABLE', `Local evidence directory: ${detail}`); };

async function regularFile(filename, maximum, { optional = false } = {}) {
  let stat;
  try { stat = await lstat(filename); }
  catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) fail('unsafe or oversized file.');
}

async function boundedRead(filename, maximum, signal) {
  await regularFile(filename, maximum);
  const handle = await open(filename, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) fail('unsafe or oversized file.');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) return buffer.subarray(0, length);
      length += bytesRead;
    }
    fail('read exceeded the evidence byte budget.');
  } finally { await handle.close(); }
}

async function exclusiveWrite(filename, content, signal) {
  signal?.throwIfAborted();
  const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  let complete = false;
  try {
    await handle.writeFile(content, { signal });
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(filename);
  }
}

async function ensureDirectoryTree(directory) {
  const root = path.parse(directory).root;
  let cursor = root;
  for (const part of directory.slice(root.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { await mkdir(cursor, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('symbolic links and non-directory path components are forbidden.');
  }
}

export async function createLocalEvidenceContainer(evidenceDirectory) {
  if (typeof evidenceDirectory !== 'string' || !evidenceDirectory.trim() || evidenceDirectory.includes('\0')) {
    fail('an explicit dedicated --evidence-directory is required.');
  }
  const directory = path.resolve(evidenceDirectory);
  if (directory === path.parse(directory).root || directory === process.cwd() ||
      directory.startsWith('\\\\') || (process.platform === 'win32' && directory.slice(3).includes(':'))) {
    fail('use a dedicated local folder, not a root, working directory or network share.');
  }
  await ensureDirectoryTree(directory);
  const canonical = await realpath(directory);
  const originalDirectory = await lstat(directory);
  const entries = await readdir(directory);
  if (!entries.includes(MARKER)) {
    if (entries.length) fail('refusing to adopt a nonempty, unmarked folder.');
    await exclusiveWrite(path.join(directory, MARKER), FORMAT);
  } else if ((await boundedRead(path.join(directory, MARKER), 100)).toString() !== FORMAT) {
    fail('the folder marker is not recognized.');
  }
  if (entries.some((name) => ![MARKER, LOCK, '.demo-budget.json'].includes(name) && !GUID.test(name))) {
    fail('unexpected files in the dedicated folder; inspect it before retrying.');
  }
  const lockPath = path.join(directory, LOCK);
  try { await exclusiveWrite(lockPath, `${process.pid}\n`); }
  catch (error) {
    if (error.code === 'EEXIST') fail('already locked. Stop the owning preview; after a crash verify its PID is gone before removing .preview.lock.');
    throw error;
  }
  let closed = false;
  async function checkRoot(signal) {
    signal?.throwIfAborted();
    if (closed) fail('container is closed.');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== originalDirectory.dev ||
        stat.ino !== originalDirectory.ino || await realpath(directory) !== canonical) fail('folder identity changed.');
  }
  async function target(relative, create, signal) {
    await checkRoot(signal);
    const parts = typeof relative === 'string' ? relative.split('/') : [];
    if (parts.length !== 2 || !GUID.test(parts[0]) || !/^[0-9a-f-]{36}\.json$/i.test(parts[1]) || !GUID.test(parts[1].slice(0, -5))) {
      fail('only GUID/GUID.json evidence paths are permitted.');
    }
    const subject = path.join(directory, parts[0]);
    if (create) {
      try { await mkdir(subject, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await lstat(subject);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(subject) !== path.join(canonical, parts[0])) fail('unsafe subject directory.');
    return path.join(subject, parts[1]);
  }
  const container = {
    directory,
    async getProperties({ abortSignal } = {}) {
      await checkRoot(abortSignal);
      const probe = path.join(directory, `.preflight-${randomUUID()}`);
      try {
        await exclusiveWrite(probe, 'local evidence preflight', abortSignal);
        await boundedRead(probe, 100, abortSignal);
      } finally {
        await unlink(probe).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      return {};
    },
    getBlockBlobClient(relative) {
      return {
        async upload(content, length, options = {}) {
          if (options.conditions?.ifNoneMatch !== '*' || typeof content !== 'string' ||
              length !== Buffer.byteLength(content) || length > MAX_RESPONSE_BYTES) fail('create-only bounded uploads are required.');
          const filename = await target(relative, true, options.abortSignal);
          try { await exclusiveWrite(filename, content, options.abortSignal); }
          catch (error) {
            if (error.code === 'EEXIST') throw new AppError(409, 'LOCAL_EVIDENCE_EXISTS', 'Evidence is immutable; the existing file was not overwritten.');
            throw error;
          }
          return {};
        },
      };
    },
    getBlobClient(relative) {
      return {
        async download(offset, count, { abortSignal } = {}) {
          if (offset !== 0 || count !== undefined) fail('only complete bounded evidence reads are supported.');
          try {
            const filename = await target(relative, false, abortSignal);
            const buffer = await boundedRead(filename, MAX_RESPONSE_BYTES, abortSignal);
            return { contentLength: buffer.length, readableStreamBody: Readable.from([buffer]) };
          } catch (error) {
            if (error.code === 'ENOENT') error.statusCode = 404;
            throw error;
          }
        },
      };
    },
    async checkBudgetFiles() {
      await checkRoot();
      await regularFile(path.join(directory, '.demo-budget.json'), 1024, { optional: true });
      try { await lstat(path.join(directory, '.demo-budget.json.pending')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      fail('an unfinished budget file exists; inspect it before retrying.');
    },
    async close() {
      if (!closed) {
        await checkRoot();
        await unlink(lockPath);
        closed = true;
      }
    },
  };
  try {
    await container.getProperties();
    await container.checkBudgetFiles();
  } catch (error) {
    await container.close();
    throw error;
  }
  return container;
}
