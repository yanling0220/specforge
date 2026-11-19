import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export interface ReviewDiffLimits {
  commandMs: number;
  totalMs: number;
  manifestBytes: number;
  maxFiles: number;
  patchBytes: number;
  blobBytes: number;
}

export const REVIEW_DIFF_LIMITS: Readonly<ReviewDiffLimits> = Object.freeze({
  commandMs: 5_000, totalMs: 15_000, manifestBytes: 2 * 1024 * 1024,
  maxFiles: 1_000, patchBytes: 256 * 1024, blobBytes: 8 * 1024 * 1024,
});

export type ReviewDiffErrorCode = 'bad_arg' | 'unavailable' | 'too_large' | 'timeout' | 'review_stale' | 'not_found';

/** Sanitized errors only: never attach Git stderr, environment or absolute paths. */
export class ReviewDiffError extends Error {
  readonly code: ReviewDiffErrorCode;
  constructor(code: ReviewDiffErrorCode) {
    super({ bad_arg: '无效的提交差异参数', unavailable: '无法读取提交差异', too_large: '提交差异超过读取上限',
      timeout: '读取提交差异超时', review_stale: '提交已变化，请刷新审查', not_found: '差异文件不存在' }[code]);
    this.name = 'ReviewDiffError';
    this.code = code;
  }
}

export interface ReviewDiffFile {
  id: string;
  /** Undefined when the original Git path cannot be represented losslessly as UTF-8. */
  path?: string;
  status: 'A' | 'M' | 'D' | 'T';
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  kind: 'file' | 'symlink' | 'submodule' | 'type_change' | 'unavailable';
}

export interface ReviewDiffManifest {
  baseSha: string;
  targetSha: string;
  baseIsAncestor: boolean;
  files: ReviewDiffFile[];
  excludedFiles: number;
}

export type ReviewFileDiff =
  | { file: ReviewDiffFile; kind: 'text' | 'symlink'; patch: string }
  | { file: ReviewDiffFile; kind: 'binary' | 'submodule' | 'type_change'; oldBytes?: number; newBytes?: number }
  | { file: ReviewDiffFile; kind: 'unavailable'; reason: 'encoding' | 'object_type' };

/** Binding comes from the Store, never from an HTTP caller. Limits may only be lowered. */
export interface ReviewDiffOptions {
  repo: string;
  projectBinding: string;
  changeId: string;
  baseSha: string;
  limits?: Partial<ReviewDiffLimits>;
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function utf8(bytes: Buffer): string | undefined {
  try { return decoder.decode(bytes); } catch { return undefined; }
}

function readEnvironment(): NodeJS.ProcessEnv {
  // Drop every inherited Git override, including GIT_DIR, config injection,
  // alternate object stores and pathspec flags. PATH is the host's trusted PATH.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
}

class GitRead {
  readonly repo: string;
  readonly limits: ReviewDiffLimits;
  readonly deadline: number;
  readonly env = readEnvironment();

  constructor(repo: string, overrides: Partial<ReviewDiffLimits> = {}) {
    this.limits = { ...REVIEW_DIFF_LIMITS };
    for (const key of Object.keys(REVIEW_DIFF_LIMITS) as (keyof ReviewDiffLimits)[]) {
      const value = overrides[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > REVIEW_DIFF_LIMITS[key]) throw new ReviewDiffError('bad_arg');
        this.limits[key] = value;
      }
    }
    try { this.repo = realpathSync(repo); } catch { throw new ReviewDiffError('unavailable'); }
    this.deadline = performance.now() + this.limits.totalMs;
  }

  async run(args: string[], maxBytes = this.limits.manifestBytes, allowed = [0], prefixOnly = false): Promise<{ out: Buffer; code: number }> {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) throw new ReviewDiffError('timeout');
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['--no-pager', '--no-replace-objects', '--no-optional-locks',
        '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=false',
        '-c', 'protocol.allow=never', '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false', ...args], {
        cwd: this.repo, env: this.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let failure: ReviewDiffError | undefined;
      let prefixComplete = false;
      const stop = (code: ReviewDiffErrorCode) => {
        if (!failure) { failure = new ReviewDiffError(code); child.kill('SIGKILL'); }
      };
      const timer = setTimeout(() => stop('timeout'), Math.min(this.limits.commandMs, remaining));
      child.stdout.on('data', (chunk: Buffer) => {
        if (prefixComplete || failure) return;
        if (prefixOnly && outputBytes + chunk.length >= maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - outputBytes));
          prefixComplete = true;
          child.kill('SIGKILL');
          return;
        }
        outputBytes += chunk.length;
        if (outputBytes > maxBytes) stop('too_large');
        else if (!failure) chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Drain stderr with a separate fixed budget; never retain or expose it.
        errorBytes += chunk.length;
        if (errorBytes > 64 * 1024) stop('too_large');
      });
      child.on('error', () => { failure ??= new ReviewDiffError('unavailable'); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (performance.now() > this.deadline) reject(new ReviewDiffError('timeout'));
        else if (!prefixComplete && (code === null || !allowed.includes(code))) reject(new ReviewDiffError('unavailable'));
        else resolve({ out: Buffer.concat(chunks), code: code ?? 0 });
      });
    });
  }

  async commit(value: string): Promise<string> {
    if (value !== 'HEAD' && !SHA.test(value)) throw new ReviewDiffError('bad_arg');
    const { out } = await this.run(['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], 256);
    const sha = out.toString('ascii').trim();
    if (!SHA.test(sha)) throw new ReviewDiffError('unavailable');
    return sha;
  }

  async ensureHead(sha: string): Promise<void> {
    if (await this.commit('HEAD') !== sha) throw new ReviewDiffError('review_stale');
  }

  async rejectPromisor(): Promise<void> {
    // Older Git (including Apple's 2.37) may not honor GIT_NO_LAZY_FETCH.
    // Reject partial clones before any object read; never rely on that flag alone.
    const { out } = await this.run(['config', '--name-only', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], 4096, [0, 1]);
    if (out.length) throw new ReviewDiffError('unavailable');
    const prefix = await this.run(['rev-parse', '--show-prefix'], 4096);
    if (!prefix.out.equals(Buffer.from('\n'))) throw new ReviewDiffError('bad_arg');
  }
}

function fileKind(oldMode: string, newMode: string): ReviewDiffFile['kind'] {
  const types = new Set([oldMode, newMode].filter((m) => m !== '000000').map((m) => m.slice(0, 3)));
  if (types.size > 1) return 'type_change';
  if (types.has('160')) return 'submodule';
  if (types.has('120')) return 'symlink';
  return types.has('100') ? 'file' : 'unavailable';
}

function excluded(path: Buffer): boolean {
  // Conservatively exclude internal components anywhere, also on case-insensitive hosts.
  return path.toString('latin1').split('/').some((part) => ['.git', '.specforge'].includes(part.toLowerCase()));
}

function parseManifest(bytes: Buffer, binding: string[], maxFiles: number): Pick<ReviewDiffManifest, 'files' | 'excludedFiles'> {
  const files: ReviewDiffFile[] = [];
  let excludedFiles = 0;
  let offset = 0;
  let count = 0;
  while (offset < bytes.length) {
    const headerEnd = bytes.indexOf(0, offset);
    const pathEnd = bytes.indexOf(0, headerEnd + 1);
    if (headerEnd < 0 || pathEnd < 0) throw new ReviewDiffError('unavailable');
    const header = bytes.subarray(offset, headerEnd).toString('ascii');
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDT])$/.exec(header);
    if (!match) throw new ReviewDiffError('unavailable');
    if (++count > maxFiles) throw new ReviewDiffError('too_large');
    const rawPath = bytes.subarray(headerEnd + 1, pathEnd);
    offset = pathEnd + 1;
    if (excluded(rawPath)) { excludedFiles++; continue; }
    const path = utf8(rawPath);
    const oldMode = match[1]!;
    const newMode = match[2]!;
    const id = createHash('sha256').update(JSON.stringify([...binding, header, rawPath.toString('hex')])).digest('hex');
    files.push({ id, ...(path === undefined ? {} : { path }), status: match[5] as ReviewDiffFile['status'],
      oldMode, newMode, oldOid: match[3]!, newOid: match[4]!, kind: path === undefined ? 'unavailable' : fileKind(oldMode, newMode) });
  }
  return { files, excludedFiles };
}

async function manifest(reader: GitRead, options: ReviewDiffOptions): Promise<ReviewDiffManifest> {
  if (!SHA.test(options.baseSha) || !options.projectBinding || !options.changeId) throw new ReviewDiffError('bad_arg');
  await reader.rejectPromisor();
  const targetSha = await reader.commit('HEAD');
  const baseSha = await reader.commit(options.baseSha);
  const ancestry = await reader.run(['merge-base', '--is-ancestor', baseSha, targetSha], 256, [0, 1]);
  const { out } = await reader.run(['diff-tree', '--no-commit-id', '--raw', '-z', '-r', '--no-renames', '--no-abbrev',
    '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', baseSha, targetSha, '--']);
  const parsed = parseManifest(out, [reader.repo, options.projectBinding, options.changeId, baseSha, targetSha], reader.limits.maxFiles);
  await reader.ensureHead(targetSha);
  return { baseSha, targetSha, baseIsAncestor: ancestry.code === 0, ...parsed };
}

/** Captures HEAD; all content is read from committed trees, never the index/worktree. */
export async function readReviewDiff(options: ReviewDiffOptions): Promise<ReviewDiffManifest> {
  return manifest(new GitRead(options.repo, options.limits), options);
}

async function objectSize(reader: GitRead, oid: string): Promise<number | undefined> {
  if (/^0+$/.test(oid)) return undefined;
  const { out } = await reader.run(['cat-file', '-s', oid], 128);
  const value = Number(out.toString('ascii').trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new ReviewDiffError('unavailable');
  return value;
}

async function binaryPrefix(reader: GitRead, oid: string): Promise<boolean> {
  if (/^0+$/.test(oid)) return false;
  // Git's normal binary heuristic examines the first 8,000 bytes. Read a
  // bounded object prefix so worktree attributes cannot force binary into text.
  const { out } = await reader.run(['cat-file', 'blob', oid], 8000, [0], true);
  return out.includes(0);
}

/** Rebuilds the allowed manifest: a file ID is a selector, never an authorization token. */
export async function readReviewFileDiff(options: ReviewDiffOptions & { targetSha: string; fileId: string }): Promise<ReviewFileDiff> {
  if (!SHA.test(options.targetSha) || !/^[a-f0-9]{64}$/.test(options.fileId)) throw new ReviewDiffError('not_found');
  const reader = new GitRead(options.repo, options.limits);
  const current = await manifest(reader, options);
  if (current.targetSha !== options.targetSha) throw new ReviewDiffError('review_stale');
  const file = current.files.find((f) => f.id === options.fileId);
  if (!file) throw new ReviewDiffError('not_found');
  let result: ReviewFileDiff;
  if (file.path === undefined) result = { file, kind: 'unavailable', reason: 'encoding' };
  else if (file.kind === 'submodule' || file.kind === 'type_change') result = { file, kind: file.kind };
  else if (file.kind === 'unavailable') result = { file, kind: 'unavailable', reason: 'object_type' };
  else {
    const oldBytes = await objectSize(reader, file.oldOid);
    const newBytes = await objectSize(reader, file.newOid);
    if ((oldBytes ?? 0) > reader.limits.blobBytes || (newBytes ?? 0) > reader.limits.blobBytes) {
      throw new ReviewDiffError('too_large');
    }
    if (await binaryPrefix(reader, file.oldOid) || await binaryPrefix(reader, file.newOid)) {
      result = { file, kind: 'binary', oldBytes, newBytes };
    } else {
      // A positive literal pathspec also matches descendants. Exclude those so a
      // file replacing a directory (or vice versa) returns exactly one entry.
      const patch = await reader.run(['-c', 'core.bare=true', 'diff-tree', '-p', '-r', '--no-commit-id',
        '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
        '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--diff-algorithm=myers',
        '--inter-hunk-context=0', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
        '--ignore-submodules=all', current.baseSha, current.targetSha, '--',
        `:(top,literal)${file.path}`, `:(top,literal,exclude)${file.path}/`], reader.limits.patchBytes);
      const text = utf8(patch.out);
      if (patch.out.includes(0) || (text !== undefined && /^Binary files .* differ$/m.test(text))) {
        result = { file, kind: 'binary', oldBytes, newBytes };
      } else if (text === undefined) result = { file, kind: 'unavailable', reason: 'encoding' };
      else result = { file, kind: file.kind === 'symlink' ? 'symlink' : 'text', patch: text };
    }
  }
  await reader.ensureHead(current.targetSha);
  return result;
}
