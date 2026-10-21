# mybot Studio

[pymybot](../pymybot) 的跨平台桌面开发环境：编辑机器人结构（`.sql`）和动作脚本（`.mt` / `.lua`），检查、运行、查询、采样并画图，和智能体对话。

Studio 本身不执行任何机器人逻辑，只启动 pymybot：

- 一次性命令走 `python -m pymybot <command>`，读取它最后一行 JSON 结果；
- 常驻会话、实时采样、智能体多轮对话走 `python -m pymybot serve`（stdio JSON-RPC，协议见 pymybot README 的「serve 协议」一节）。

驱动加载、硬件访问、预算和超时、智能体工具权限都由 pymybot 负责，Studio 只是界面。

## 环境要求

- Node.js 20+（用于开发和打包）
- 已安装 pymybot 的 Python 解释器（需包含 `serve` 子命令）

## 快速开始

```bash
npm install
npm start          # 构建后启动
npm run dev        # 开发模式：Vite 热更新 + Electron
```

启动后点「打开工作区」，选择 pymybot 仓库或你自己的机器人项目目录。下次启动会自动打开上次的工作区。

Python 解释器默认按以下顺序查找：工作区里的 `.venv`、`venv`，再到 PATH 中的 `python3`（Windows 下是 `python`）。也可以在「设置」里手动指定，用「检测 pymybot」确认能用。

## 界面

**工具栏**

| 控件 | 作用 |
| --- | --- |
| 结构 / 动作 | 选择机器人结构（`.sql`）和动作脚本（`.mt` / `.lua`） |
| 检查 | `pymybot check`，错误显示在「问题」面板，点击可跳到对应行 |
| ▶ 运行（F5） | 运行动作脚本；会话激活时在会话里运行 |
| ■ 停止 | 取消正在执行的命令 |
| ⏻ 激活会话 / ⏏ 结束会话 | 激活一次机器人，之后运行、采样、热更新 SQL 都复用这个会话，结束时清理驱动 |
| 超时 | 单次执行的超时秒数 |
| 允许硬件 | 打开物理设备（`--allow-hardware`），执行前会弹出原生对话框再确认一次 |

编辑器基于 Monaco。Ctrl+S 保存并检查。

**底部面板**

| 面板 | 内容 |
| --- | --- |
| 问题 | 检查结果和错误位置 |
| 输出 | 运行结果；摄像头抓拍的图片直接显示 |
| 硬件 | 当前结构里的变量和驱动类型 |
| 查询 | 执行 SQL：无会话时用 `query` / `apply-sql`，会话激活时「应用到当前会话」（热更新） |
| 采样 | 对一个变量采样并画折线图。会话激活时支持「连续」采样：实时滚动窗口，可随时停止 |
| 智能体 | 多轮对话，展示工具调用和结果；「新对话」清空上下文。机器人会话激活时不可用 |
| 日志 | 每次调用的命令行或 serve 方法、耗时、stderr |

## 设置

| 项 | 对应参数 | 说明 |
| --- | --- | --- |
| Python 解释器 | — | 留空自动查找 |
| 模块路径 | `--module-path` | 每行一个，可写相对工作区的路径。显式指定会替换默认路径，必须同时包含 pymybot 自带的 `modules` 目录 |
| 图片源目录 | `--camera-src-dir` | 可选 |
| 模型 | `--model` | 留空用 `MYBOT_MODEL` 环境变量 |
| 端点 | `--base-url` | 留空用 `MYBOT_BASE_URL` 或厂商默认；只有 localhost 允许 HTTP |
| API Key 环境变量名 | `--api-key-env` | 只保存变量名，密钥要在启动 Studio 前设置到环境变量 |

设置保存在 Electron 用户数据目录下的 `settings.json`。

## 安全约定

- 允许硬件、允许智能体执行动作、智能体每次调用工具，都要在主进程的原生对话框里确认，渲染进程无法绕过。
- 请求里的文件路径都在主进程解析，并限制在工作区内。
- Studio 不读取、不保存 API Key 本身。
- 机器人会话和智能体对话同一时间只能开一个；会话进行中，一次性命令里需要占用机器人的那些会被拒绝。

## 开发

```bash
npm run typecheck  # 主进程与渲染进程类型检查
npm test           # vitest 单元测试（部分用例会调用真实 pymybot）
npm run e2e        # 构建后用 Playwright 驱动 Electron 跑冒烟测试
npm run dist       # electron-builder 打包：Linux AppImage / Windows NSIS / macOS dmg
```

单元测试和 e2e 默认使用同级目录 `../pymybot`，可以用 `PYMYBOT_REPO` 指定其他路径。e2e 截图输出到 `tests/e2e/out/`。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `MYBOT_STUDIO_WORKSPACE` | 启动时打开的工作区 |
| `MYBOT_STUDIO_USER_DATA` | 改用其他用户数据目录（测试用） |

目录结构：

```
electron/   主进程：pymybot 调用（pymybot.ts）、serve 客户端（serve.ts）、工作区与设置、IPC
shared/     主进程与渲染进程共用的类型
src/        渲染进程（React）：编辑器、文件树、各面板、图表
tests/      unit（vitest）与 e2e（playwright-core）
```

## 许可

MIT
