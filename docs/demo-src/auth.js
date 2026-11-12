export function requireAdmin(user) {
  if (user?.role !== 'admin') throw new Error('需要管理员权限');
}
