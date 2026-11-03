/** Account roles are independent of project owner/reviewer responsibilities. */
export const ROLES = ['superadmin', 'admin', 'member'];
export const ROLE_LABELS = { superadmin: '总管理员', admin: '管理员', member: '员工' };
export const normalizeRole = role => role === 'manager' ? 'member' : role;
export const isAdminRole = role => role === 'superadmin' || role === 'admin';
export const isSuperAdminRole = role => role === 'superadmin';
