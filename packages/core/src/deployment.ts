/** 部署路径的纯校验；不从 Host、转发头或请求参数推断。 */
export function deploymentPath(value: unknown = ''): string {
  if (value === '' || value === '/') return '';
  if (typeof value !== 'string') throw new Error('部署前缀必须是绝对路径');
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = path.split('/');
  if (segments[0] !== '' || segments.length === 1 || segments.length > 9
    || !segments.slice(1).every((segment) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(segment))) {
    throw new Error('部署前缀必须由字母、数字、下划线或短横线组成，最多八段');
  }
  return path;
}
