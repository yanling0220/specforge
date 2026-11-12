// 用户管理：内存存储
const users = new Map();
export const MAX_NAME = 32;
export function createUser({ email, name, role = 'member' }) {
  if (!email || !email.includes('@')) throw new Error('邮箱格式错误');
  if (users.has(email)) throw new Error('邮箱已存在');
  if (!name || name.length > MAX_NAME) throw new Error('姓名不能为空且不超过 32 字');
  if (!['admin', 'member'].includes(role)) throw new Error('角色无效');
  const user = { email, name, role, createdAt: Date.now() };
  users.set(email, user);
  return user;
}
export const listUsers = () => [...users.values()];
