import { formatDateTime } from './time.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const size = bytes => Number(bytes) >= 1048576 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : `${Math.ceil((Number(bytes) || 0) / 1024)} KB`;
const when = value => value ? escape(formatDateTime(value)) : '—';
const reason = value => ({ scheduled:'自动备份', automatic:'自动备份', manual:'手动备份', upgrade:'升级前备份', 'pre-upgrade':'升级前备份' })[value] || '完整备份';
let generation = 0;
const controllers = new Set();
const activeOperations = new Set();
export const maintenanceIsBusy = () => {
  for (const host of activeOperations) if (!host.isConnected) activeOperations.delete(host);
  return activeOperations.size > 0 || (typeof document !== 'undefined' && Boolean(document.activeElement?.closest?.('[data-maintenance-root]')));
};

export function resetMaintenance() {
  generation++;
  for (const controller of controllers) controller.abort();
  controllers.clear();
  activeOperations.clear();
}

export function renderMaintenancePanel() {
  return '<section class="maintenance-panel" data-maintenance-root aria-label="备份与升级"><p class="muted" role="status">正在读取备份与升级设置…</p></section>';
}

export function renderMaintenanceContent(data, { busy = false, message = '', error = '', restarting = false } = {}) {
  const settings = data.settings || {}, upgrade = data.upgrade || {}, stage = upgrade.staged;
  const disabled = busy || restarting ? 'disabled' : '';
  const backups = data.backups || [];
  return `<div class="maintenance-heading"><div><h2>备份与升级</h2><p>保留账号、项目、任务和全部上传文件。</p></div><span class="tag">${settings.enabled ? '自动备份已开启' : '自动备份已关闭'}</span></div>
    <div class="maintenance-feedback" role="${error ? 'alert' : 'status'}" ${!error && !message ? 'hidden' : ''}>${escape(error || message)}</div>
    <div class="maintenance-columns"><section class="maintenance-card"><h3>自动备份</h3>
      <form data-maintenance-form="settings"><label class="maintenance-toggle"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''} ${disabled}>每天自动备份</label>
      <div class="maintenance-fields"><label>备份时间（北京时间）<input type="time" name="time" value="${escape(settings.time || '02:00')}" required ${disabled}></label><label>保留最近几份<input type="number" name="retention" value="${escape(settings.retention || 14)}" min="1" max="90" required ${disabled}></label></div>
      <div class="maintenance-actions"><button class="button secondary" type="submit" ${disabled}>保存设置</button><button class="button primary" type="button" data-maintenance-action="backup" ${disabled}>立即完整备份</button></div></form>
      <dl class="maintenance-summary"><div><dt>最近备份</dt><dd>${when(data.lastBackup?.createdAt)}</dd></div><div><dt>下次自动备份</dt><dd>${settings.enabled ? when(data.nextBackup) : '已关闭'}</dd></div></dl>
      ${data.backupError ? `<p class="maintenance-error" role="alert">最近备份失败：${escape(data.backupError)}</p>` : ''}
      <p class="field-help">备份保存在服务器。可下载后另存，防止服务器故障。</p></section>
    <section class="maintenance-card"><h3>一键升级</h3><p class="muted">当前版本 ${escape(upgrade.currentVersion || '—')}${upgrade.currentBuild ? ` · ${escape(upgrade.currentBuild)}` : ''}</p>
      ${upgrade.supported ? `<form data-maintenance-form="prepare"><label class="maintenance-package">选择更新包<input type="file" name="archive" accept=".zip,application/zip" required ${disabled}></label><p class="field-help">选择本平台发布的 ZIP 更新包，最大 50 MB。</p><button class="button secondary" type="submit" ${disabled}>检查更新包</button></form>` : '<p class="maintenance-notice">当前启动方式不支持自动重启。使用新版启动入口后即可一键升级；自动备份仍可使用。</p>'}
      ${stage ? `<div class="maintenance-stage"><strong>更新包已检查</strong><dl class="maintenance-summary"><div><dt>版本</dt><dd>${escape(stage.version)}${stage.buildId ? ` · ${escape(stage.buildId)}` : ''}</dd></div><div><dt>程序文件</dt><dd>${escape(stage.files)} 个 · ${size(stage.size)}</dd></div></dl><p>升级前自动备份，原账号、项目和文件全部保留。期间会短暂停止操作。</p><button class="button primary" type="button" data-maintenance-action="apply" data-stage-id="${escape(stage.id)}" ${disabled || !upgrade.supported ? 'disabled' : ''}>备份并升级</button></div>` : ''}
      ${restarting ? '<p class="maintenance-notice" role="status">正在备份并重启，完成后会自动刷新。请暂时不要操作项目。</p>' : ''}
      ${upgrade.lastError ? `<p class="maintenance-error" role="alert">${escape(upgrade.lastError)}</p>` : ''}
      ${upgrade.status === 'succeeded' ? `<p class="field-help">最近升级已完成 · ${when(upgrade.lastResult?.completedAt)}</p>` : ''}
    </section></div>
    <section class="maintenance-history"><div class="maintenance-heading"><h3>完整备份记录</h3><span class="muted">${backups.length} 份</span></div>${backups.length ? `<ul>${backups.map(item => `<li><div><strong>${when(item.createdAt)}</strong><span>${escape(reason(item.reason))} · ${size(item.size)}</span></div><a class="button secondary small" href="/api/maintenance/backups/${encodeURIComponent(item.id)}/download" download>下载备份</a></li>`).join('')}</ul>` : '<p class="muted">暂无备份，点击“立即完整备份”创建第一份。</p>'}</section>`;
}

export function bindMaintenancePanel({ root = document, onError = () => {} } = {}) {
  const host = root.querySelector('[data-maintenance-root]');
  if (!host || host.dataset.maintenanceBound) return;
  host.dataset.maintenanceBound = 'true';
  const controller = new AbortController(), epoch = generation;
  controllers.add(controller);
  let data = null, busy = false, restarting = false, message = '', error = '';
  const alive = () => !controller.signal.aborted && epoch === generation && host.isConnected;
  const paint = () => { if (busy || restarting) activeOperations.add(host); else activeOperations.delete(host); if (alive() && data) host.innerHTML = renderMaintenanceContent(data, { busy, restarting, message, error }); };
  const request = async (path = '', options = {}) => {
    const response = await fetch(`/api/maintenance${path}`, { credentials:'same-origin', cache:'no-store', ...options, signal:controller.signal });
    const result = await response.json().catch(() => ({ error:'服务器响应异常，请稍后重试。' }));
    if (!response.ok) { const err = new Error(result.error || '操作未成功，请重试。'); err.status=response.status; throw err; }
    return result;
  };
  const post = (path, value) => request(path, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(value) });
  const refresh = async () => { const result = await request(); if (alive()) { data=result; if(data.upgrade?.status==='applying'&&!restarting){restarting=true;void waitForRestart(data.upgrade.staged?.id);} paint(); } };
  const perform = async (operation, success) => {
    if (busy || restarting || !alive()) return;
    busy=true; message='正在处理…'; error=''; paint();
    try { await operation(); if (!alive()) return; message=success; await refresh(); }
    catch (err) { if (alive()) { error=err.message; message=''; if (err.status===401 || err.status===403) onError(err); } }
    finally { busy=false; paint(); }
  };
  const waitForRestart = async stageId => {
    const deadline=Date.now()+120000;
    while (alive() && Date.now()<deadline) {
      await new Promise(resolve => setTimeout(resolve,1500));
      if (!alive()) return;
      try {
        const latest=await request(), upgrade=latest.upgrade || {};
        if (upgrade.status==='failed') { data=latest; restarting=false; error=upgrade.lastError || '升级未完成，请查看服务器状态。'; message=''; paint(); return; }
        if (upgrade.status==='succeeded' && stageId && upgrade.lastResult?.stageId===stageId) {
          data=latest; message='升级完成，正在刷新…'; paint(); window.location.reload(); return;
        }
      } catch (err) {
        if (err.status===401 || err.status===403) { onError(err); return; }
        if (err.message.includes('升级未完成') || err.message.includes('回滚')) { restarting=false; error=err.message; paint(); return; }
      }
    }
    if (alive()) { restarting=false; error='尚未确认服务重启完成。请稍后刷新，或检查服务器运行状态。'; message=''; paint(); }
  };
  host.addEventListener('submit', event => {
    const form=event.target;
    if (!form.matches('[data-maintenance-form]')) return;
    event.preventDefault(); event.stopPropagation();
    if (form.dataset.maintenanceForm==='settings') {
      const value={ enabled:form.elements.enabled.checked, time:form.elements.time.value, retention:Number(form.elements.retention.value) };
      void perform(() => post('/settings',value),'自动备份设置已保存。');
    } else {
      const file=form.elements.archive.files[0];
      if (!file) return;
      if (file.size>50*1024*1024) { error='更新包不能超过 50 MB。'; paint(); return; }
      const body=new FormData(); body.append('archive',file);
      void perform(() => request('/upgrade/prepare',{method:'POST',body}),'更新包已检查，可以开始升级。');
    }
  });
  host.addEventListener('click', event => {
    const button=event.target.closest('[data-maintenance-action]');
    if (!button || busy || restarting) return;
    if (button.dataset.maintenanceAction==='backup') void perform(() => post('/backup',{}),'完整备份已保存，包含账号和上传文件。');
    if (button.dataset.maintenanceAction==='apply') {
      const stageId=button.dataset.stageId;
      busy=true; error=''; message='正在创建升级前备份…'; paint();
      void post('/upgrade/apply',{stageId}).then(() => {
        if (!alive()) return;
        busy=false; restarting=true; message='正在升级，请稍候…'; paint(); void waitForRestart(stageId);
      }).catch(err => { if (alive()) { busy=false; error=err.message; message=''; paint(); } });
    }
  });
  void refresh().catch(err => {
    if (!alive()) return;
    host.innerHTML=`<h2>备份与升级</h2><p class="maintenance-error" role="alert">${escape(err.message)}</p>`;
    if (err.status===401 || err.status===403) onError(err);
  });
}
