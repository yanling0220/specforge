import type { NotificationRecord, NotificationRoute } from '@specforge/shared';

export interface NotificationMessageOptions {
  alias: string;
  publicBaseUrl: string;
  multiProject: boolean;
}

/** 使用结构化 post 节点，文本不能产生新的 @ 或超链接。 */
export function notificationMessage(record: NotificationRecord, members: NotificationRoute['members'], options: NotificationMessageOptions) {
  const demand = record.demand;
  const segment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const base = options.publicBaseUrl.replace(/\/$/, '');
  const prefix = options.multiProject ? `/p/${segment(demand.scope.projectId)}` : '';
  const href = `${base}${prefix}/#/changes/${segment(demand.changeId)}${demand.kind === 'question-confirmation' ? `/analysis/${segment(demand.questionId)}` : ''}`;
  const text = (value: string) => ({ tag: 'text' as const, text: value, un_escape: false });
  const subject = demand.kind === 'question-confirmation'
    ? `${demand.changeId} / ${demand.questionId} 第 ${demand.rev} 版（${demand.answerHash.slice(0, 8)}）待 ${demand.role} 确认`
    : `${demand.changeId} / commit ${demand.sha.slice(0, 12)} 待 dev 签字`;
  return {
    msg_type: 'post' as const,
    content: { post: { zh_cn: {
      title: `SpecForge · ${options.alias}`,
      content: [
        [text(subject)],
        [text(`通知 n-${record.key.slice(0, 12)} · ${record.updatedAt}`)],
        members.map((member) => ({ tag: 'at' as const, user_id: member.memberId })),
        [{ tag: 'a' as const, text: '打开平台核对当前状态', href }],
      ],
    } } },
  };
}
