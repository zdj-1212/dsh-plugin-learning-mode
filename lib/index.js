/**
 * dsh-plugin-learning-mode — 学习模式 for DeepSeek Harness.
 *
 * `/learn <一句话主题>` does three things:
 *   1. records the topic in the session log (`learning/mode` event);
 *   2. makes every following request carry a learning-mode system section;
 *   3. submits one user message that asks the model for a complete study
 *      package (materials + staged roadmap), so one sentence is enough.
 *
 * `/learn off` leaves the mode. `/learn` alone shows the current topic.
 *
 * State is durable: a session projection folds `learning/mode` events, so the
 * mode and its topic survive turns, compaction, session resume and a Harness
 * restart. A change requested while a turn is open is queued and appended at
 * the next accepted pre-step, the same boundary plan mode uses.
 *
 * @module dsh-plugin-learning-mode
 */

import { randomUUID } from 'node:crypto'

/** Stable Cordis plugin name. */
export const name = 'learning-mode'

/** Prompt registry and the session projection registry. */
export const inject = ['systemPrompt', 'sessionProjections']

/** Prompt-section order: just after plan-mode policy (500), before team policy (600). */
const SECTION_ORDER = 550

/** Session projection key, namespaced so it cannot collide with another plugin. */
const STATE_KEY = 'learning-mode'

/** Log-only session event carrying the complete post-change state. */
const EVENT_TYPE = 'learning/mode'

/** The state when nothing has been recorded. Never mutated. */
const INACTIVE = Object.freeze({ active: false, topic: '' })

/** Session → the state selected while a turn is open, awaiting the next pre-step. */
const pendingIntents = new WeakMap()

const USAGE = [
  '用法：/learn <一句话主题>',
  '例如：/learn 我想零基础 30 天学会 Python 数据分析',
  '退出学习模式：/learn off',
].join('\n')

/** Words accepted after `/learn` to leave the mode. */
const OFF_WORDS = new Set(['off', 'stop', 'exit', 'quit', '关闭', '退出', '结束'])

/**
 * The projection's checkpoint schema. The registry only calls `.parse`, so a
 * small validator keeps this plugin free of runtime package imports.
 */
const learningStateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') {
      throw new TypeError('learning-mode state must be an object')
    }
    const { active, topic } = value
    if (typeof active !== 'boolean' || typeof topic !== 'string') {
      throw new TypeError('learning-mode state must be { active: boolean, topic: string }')
    }
    return { active, topic }
  },
}

/**
 * Fold the complete state carried by each `learning/mode` event. Unrelated
 * events return the same reference, as the projection registry requires.
 */
const learningProjection = {
  key: STATE_KEY,
  stateVersion: 1,
  stateSchema: learningStateSchema,
  init: () => ({ active: false, topic: '' }),
  apply: (state, event) => {
    if (event.type !== EVENT_TYPE) return state
    const data = event.data
    if (data === null || typeof data !== 'object') return state
    return {
      active: data.active === true,
      topic: typeof data.topic === 'string' ? data.topic : '',
    }
  },
}

/** Whether two whole states are equal. */
function sameState(a, b) {
  return a.active === b.active && a.topic === b.topic
}

/**
 * Build the same shape `createUserMessage` produces, without importing the
 * llm package: profile-installed plugins must not depend on the install
 * anchor being on Node's module path.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** The persistent system-prompt section shown while the mode is on. */
function policy(topic) {
  return [
    '## 学习模式（当前开启）',
    `当前学习主题：${topic}`,
    '',
    '你正在以「学习模式」和用户对话。请始终遵守：',
    '1. 循序渐进：先讲直觉和生活化类比，再给定义，再给最小可运行例子。',
    '2. 每次回答结尾给出「下一步」：接下来学什么、练什么，并说明它处于学习路线的哪个阶段。',
    '3. 内容具体可执行：给示例、练习和验收标准；不要只罗列链接或空泛建议。',
    '4. 用户偏离主线时，先用一两句话回答，再把问题挂回当前学习路线。',
    '5. 默认用中文回答，除非用户明确要求其他语言。',
    '6. 不要假设用户已经掌握前置知识；遇到依赖概念时先补一句解释。',
    '7. 制定或调整完整学习计划前，如果还不清楚用户的基础、每天可投入时间、目标和期限，先用 ask_user_question 问清楚；不要凭空假设。',
  ].join('\n')
}

/** The one-shot request submitted by `/learn <topic>`. */
function learningRequest(topic) {
  return [
    `我开启了「学习模式」。主题（我的一句话描述）：${topic}`,
    '',
    '在我回答完下面的问题之前，不要直接生成完整计划。',
    '请先使用 ask_user_question 工具一次性问我最多 6 个问题，了解我的实际情况；每题给出选项，并允许我自定义回答：',
    '1. 我目前的基础（零基础 / 学过一点 / 有相关经验 / 熟练）',
    '2. 我每天能投入多少时间（30 分钟 / 1-2 小时 / 3-4 小时 / 更多）',
    '3. 我的目标与期限（转行找工作 / 工作提升 / 考试 / 兴趣项目，以及希望多久达成）',
    '4. 我偏好的学习方式（视频 / 文档+动手 / 项目驱动 / 混合）',
    '5. 我已有的资源、工具或环境',
    '6. 我目前最大的卡点或最想先解决的问题',
    '如果 ask_user_question 不可用，就在聊天里逐条问我，等我回答后再继续。',
    '拿到回答后，再给我一份可以直接照着执行的完整学习资料 + 学习路线，不要只给目录、书单或空泛建议。',
    '',
    '用中文 Markdown 输出，严格包含以下部分：',
    '',
    `# ${topic} 学习资料`,
    '',
    '## 一、学习目标与知识地图',
    '- 用一句话说明它是什么、解决什么问题。',
    '- 学完后我能做到什么：3-5 条可验证的能力。',
    '- 知识地图：列出模块/概念及其依赖顺序，并说明先学什么、后学什么、为什么。',
    '',
    '## 二、分阶段学习路线',
    '按「第 1 阶段 … 第 N 阶段」组织。每个阶段必须包含：',
    '- 阶段目标（可验证，不要写「了解」「熟悉」这类无法检查的词）',
    '- 预计时长（天/小时）',
    '- 核心知识点（要展开讲，不要只列标题）',
    '- 学习资料（具体到书名+章节、官方文档页面、课程章节或视频；标明免费/付费和优先级）',
    '- 动手练习（题目 + 参考答案或验收标准）',
    '- 阶段自测（3-5 题）与通过标准',
    '- 常见卡点与解决方法',
    '',
    '## 三、核心概念详解',
    '挑出本主题最重要的 8-15 个概念，逐个讲解。每个概念包含：',
    '- 一句话定义',
    '- 为什么重要、什么时候会用到',
    '- 生活化类比',
    '- 最小可运行例子（代码/命令/图示，并给出预期输出）',
    '- 常见误解',
    '',
    '## 四、实战项目（由易到难）',
    '至少 3 个项目。每个包含：项目目标、需求清单、涉及知识点、验收标准、分步提示（不要直接贴完整答案）、进阶挑战。',
    '',
    '## 五、学习资源清单',
    '用表格列出：资源 | 类型（书/文档/课程/视频/社区）| 难度 | 免费或付费 | 推荐理由 | 优先级（必看/选看/进阶）。',
    '优先中文资源；没有把握的资源不要编造，标注「请自行搜索确认」。',
    '',
    '## 六、常见误区与避坑指南',
    '至少 5 条，每条说明「错误做法 → 为什么错 → 正确做法」。',
    '',
    '## 七、复习计划与自检清单',
    '- 每日/每周复习节奏',
    '- 30 天与 90 天复习节点分别复习什么',
    '- 一张可以打勾的掌握度自检清单',
    '',
    '## 八、学完之后往哪走',
    '- 进阶方向与相关领域',
    '- 可以继续挑战的项目或认证',
    '',
    '个性化要求：',
    '1. 根据我的回答调整阶段数量、每阶段时长、资料难度、项目选题、练习量和复习节奏；不要套用通用模板。',
    '2. 在开头用一小段说明「这份计划为什么适合我」，并指出我现有基础和目标的差距。',
    '3. 如果某个问题我跳过了，按保守假设处理，并明确标注「这是假设」。',
    '',
    '最后要求：',
    '1. 内容必须具体、可执行，每个知识点都要有解释和例子；拒绝空话。',
    '2. 涉及代码时，给出可运行的最小示例和预期输出。',
    '3. 全文结尾用 5 行以内总结「如果今天只做一件事，做什么」。',
    '4. 如果你有文件工具，请把这份完整资料保存为 Markdown 文件到当前工作区的 `学习资料/<主题>.md`（文件名去掉 Windows 非法字符），完成后告诉我文件路径。',
  ].join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Durable state: the registry folds `learning/mode` events from the session
  // log and checkpoints the result, so resume/fork/restart restore it.
  ctx.sessionProjections.register(learningProjection)

  /** The last committed state, or INACTIVE when the key is not registered. */
  const loggedState = session =>
    ctx.sessionProjections.stateOf(session, STATE_KEY) ?? INACTIVE

  /** What the next assembly should see: a pending selection wins over the log. */
  const selectedState = session => pendingIntents.get(session) ?? loggedState(session)

  /** Append the complete post-change state; the projection folds it eagerly. */
  const commit = (session, state) => {
    session.append(EVENT_TYPE, { active: state.active, topic: state.topic })
  }

  /** Whether the agent has an open turn (the append point is the pre-step then). */
  const hasOpenTurn = agent => {
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (boundary !== undefined) return boundary.openTurnStartSeq !== null
    return agent.status !== 'idle'
  }

  /**
   * Select a whole new state for one agent. Mirrors plan mode's boundary
   * discipline: between turns append now; during a turn queue the change for
   * the next accepted pre-step.
   *
   * @returns the action taken and the state that was selected before it.
   */
  const setMode = (agent, next) => {
    const session = agent.session
    const logged = loggedState(session)
    const current = selectedState(session)

    if (sameState(current, next)) return { outcome: 'noop', previous: current }
    if (hasOpenTurn(agent)) {
      pendingIntents.set(session, next)
      return {
        outcome: sameState(logged, next) ? 'cancelled' : 'queued',
        previous: current,
      }
    }
    if (sameState(logged, next)) {
      pendingIntents.delete(session)
      return { outcome: 'cancelled', previous: current }
    }

    commit(session, next)
    pendingIntents.delete(session)
    return { outcome: 'committed', previous: current }
  }

  ctx.systemPrompt.section({
    name: 'learning:policy',
    order: SECTION_ORDER,
    // The topic is user text: never treat `{{...}}` inside it as a prompt variable.
    interpolate: false,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      const state = selectedState(session)
      return state.active ? policy(state.topic) : ''
    },
  })

  // A selection made during an open turn is appended at the next accepted
  // pre-step, before that step's request is assembled.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    const pending = pendingIntents.get(agent.session)
    if (decision.kind === 'reject' || signal.aborted || pending === undefined) {
      return decision
    }
    try {
      commit(agent.session, pending)
      pendingIntents.delete(agent.session)
    } catch (error) {
      ctx.logger?.warn?.(
        'learning-mode: failed to append a mode change at step start: %o',
        error,
      )
    }
    return decision
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'learn',
      description: '学习模式：先了解你的情况，再定制完整学习资料 + 学习路线',
      input: { hint: '<一句话主题> | off' },
      handler: ({ agent, rawInput }) => {
        const input = (rawInput ?? '').trim()
        const current = selectedState(agent.session)

        if (input === '') {
          return {
            kind: 'success',
            text: current.active
              ? `当前学习模式主题：${current.topic}\n继续提问即可；换主题发送 /learn <新的一句话主题>，退出用 /learn off。`
              : USAGE,
          }
        }

        if (OFF_WORDS.has(input.toLowerCase())) {
          if (!current.active) {
            return { kind: 'success', text: `学习模式本来就是关闭的。\n${USAGE}` }
          }
          setMode(agent, INACTIVE)
          return {
            kind: 'success',
            text: `已退出学习模式（原主题：${current.topic}）。之后恢复普通回答；随时发送 /learn <主题> 重新开启。`,
          }
        }

        const result = setMode(agent, { active: true, topic: input })
        agent.steer(userMessage(learningRequest(input)))

        const pendingNote =
          result.outcome === 'queued' ? '（将在下一步生效）' : ''
        return {
          kind: 'success',
          text: `📚 学习模式已开启${pendingNote}：${input}\n请回答接下来的几个问题，我会按你的实际情况生成专属学习资料与路线…\n（换主题：/learn <新主题>；退出：/learn off）`,
        }
      },
    })

    commandCtx.logger?.info?.('[learning-mode] /learn command registered')
  })
}
