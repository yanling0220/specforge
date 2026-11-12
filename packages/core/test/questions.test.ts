import { describe, expect, it } from 'vitest';
import type { Actor, ProjectConfig } from '@specforge/shared';
import {
  confirmAnswer,
  createQuestion,
  deferQuestion,
  ForgeError,
  missingRoles,
  proposeAnswer,
  rejectAnswer,
} from '../src/index.ts';

const config = {
  confirmPolicy: { 业务规则: ['dev', 'product'], default: ['dev'] },
} as unknown as ProjectConfig;

const dev: Actor = { name: 'yan', role: 'dev' };
const pm: Actor = { name: '王五', role: 'product' };
const T = '2026-11-12T10:00:00Z';

const businessQ = () =>
  createQuestion(
    {
      id: 'Q-1',
      category: '业务规则',
      severity: 'blocking',
      question: '超限文件如何处理？',
      options: [{ id: 'A', text: '拒绝' }, { id: 'B', text: '分片' }],
      raisedAtStage: 'analysis',
    },
    config,
    { name: 'analyst', role: 'agent' },
    T,
  );

describe('问题节点：双方核对', () => {
  it('业务类问题需要 dev + product，提出者角色自动确认', () => {
    let q = businessQ();
    expect(q.requiredRoles).toEqual(['dev', 'product']);
    q = proposeAnswer(q, { text: '直接拒绝', optionId: 'A' }, dev, T);
    expect(q.status).toBe('drafted');
    expect(missingRoles(q)).toEqual(['product']);
    q = confirmAnswer(q, {}, pm, T);
    expect(q.status).toBe('confirmed');
    expect(q.revisions[0]!.confirmations.map((c) => c.role)).toEqual(['dev', 'product']);
  });

  it('技术类问题只需要 dev', () => {
    const q = createQuestion({ id: 'Q-2', category: '性能', severity: 'important', question: '?', raisedAtStage: 'analysis' }, config, dev, T);
    expect(proposeAnswer(q, { text: '不需要缓存' }, dev, T).status).toBe('confirmed');
  });

  it('代录产品确认必须写核对渠道，并记录代录人', () => {
    const q = proposeAnswer(businessQ(), { text: '直接拒绝' }, dev, T);
    expect(() => confirmAnswer(q, { onBehalfOf: pm }, dev, T)).toThrow(/核对渠道/);
    const ok = confirmAnswer(q, { onBehalfOf: pm, via: 'https://wiki/meeting/1' }, dev, T);
    const c = ok.revisions[0]!.confirmations[1]!;
    expect(c).toMatchObject({ role: 'product', actor: pm, recordedBy: dev, via: 'https://wiki/meeting/1' });
    expect(ok.status).toBe('confirmed');
  });

  it('同一角色不能重复确认，不需要的角色不能确认', () => {
    const q = proposeAnswer(businessQ(), { text: '直接拒绝' }, dev, T);
    expect(() => confirmAnswer(q, {}, { name: 'x', role: 'dev' }, T)).toThrow(/已确认过/);
    const tech = proposeAnswer(
      createQuestion({ id: 'Q-3', category: '性能', severity: 'minor', question: '?', raisedAtStage: 'analysis' }, config, dev, T),
      { text: 'a' },
      { name: 'p', role: 'product' },
      T,
    );
    expect(tech.status).toBe('drafted');
    expect(() => confirmAnswer(tech, {}, pm, T)).toThrow(/不需要 product/);
  });

  it('修改已确认的答案必须写原因；旧版本保留为 superseded，需要重新确认', () => {
    let q = confirmAnswer(proposeAnswer(businessQ(), { text: '直接拒绝' }, dev, T), {}, pm, T);
    expect(() => proposeAnswer(q, { text: '分片上传' }, dev, T)).toThrow(ForgeError);
    q = proposeAnswer(q, { text: '分片上传', optionId: 'B', reason: '客户反馈大文件很常见' }, dev, T);
    expect(q.revisions.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect(q.status).toBe('drafted');
    expect(q.revisions[0]!.text).toBe('直接拒绝');
  });

  it('驳回必须写意见，问题回到 open，驳回记录保留', () => {
    const q = proposeAnswer(businessQ(), { text: '直接拒绝' }, dev, T);
    expect(() => rejectAnswer(q, ' ', pm, T)).toThrow(/意见/);
    const r = rejectAnswer(q, '需要支持 50MB 以内', pm, T);
    expect(r.status).toBe('open');
    expect(r.revisions[0]).toMatchObject({ state: 'rejected', rejection: { actor: pm, note: '需要支持 50MB 以内' } });
  });

  it('只有次要问题可以推迟；阻塞问题不能有默认答案', () => {
    expect(() => deferQuestion(businessQ(), '以后再说', dev, T)).toThrow(/只有次要问题/);
    expect(() =>
      createQuestion({ id: 'Q-9', category: '业务规则', severity: 'blocking', question: '?', options: [{ id: 'A', text: 'a' }], defaultOptionId: 'A', raisedAtStage: 'analysis' }, config, dev, T),
    ).toThrow(/默认答案/);
  });
});
