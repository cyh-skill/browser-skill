# Extension Provider

该 MV3 扩展连接 `ws://127.0.0.1:3458` 的 Rust Runtime，并通过 `chrome.debugger` 与 Chrome Extension API 提供：

- 每个 session 独立 Agent Window，首次创建时跟随最近聚焦的用户普通窗口尺寸、位置及最大化/全屏状态，并用带 `Agent · <session>` 标题的彩色标签组标记 Agent 创建页；最近聚焦的是 Agent 窗口时改用其他可见用户窗口，无用户窗口时采用浏览器默认尺寸，复用 session 时保留已有窗口布局；
- 用户已有标签页的页面内借用确认；
- managed ownership、session 收尾与稳定 `@eN`；
- AX 树、console/network 缓冲、普通交互、设备模拟与人工接管；
- 与 Direct CDP sidecar 的 `leaseCdp` / `resumeCdp` 精确交接。

## 加载

打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，指向本目录。重新加载扩展后运行 `browser-skill serve`，再检查 `/health` 中 `providers.extension.connected=true`。

扩展只连接 loopback；Rust WebSocket 服务拒绝非 `chrome-extension://` / `edge-extension://` Origin。`debugger` 与 `<all_urls>` 权限用于用户明确要求的托管页面，不应读取或传输未托管页面内容。

Chrome 会显示扩展正在调试页面的提示，这是 `chrome.debugger` 的正常行为。打开 DevTools 可能导致 debugger detach，Runtime 会将后续失败明确返回，不会伪装成功。

## 手动清理已保存的标签组

点击工具栏中的 **browser-skill bridge** 图标，选择范围并点击“扫描并预览”。默认清理名称以 `Agent · ` 开头且当前未打开的历史分组；也可选择所有已关闭的分组，包括个人分组。孤立标签记录可单独选择是否一起清理。所有正在打开的同名分组均受保护，未命名的打开分组也会保留；没有定时删除或启动自动删除。

Chrome 的公开扩展 API 不提供已保存分组数据库的删除接口，因此此功能使用可选的 Native Messaging 本地组件，**仅支持 macOS、单配置的标准 Google Chrome**，需要 Node.js 20+，不依赖 Rust Runtime 或 CDP。多配置、无痕窗口、配置歧义或无法退出 Chrome 时会停止执行。使用自定义 `--user-data-dir` 的浏览器不受支持，请勿为这类浏览器安装该组件。

在本仓库根目录执行一次（ID 可在 `chrome://extensions` 查看，弹窗也可复制含当前 ID 的命令）：

```bash
node native/install.mjs --extension-id <扩展ID>
```

安装器将固定版本的本地组件与依赖安装到 `~/.browser-skill/group-cleaner/`，仅允许指定扩展 ID 调用。随后在 `chrome://extensions` 重新加载扩展以启用新弹窗和 `nativeMessaging` 权限；有 Agent 正在执行时，先完成其浏览器步骤再重新加载。

预览只读取数据库，5 分钟内有效。核对待删除列表后，勾选重启确认；存在同步标记时，还需确认同一账号其他设备的对应分组可能一并删除。清理写入同步删除标记，但 Chrome 各版本接受该标记及云端最终同步结果无法保证，分组仍可能重新下载。

清理会退出整个 Chrome，使用 `--restore-last-session` 恢复窗口、标签页和打开的分组；请先保存表单等未提交工作。备份位于安装本地组件时所用的插件目录下 `data/group-cleaner/backups/`，已加入 Git 忽略规则；关闭前的窗口 URL 快照、任务状态与日志保存在 `~/.browser-skill/group-cleaner/`，仅当前用户可读。弹窗在重启后显示数据库删除校验与浏览器启动结果；这不代表所有页面内状态或云端同步已验收。退出后的记录发生变化时会中止删除并重新打开 Chrome，预览之外的新分组不会被加入删除范围。

每次写库前，完整复制当前配置的 `Sync Data/LevelDB` 到 `配置名-UTC时间戳` 目录。备份失败会停止清理；删除校验通过且 Chrome 恢复启动后，自动保留该配置最近 **3 份**完整备份（含本次），删除更早的备份。清理或重启失败时不轮换备份，以保留恢复文件；此时可能暂时超过 3 份，下一次成功清理时再收口。仅轮换符合命名规则且含 `CURRENT` 文件的真实目录，其他配置、手工命名目录、不完整副本和符号链接会保留。备份轮换失败时，弹窗显示具体原因，本次备份仍会保留。

如需恢复备份，先退出 Chrome，在仓库根目录执行下述命令，将路径替换成弹窗中显示的备份目录（只恢复标签组记录，不覆盖其他同步数据）：

```bash
npm ci --prefix native
node --input-type=module - '<备份目录>' <<'JS'
import { execFileSync } from 'node:child_process';
import { chromeProfile } from './native/cleaner.mjs';
import { restore } from './native/vendor/chrome-tab-group-cleaner/store.js';
try { execFileSync('/usr/bin/pgrep', ['-x', 'Google Chrome'], { stdio: 'pipe' }); throw new Error('请先退出 Chrome'); }
catch (error) { if (error.status !== 1) throw error; }
console.log(`恢复了 ${await restore(process.argv[2], chromeProfile().db)} 条标签组记录。`);
JS
```

本地组件验证：`npm ci --prefix native && npm test --prefix native`。测试使用临时真实 LevelDB，浏览器退出和启动使用替身，绝不关闭用户浏览器。
