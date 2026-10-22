let deferredPrompt = null;
let initialized = false;
let installConfirmed = false;
let prompting = false;
let statusMessage = '';

function isStandalone() {
  return installConfirmed || window.matchMedia?.('(display-mode: standalone)').matches === true || navigator.standalone === true;
}

function currentState() {
  const installed = isStandalone();
  return {
    installed,
    canPrompt: Boolean(deferredPrompt) && !installed,
    status: installed ? '已在独立窗口中使用，或已完成安装。' : statusMessage,
  };
}

/** Public installation guidance contains no account or project information. */
export function renderInstallCard() {
  const state = currentState();
  return `<section class="pwa-card" data-pwa-card aria-label="手机桌面版">
    <div class="pwa-card-heading">
      <img src="/icons/apple-touch-icon.png" width="52" height="52" alt="" class="pwa-icon">
      <div><h2>手机桌面版</h2><p>添加到主屏幕后，轻点图标就能打开。</p></div>
      <span class="pwa-installed" data-pwa-installed${state.installed ? '' : ' hidden'}>已就绪</span>
    </div>
    <p class="pwa-intro">与网页版使用同一账号，共享项目和任务数据。无需前往应用商店，使用时需要联网。</p>
    <div class="pwa-actions"><button class="button primary" type="button" data-action="pwa-install"${state.canPrompt ? '' : ' hidden'}${prompting ? ' disabled' : ''}>${prompting ? '请在浏览器中确认…' : '安装到设备'}</button></div>
    <details class="pwa-instructions" data-pwa-instructions${state.installed ? ' hidden' : ' open'}>
      <summary>添加到手机桌面</summary>
      <div class="pwa-steps">
        <div><strong>iPhone / iPad</strong><p>用 Safari 打开网址，点「分享」→「添加到主屏幕」；如有「作为网页 App 打开」，请保持开启。</p></div>
        <div><strong>Android</strong><p>用手机浏览器打开网址，在菜单中选择「安装应用」或「添加到主屏幕」。具体名称因浏览器而异。</p></div>
      </div>
      <p class="pwa-footnote">在微信等应用内打开时，可先选择「在浏览器中打开」。没有安装选项时，也可以直接使用网页版。</p>
    </details>
    <p class="pwa-status" data-pwa-status role="status" aria-live="polite"${state.status ? '' : ' hidden'}>${state.status}</p>
  </section>`;
}

function syncInstallCards() {
  const state = currentState();
  document.querySelectorAll('[data-pwa-card]').forEach((card) => {
    const button = card.querySelector('[data-action="pwa-install"]');
    if (button) {
      button.hidden = !state.canPrompt;
      button.disabled = prompting;
      button.textContent = prompting ? '请在浏览器中确认…' : '安装到设备';
    }
    const badge = card.querySelector('[data-pwa-installed]');
    if (badge) badge.hidden = !state.installed;
    const instructions = card.querySelector('[data-pwa-instructions]');
    if (instructions) instructions.hidden = state.installed;
    const status = card.querySelector('[data-pwa-status]');
    if (status) {
      status.textContent = state.status;
      status.hidden = !state.status;
    }
  });
}

async function requestInstall() {
  if (!deferredPrompt || prompting) return;
  const prompt = deferredPrompt;
  prompting = true;
  statusMessage = '';
  syncInstallCards();
  try {
    // This call remains inside the user's click gesture. Browsers own the installation UI.
    await prompt.prompt();
    deferredPrompt = null;
    const choice = await prompt.userChoice;
    if (!installConfirmed) statusMessage = choice.outcome === 'accepted'
      ? '已确认安装请求，请等待浏览器完成。'
      : '已取消安装，仍可继续使用网页版。';
  } catch {
    deferredPrompt = null;
    statusMessage = '浏览器暂时无法发起安装，可按下方步骤添加到主屏幕。';
  } finally {
    prompting = false;
    syncInstallCards();
  }
}

export function initPWA() {
  if (initialized) return;
  initialized = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    statusMessage = '';
    syncInstallCards();
  });
  window.addEventListener('appinstalled', () => {
    installConfirmed = true;
    deferredPrompt = null;
    syncInstallCards();
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', syncInstallCards);
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-action="pwa-install"]')) void requestInstall();
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    // Only the generic offline page is cached. Account, API and project responses stay online-only.
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // The browser version remains usable when installation support is unavailable.
    });
  }
}
