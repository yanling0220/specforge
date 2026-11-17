import { describe, expect, it } from 'vitest';
import { deploymentPath } from '../src/deployment.ts';

describe('部署前缀纯校验', () => {
  it('根部署保持空前缀，路径统一去掉末尾斜杠', () => {
    expect(deploymentPath()).toBe('');
    expect(deploymentPath('')).toBe('');
    expect(deploymentPath('/')).toBe('');
    expect(deploymentPath('/console/')).toBe('/console');
    expect(deploymentPath('/console/team_1-v2')).toBe('/console/team_1-v2');
    expect(deploymentPath('/' + Array(8).fill('team').join('/'))).toBe('/' + Array(8).fill('team').join('/'));
  });

  it('拒绝路径穿越、重复分隔符、编码歧义、URL 与可注入配置', () => {
    const invalid: unknown[] = [
      null, false, 0, {}, [],
      'console', '//console', '/console//', '/console//team', '/./console', '/console/..',
      '/console/%2e%2e', '/%63onsole', '/console?token=x', '/console#fragment',
      'https://example.invalid/console', '/console space',
      '/console' + String.fromCharCode(92) + 'team',
      '/console' + String.fromCharCode(10) + 'team',
      '/console' + String.fromCharCode(9) + 'team',
      '/console' + String.fromCharCode(60) + 'script',
      '/console' + String.fromCharCode(34) + 'quoted',
      '/' + 'a'.repeat(65), '/' + Array(9).fill('team').join('/'),
    ];
    for (const value of invalid) expect(() => deploymentPath(value)).toThrow(/部署前缀/);
  });
});
