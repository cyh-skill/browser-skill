const HOST = 'com.cyh.browser_skill_group_cleaner';
const $ = (id) => document.getElementById(id);
let preview = null;
let busy = false;
const installCommand = `node native/install.mjs --extension-id ${chrome.runtime.id}`;
$('install-command').textContent = installCommand;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function updateButtons() {
  $('preview').disabled = busy;
  $('scope').disabled = busy;
  $('orphans').disabled = busy;
  $('clean').disabled = busy || !preview?.entityCount || !$('confirm').checked
    || (preview.requiresSync && !$('sync').checked);
}

function invalidate() {
  preview = null;
  $('result').hidden = true;
  $('confirm').checked = false;
  $('sync').checked = false;
  updateButtons();
}

async function native(message) {
  let response;
  try { response = await chrome.runtime.sendNativeMessage(HOST, message); }
  catch (error) {
    const missing = /not found|not supported|forbidden|nativeMessaging|sendNativeMessage/i.test(error.message);
    $('setup').hidden = !missing;
    throw new Error(missing ? '本地清理组件尚未就绪，请按下方说明安装并重新加载扩展。' : `本地组件连接失败：${error.message}`);
  }
  if (!response?.ok) throw new Error(response?.error || '本地组件没有返回有效结果。');
  $('setup').hidden = true;
  return response.result;
}

async function openGroupTitles() {
  const groups = await chrome.tabGroups.query({});
  return groups.map((group) => group.title || '');
}

function showLast(last) {
  $('last').hidden = !last;
  if (!last) return;
  const labels = { queued: '已排队', running: '执行中', complete: '清理完成', failed: '清理失败' };
  $('last-result').textContent = `${labels[last.state] || last.state}：${last.message || ''}`;
  $('backup').hidden = !last.backup;
  $('backup').textContent = last.backup ? `备份：${last.backup}` : '';
}

$('preview').addEventListener('click', async () => {
  invalidate();
  busy = true; updateButtons(); status('正在扫描已保存的标签组…');
  try {
    const result = await native({ action: 'preview', scope: $('scope').value, orphans: $('orphans').checked, openGroupTitles: await openGroupTitles() });
    preview = result;
    $('count').textContent = `${result.groups.length} 个分组待清理`;
    $('protected').textContent = `保留 ${result.protectedCount} 个打开的分组`;
    $('profile').textContent = `配置：${result.profile} · 孤立标签 ${result.orphanCount} 条 · 删除记录 ${result.entityCount} 条`;
    $('groups').replaceChildren();
    for (const group of result.groups) {
      const row = document.createElement('li');
      const title = document.createElement('span'); title.textContent = group.title || '未命名分组';
      const count = document.createElement('small'); count.textContent = `${group.tabCount} 个已保存标签`;
      row.append(title, count); $('groups').append(row);
    }
    $('empty').hidden = Boolean(result.entityCount);
    $('confirm-label').hidden = !result.entityCount;
    $('sync-label').hidden = !result.requiresSync || !result.entityCount;
    $('result').hidden = false;
    showLast(result.lastJob);
    status(result.entityCount ? '请核对预览，再确认清理。预览 5 分钟内有效。' : '当前没有需要清理的记录。');
  } catch (error) { invalidate(); status(error.message, true); }
  finally { busy = false; updateButtons(); }
});

$('clean').addEventListener('click', async () => {
  if ($('clean').disabled) return;
  busy = true; updateButtons(); status('正在准备备份与重启…');
  try {
    const result = await native({ action: 'clean', token: preview.token, confirmRestart: $('confirm').checked, syncAcknowledged: $('sync').checked, openGroupTitles: await openGroupTitles() });
    invalidate();
    status(`清理任务已启动（${result.jobId.slice(0, 8)}）。Chrome 即将重启，请稍候；重启后打开插件查看结果。`);
  } catch (error) { invalidate(); status(error.message, true); }
  finally { busy = false; updateButtons(); }
});

for (const id of ['scope', 'orphans']) $(id).addEventListener('change', () => { invalidate(); status('范围已更改，请重新扫描。'); });
for (const id of ['confirm', 'sync']) $(id).addEventListener('change', updateButtons);
$('copy-install').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(installCommand); status('安装命令已复制，请在 browser-skill 仓库目录执行。'); }
  catch { status('请手动选择并复制下方安装命令。'); }
});
// Opening the popup only reads the previous receipt; scanning and deletion require a click.
native({ action: 'status' }).then((result) => showLast(result.lastJob)).catch((error) => status(error.message, true));
