import type { EventInput, ForgeEvent, LogAnchor } from '@specforge/shared';
import { hashOf } from './hash.ts';

export const GENESIS_HASH = '0'.repeat(64);

/** 基于上一条事件生成新事件（哈希链） */
export function chainEvent(prev: ForgeEvent | undefined, input: EventInput, at: string): ForgeEvent {
  const body = {
    ...input,
    seq: prev ? prev.seq + 1 : 1,
    at,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return { ...body, hash: hashOf(body) };
}

export interface ChainProblem {
  seq: number;
  problem: string;
}

/** 校验整条链：序号连续、prevHash 衔接、hash 与内容一致 */
export function verifyChain(events: ForgeEvent[]): ChainProblem[] {
  const problems: ChainProblem[] = [];
  let prev: ForgeEvent | undefined;
  for (const event of events) {
    const { hash, ...body } = event;
    const expectedSeq = prev ? prev.seq + 1 : 1;
    if (event.seq !== expectedSeq) {
      problems.push({ seq: event.seq, problem: `序号不连续，期望 ${expectedSeq}` });
    }
    if (event.prevHash !== (prev ? prev.hash : GENESIS_HASH)) {
      problems.push({ seq: event.seq, problem: 'prevHash 与上一条事件不衔接' });
    }
    if (hashOf(body) !== hash) {
      problems.push({ seq: event.seq, problem: '内容与 hash 不符（事件被修改）' });
    }
    prev = event;
  }
  return problems;
}

export function verifyLogAnchors(events: ForgeEvent[], anchors: LogAnchor[]): ChainProblem[] {
  const problems: ChainProblem[] = [];
  let previousSeq = 0;
  for (const anchor of anchors) {
    if (!anchor || anchor.version !== 1 || !Number.isSafeInteger(anchor.seq) || anchor.seq < 1
      || typeof anchor.hash !== 'string' || !/^[a-f0-9]{64}$/.test(anchor.hash)
      || typeof anchor.at !== 'string' || !Number.isFinite(Date.parse(anchor.at))) {
      problems.push({ seq: 0, problem: '锚定记录格式无效' });
      continue;
    }
    if (anchor.seq <= previousSeq) problems.push({ seq: anchor.seq, problem: '锚定序号没有递增' });
    previousSeq = anchor.seq;
    const event = events[anchor.seq - 1];
    if (!event || event.seq !== anchor.seq) {
      problems.push({ seq: anchor.seq, problem: '已锚定的事件缺失（日志被截断）' });
    } else if (event.hash !== anchor.hash) {
      problems.push({ seq: anchor.seq, problem: '事件与 Git 锚定的哈希不符（日志被重写）' });
    }
  }
  return problems;
}
