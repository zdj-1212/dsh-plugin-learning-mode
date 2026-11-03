# dsh-plugin-learning-mode

DeepSeek Harness 的「学习模式」插件：输入一句话，插件先问你几个关键问题（基础、时间、目标、偏好、卡点），再生成**专属**的完整学习资料 + 分阶段学习路线，并在当前会话里持续用学习模式回答。

## 功能

- `/learn <一句话主题>`：开启学习模式；先用 `ask_user_question` 了解你的实际情况，再生成专属学习资料与路线。
- `/learn`：查看当前学习主题和用法。
- `/learn off`：退出学习模式，恢复普通回答。
- 学习模式开启期间，每次模型请求都会带上学习规则：先讲直觉和例子、结尾给下一步、内容必须具体可执行。
- 主题按会话隔离，不同会话互不影响。

插件会先了解：当前基础、每天可投入时间、目标与期限、偏好学习方式、已有资源/环境、当前最大卡点。拿到回答后，会调整阶段数量、每阶段时长、资料难度、项目选题、练习量和复习节奏，而不是套用通用模板。

生成的学习资料包含：

1. 学习目标与知识地图
2. 分阶段学习路线（目标、时长、资料、练习、自测、通过标准）
3. 核心概念详解（定义、类比、可运行例子、常见误解）
4. 由易到难的实战项目
5. 资源清单（必看/选看/进阶）
6. 常见误区与避坑
7. 30/90 天复习计划与自检清单
8. 学完之后的进阶方向

如果模型有文件工具，还会把完整内容保存为当前工作区的 `学习资料/<主题>.md`。

## 安装

### 从 GitHub 安装

Web profile（CLI）：

```powershell
dsh plugin --profile web add github:zdj-1212/dsh-plugin-learning-mode
dsh web
```

Desktop App：

1. 打开 **插件 / Plugins** → 添加插件；
2. 安装来源填：

   ```text
   github:zdj-1212/dsh-plugin-learning-mode
   ```

   如果当前版本的界面只接受本地路径，就先 clone 仓库，再填 clone 后的目录绝对路径：

   ```powershell
   git clone https://github.com/zdj-1212/dsh-plugin-learning-mode.git
   ```

3. 安装后重启当前会话或客户端。

### 本地开发

在本地插件目录执行安装。Web profile 示例：

```powershell
dsh plugin --profile web add "<本地插件目录的绝对路径>"
dsh web
```

Desktop App 则在 Plugins 页面填写该插件目录的绝对路径。

安装后重启 Web profile。如果页面仍显示旧状态，按 `Ctrl+Shift+R` 强制刷新。

## 使用

```text
/learn 我想零基础 30 天学会 Python 数据分析
```

发送后，模型会先用 `ask_user_question` 问你最多 6 个问题；回答完后才会生成专属计划。计划开头会说明「这份计划为什么适合你」。

之后可以直接追问：

```text
第 2 阶段的数据清洗再讲细一点
```

换主题：

```text
/learn 我想 3 个月入门机器学习
```

退出：

```text
/learn off
```

## 持久化

学习模式的状态是**持久化**的：

- `/learn` 和 `/learn off` 会向当前会话日志追加一条完整的 `learning/mode` 事件；
- 插件注册了 `learning-mode` session projection，从日志折叠出 `{ active, topic }`；
- 会话恢复、fork、压缩和 Harness 重启后，主题和开关状态都会恢复；
- 如果命令在模型正在运行时执行，状态变更会先进入 pending，在下一个被接受的 `agent/pre-step` 边界写入日志，与 plan mode 使用同一个边界。

## 说明

- 插件只注册 host 端命令、系统提示词段和 session projection，不需要前端构建步骤。
- 不直接 import `@deepseek-ai/dsh-*` 运行时包，因此在 profile 的独立 `node_modules` 中也能加载。
- 依赖 DeepSeek Harness `0.2.1-rc.5` 及以上的 `commands`、`system-prompt`、`session-projection`、`agent` 服务。

## 目录

```text
dsh-plugin-learning-mode/
├─ package.json
├─ cordis.patch.yml     # 把插件插入 profile 配置树
├─ lib/index.js         # 插件实现
└─ README.md
```
