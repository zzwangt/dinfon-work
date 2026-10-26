const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function notificationCount(items, {category, entityId, projectId} = {}) {
  return items.filter(item => (!category || item.category === category) && (!entityId || item.entityId === entityId) && (!projectId || item.projectId === projectId)).length;
}

export function unreadBadge(count) {
  return count > 0 ? `<span class="unread-count" aria-label="${count} 条未读">${count > 99 ? '99+' : count}</span>` : '';
}

export function renderNotificationList(items, formatTime) {
  if (!items.length) return '<div class="notification-empty"><h3>暂无未读消息</h3><p>新的工作动态会显示在这里。</p></div>';
  const categories = {tasks:'任务', projects:'项目', approvals:'审批'};
  return `<div class="notification-list">${items.map(item => `<button type="button" class="notification-item" data-action="open-notification" data-id="${escape(item.id)}"><span class="notification-unread-dot" aria-hidden="true"></span><span class="notification-copy"><strong>${escape(item.title)}</strong><small>${categories[item.category] || '通知'} · ${escape(formatTime(item.createdAt))}</small></span><span class="notification-arrow" aria-hidden="true">›</span></button>`).join('')}</div>`;
}
