import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { chainEvent, emptyRegistry, ForgeError, hashOf, resolveIdentity, sha256 } from '@specforge/core';
import type {
  Actor,
  Analysis,
  Approval,
  Change,
  EventInput,
  ForgeEvent,
  ProjectConfig,
  Question,
  ReviewRecord,
  Role,
  TddEvidence,
  UserRegistry,
  VerificationEvidence,
} from '@specforge/shared';

export const FORGE_DIR = '.specforge';

export function defaultConfig(): ProjectConfig {
  return {
    version: 1,
    verify: [
      { name: 'install', command: 'npm ci' },
      { name: 'test', command: 'npm test' },
    ],
    protectedPaths: ['.github/**', '**/vitest.config.*', '**/jest.config.*', '**/.eslintrc*', '**/eslint.config.*', '.specforge/config.json'],
    testGlobs: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**', '**/*_test.*', '**/test_*.py'],
    skipPatterns: [
      '\\b(it|test|describe)\\.skip\\(',
      '\\bx(it|describe|test)\\(',
      '\\.only\\(',
      '@Ignore\\b',
      '@Disabled\\b',
      'pytest\\.mark\\.skip',
      '\\bt\\.Skip\\(',
    ],
    tdd: { setup: 'npm ci', command: 'npm test -- {files}' },
    workflow: { maxFixRounds: 3 },
    confirmPolicy: {
      业务规则: ['dev', 'product'],
      范围: ['dev', 'product'],
      用户与角色: ['dev', 'product'],
      交互体验: ['dev', 'product'],
      default: ['dev'],
    },
    dimensions: [
      '用户与角色',
      '输入与校验',
      '状态流转',
      '异常与错误',
      '边界值',
      '并发与幂等',
      '数据迁移与兼容',
      '性能',
      '安全与权限',
      '可观测性',
      '交互体验',
      '范围外事项',
    ],
  };
}

export interface EvidenceEntry {
  id: string;
  kind: 'verify' | 'tdd';
  sha: string;
  taskId?: string;
  passed: boolean;
  seq: number;
  at: string;
  actor: Actor;
  hashOk: boolean;
}

/** 一个 change 在 .specforge 中的全部状态 */
export interface ChangeState {
  change: Change;
  analysis: Analysis;
  questions: Question[];
  reviews: ReviewRecord[];
  approvals: Approval[];
}

const STATE_FILES = ['change', 'analysis', 'questions', 'reviews', 'approvals'] as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function stateHash(state: ChangeState): string {
  return hashOf(state);
}

export class Store {
  root: string;
  constructor(root: string) {
    this.root = root;
  }

  static find(cwd: string): Store {
    let dir = cwd;
    while (true) {
      if (existsSync(join(dir, FORGE_DIR, 'config.json'))) return new Store(dir);
      const parent = dirname(dir);
      if (parent === dir) throw new ForgeError('no_project', '当前目录不在 SpecForge 项目中，请先运行 sf init');
      dir = parent;
    }
  }

  path(...parts: string[]): string {
    return join(this.root, FORGE_DIR, ...parts);
  }

  rel(path: string): string {
    return relative(this.root, path);
  }

  config(): ProjectConfig {
    return readJson<ProjectConfig>(this.path('config.json'));
  }

  // ---------- 身份 ----------

  /** 当前身份：--as 优先，否则读本机设置；有用户名册时必须是名册中拥有该角色的用户 */
  identity(override?: string): Actor {
    return resolveIdentity(this.users(), this.claimedIdentity(override));
  }

  /** 未经名册校验的声明身份 */
  claimedIdentity(override?: string): Actor {
    if (override) return parseActor(override);
    const file = this.path('identity.local.json');
    if (!existsSync(file)) {
      throw new ForgeError('no_identity', '还没有设置身份：sf whoami --set <名字>:<dev|product>');
    }
    return readJson<Actor>(file);
  }

  setIdentity(actor: Actor): void {
    writeJson(this.path('identity.local.json'), actor);
  }

  // ---------- 用户名册（T4.1） ----------

  /**
   * 用户名册；undefined 表示尚未启用（兼容模式：身份自行声明）。
   * 名册与最后一条 user.* 事件记录的哈希不一致（被绕过引擎修改或删除）时拒绝使用。
   */
  users(): UserRegistry | undefined {
    const problem = this.usersOutOfBand();
    if (problem) throw new ForgeError('out_of_band', `用户名册${problem}，拒绝使用。请从版本库恢复 .specforge/users.json`);
    const file = this.path('users.json');
    return existsSync(file) ? readJson<UserRegistry>(file) : undefined;
  }

  /** 名册与事件日志不一致时返回说明 */
  usersOutOfBand(): string | undefined {
    const file = this.path('users.json');
    const last = this.events().filter((e) => e.type.startsWith('user.') && e.stateHash).at(-1);
    if (!existsSync(file)) return last ? '文件缺失，但事件日志中有用户记录' : undefined;
    if (!last) return '没有任何事件记录（不是通过 sf user 命令创建的）';
    return last.stateHash === hashOf(readJson<UserRegistry>(file)) ? undefined : `被绕过引擎修改（最后一次记录是事件 #${last.seq}）`;
  }

  /** 修改名册的唯一入口：校验 → 应用 → 落盘 → 写事件（事件中不含令牌哈希） */
  mutateUsers(actor: Actor, type: string, fn: (reg: UserRegistry) => UserRegistry, payload: Record<string, unknown>): UserRegistry {
    const next = fn(this.users() ?? emptyRegistry());
    writeJson(this.path('users.json'), next);
    this.append({ type, actor, payload, stateHash: hashOf(next) });
    return next;
  }

  // ---------- change 状态 ----------

  changeDir(id: string): string {
    return this.path('changes', id);
  }

  listChanges(): string[] {
    const dir = this.path('changes');
    return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'change.json'))).sort() : [];
  }

  load(id: string): ChangeState {
    const dir = this.changeDir(id);
    if (!existsSync(join(dir, 'change.json'))) throw new ForgeError('no_change', `change ${id} 不存在`);
    const read = <T>(name: string, fallback: T): T =>
      existsSync(join(dir, `${name}.json`)) ? readJson<T>(join(dir, `${name}.json`)) : fallback;
    return {
      change: read<Change>('change', undefined as never),
      analysis: read<Analysis>('analysis', { nodes: [], assumptions: [], dimensions: [] }),
      questions: read<Question[]>('questions', []),
      reviews: read<ReviewRecord[]>('reviews', []),
      approvals: read<Approval[]>('approvals', []),
    };
  }

  private save(state: ChangeState): void {
    const dir = this.changeDir(state.change.id);
    for (const name of STATE_FILES) writeJson(join(dir, `${name}.json`), state[name]);
  }

  /** 创建 change：写状态并记录事件 */
  create(state: ChangeState, actor: Actor): void {
    if (existsSync(join(this.changeDir(state.change.id), 'change.json'))) {
      throw new ForgeError('exists', `change ${state.change.id} 已存在`);
    }
    this.save(state);
    this.append({ type: 'change.created', actor, changeId: state.change.id, payload: { ...state.change }, stateHash: stateHash(state) });
  }

  /**
   * 所有状态变更的唯一入口：校验没有带外修改 → 应用变更 → 落盘 → 写事件（P5）。
   */
  mutate(
    id: string,
    actor: Actor,
    type: string,
    fn: (s: ChangeState) => ChangeState,
    payload: (next: ChangeState) => Record<string, unknown>,
  ): ChangeState {
    const current = this.load(id);
    const oob = this.outOfBand(id, current);
    if (oob) {
      throw new ForgeError(
        'out_of_band',
        `检测到 ${id} 的状态文件被绕过引擎修改（${oob}）。请检查后运行 sf log ack ${id} --reason "<说明>" 记录确认`,
      );
    }
    const next = fn(current);
    this.save(next);
    this.append({ type, actor, changeId: id, payload: payload(next), stateHash: stateHash(next) });
    return next;
  }

  /** 当前状态与最后一次事件记录的 stateHash 不一致时返回说明 */
  outOfBand(id: string, state = this.load(id)): string | undefined {
    const last = this.events().filter((e) => e.changeId === id && e.stateHash).at(-1);
    if (!last) return '没有任何事件记录';
    return last.stateHash === stateHash(state) ? undefined : `最后一次记录是事件 #${last.seq}`;
  }

  /** 人工确认带外修改，把当前状态重新纳入链中 */
  acknowledgeOutOfBand(id: string, actor: Actor, reason: string): void {
    const state = this.load(id);
    this.append({ type: 'state.out_of_band_acknowledged', actor, changeId: id, payload: { reason }, stateHash: stateHash(state) });
  }

  // ---------- 证据 ----------

  saveEvidence(changeId: string, ev: VerificationEvidence, actor: Actor): string {
    const file = join(this.changeDir(changeId), 'evidence', `${ev.id}.json`);
    writeJson(file, ev);
    this.append({
      type: 'evidence.recorded',
      actor,
      changeId,
      payload: {
        evidenceId: ev.id,
        sha: ev.sha,
        evidenceHash: hashOf(ev),
        steps: ev.steps.map((s) => ({ name: s.name, exitCode: s.exitCode, timedOut: s.timedOut })),
      },
    });
    return file;
  }

  /** 最新一份针对指定 commit 的证据；证据文件的哈希必须和事件日志中记录的一致 */
  latestEvidence(changeId: string, sha: string): VerificationEvidence | undefined {
    const recorded = this.events().filter((e) => e.changeId === changeId && e.type === 'evidence.recorded' && e.payload.sha === sha);
    for (const event of recorded.reverse()) {
      const file = join(this.changeDir(changeId), 'evidence', `${String(event.payload.evidenceId)}.json`);
      if (!existsSync(file)) continue;
      const ev = readJson<VerificationEvidence>(file);
      if (hashOf(ev) === event.payload.evidenceHash) return ev;
    }
    return undefined;
  }

  /** 保存 G5 证据；事件记录证据哈希与结论，证据文件被改动后不再被采信 */
  saveTddEvidence(changeId: string, ev: TddEvidence, actor: Actor, passed: boolean): string {
    const file = join(this.changeDir(changeId), 'evidence', `${ev.id}.json`);
    writeJson(file, ev);
    this.append({
      type: 'tdd.recorded',
      actor,
      changeId,
      payload: {
        evidenceId: ev.id,
        taskId: ev.taskId,
        base: ev.base,
        sha: ev.sha,
        testFiles: ev.testFiles,
        red: ev.red.test ? { exitCode: ev.red.test.exitCode, timedOut: ev.red.test.timedOut } : null,
        green: ev.green.test ? { exitCode: ev.green.test.exitCode, timedOut: ev.green.test.timedOut } : null,
        passed,
        evidenceHash: hashOf(ev),
      },
    });
    return file;
  }

  /** 全部 G5 证据（按记录顺序）；哈希与事件日志不一致的证据被忽略 */
  tddEvidence(changeId: string): TddEvidence[] {
    return this.events()
      .filter((e) => e.changeId === changeId && e.type === 'tdd.recorded')
      .flatMap((event) => {
        const file = join(this.changeDir(changeId), 'evidence', `${String(event.payload.evidenceId)}.json`);
        if (!existsSync(file)) return [];
        const ev = readJson<TddEvidence>(file);
        return hashOf(ev) === event.payload.evidenceHash ? [ev] : [];
      });
  }

  /**
   * 全部证据（验证证据与 G5 证据）的目录，按记录顺序。
   * hashOk 为 false 表示文件缺失或内容与事件日志中记录的哈希不一致，不应被采信。
   */
  evidenceIndex(changeId: string): EvidenceEntry[] {
    return this.events()
      .filter((e) => e.changeId === changeId && (e.type === 'evidence.recorded' || e.type === 'tdd.recorded'))
      .map((e) => {
        const id = String(e.payload.evidenceId);
        const file = join(this.changeDir(changeId), 'evidence', `${id}.json`);
        const hashOk = existsSync(file) && hashOf(readJson<unknown>(file)) === e.payload.evidenceHash;
        return {
          id,
          kind: e.type === 'tdd.recorded' ? 'tdd' : 'verify',
          sha: String(e.payload.sha),
          taskId: e.type === 'tdd.recorded' ? String(e.payload.taskId) : undefined,
          passed:
            e.type === 'tdd.recorded'
              ? e.payload.passed === true
              : (e.payload.steps as { exitCode: number | null; timedOut: boolean }[]).every((s) => s.exitCode === 0 && !s.timedOut),
          seq: e.seq,
          at: e.at,
          actor: e.actor,
          hashOk,
        };
      });
  }

  /** 读取一份证据；不存在返回 undefined */
  readEvidence(changeId: string, id: string): { entry: EvidenceEntry; content: VerificationEvidence | TddEvidence } | undefined {
    const entry = this.evidenceIndex(changeId).find((x) => x.id === id);
    if (!entry) return undefined;
    const file = join(this.changeDir(changeId), 'evidence', `${id}.json`);
    if (!existsSync(file)) return undefined;
    return { entry, content: readJson<VerificationEvidence | TddEvidence>(file) };
  }

  // ---------- 事件日志 ----------

  events(): ForgeEvent[] {
    const file = this.path('events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ForgeEvent);
  }

  append(input: EventInput): ForgeEvent {
    const event = chainEvent(this.events().at(-1), input, new Date().toISOString());
    appendFileSync(this.path('events.jsonl'), JSON.stringify(event) + '\n');
    return event;
  }

  // ---------- OpenSpec ----------

  openspecChangeDir(id: string): string {
    return join(this.root, 'openspec', 'changes', id);
  }
}

/** 生成 Web 登录令牌：256 位随机数；名册只保存它的 SHA-256 */
export function newToken(): { token: string; hash: string } {
  const token = `sf_${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

const ROLES: Role[] = ['dev', 'product', 'agent'];

export function parseActor(text: string): Actor {
  const idx = text.lastIndexOf(':');
  const name = idx > 0 ? text.slice(0, idx).trim() : '';
  const role = (idx > 0 ? text.slice(idx + 1).trim() : '') as Role;
  if (!name || !ROLES.includes(role)) {
    throw new ForgeError('bad_actor', `身份格式应为 <名字>:<${ROLES.join('|')}>，收到「${text}」`);
  }
  return { name, role };
}
