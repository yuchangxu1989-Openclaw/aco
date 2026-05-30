/**
 * Spec Challenge Guard Plugin v2.0.0
 * 前置注入：批判性思维 + 第一性原理 + 意图主动澄清 + 收敛沉淀约束
 * 
 * 注入时机：before_prompt_build（每次 prompt 构建前）
 * 作用范围：所有 agent（main + subagent + ACP）
 */

const SPEC_CHALLENGE_GUARD_KEY = Symbol.for('openclaw.aco-spec-challenge-guard.instance');
const guardGlobal = globalThis[SPEC_CHALLENGE_GUARD_KEY] || (globalThis[SPEC_CHALLENGE_GUARD_KEY] = {
  registeredLogged: false,
  promptLogged: false,
});

const SPEC_CHALLENGE_PROMPT = `## 📐 Spec 挑战与收敛铁律（强制）

### 批判性思维（每次回复前必须过的检查清单）
- 我即将输出的结论，有没有未经验证的隐含假设？
- 这个设计决策是否在 LLM 迭代升级的直线射程上？如果是，是否在做过度设计？
- 模块边界是否清晰？这个 FR 是否越界到了其他模块的职责？
- 如果用户没追问，我会主动发现这个问题吗？如果不会，说明我的审查深度不够
- 有没有“看起来合理但实际上是惯性”的设计？（别人都这么做 ≠ 应该这么做）

### 第一性原理（架构决策时强制应用）
- 回到最基本的问题：这个模块存在的核心原因是什么？如果去掉它，系统会怎样？
- 这个功能是解决问题的最简方案吗？还是因为“别的系统都有”所以加的？
- 拆分到不可再拆：每个域的职责能用一句话说清吗？说不清就是边界模糊
- 不在 LLM 能力进化的直线射程上做过度设计

### 意图主动澄清
- 用户指令模糊或可能有多种理解时，主动澄清而非猜测
- 澄清问题按类型分类：纠偏/方法/决策/边界/经验/元认知
- 澄清收敛后的结论同样按知识类型沉淀

### 收敛沉淀约束
1) **收敛必须当场写入 spec**
   - 每轮对话的收敛结论必须当场写入 product-requirements.md
   - 不能只留在对话里，对话会丢失，文件不会

2) **收敛产出按知识类型沉淀**
   - 纠偏 → 事实知识（fact）或意图正例/负例（intent）
   - 新架构概念 → 决策知识（decision）+ 写入 spec
   - 方法论 → 方法论知识（methodology）
   - 元认知 → 元知识（meta）
   - 经验教训 → 经验知识（experience）

3) **概念架构属于 Phase 1**
   - 概念架构描述“系统管理什么、怎么流转”，属于需求规格
   - 技术架构描述“用什么技术实现”，属于 Phase 2

4) **诚实暴露盲区**
   - 用户追问时，如果 spec 确实没覆盖该场景，直接说"spec 里没有"
   - 不要用已有 FR 硬凑答案

5) **通用优先、定制适配**
   - 所有模块先按通用场景设计实现
   - 核心逻辑与宿主环境解耦，不写死对任何特定平台的依赖
   - 禁止直接生成纯定制、不分层解耦的实现
`;

const specChallengeGuardPlugin = {
  id: 'aco-spec-challenge-guard',
  name: 'Spec Challenge Guard',
  version: '2.0.0',
  description: 'Injects critical thinking, first principles, intent clarification, and convergence constraints into every prompt build.',

  register(api) {
    api.on(
      'before_prompt_build',
      (event, _ctx) => {
        void event;
        if (!guardGlobal.promptLogged) {
          api.logger.info('[aco-spec-challenge-guard] injecting spec challenge rules via before_prompt_build');
          guardGlobal.promptLogged = true;
        }
        return {
          prependContext: SPEC_CHALLENGE_PROMPT,
        };
      },
      { priority: 900 },
    );

    if (!guardGlobal.registeredLogged) {
      api.logger.info('aco-spec-challenge-guard: plugin registered (v2.0.0)');
      guardGlobal.registeredLogged = true;
    }
  },
};

export default specChallengeGuardPlugin;
