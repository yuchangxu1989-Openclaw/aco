# ACO - 产品需求规格说明书

OpenClaw(pm-01 子Agent)| 2026-05-06

---

## 目录

1. 产品愿景与定位
2. 目标用户画像
3. 核心概念
4. 功能需求(FR)
   - 域 A:任务生命周期
   - 域 B:派发治理
   - 域 C:资源池管理
   - 域 D:自动推进链
   - 域 E:可观测性与审计
   - 域 F:通知与 IM 推送
   - 域 G:健康与恢复
   - 域 H:配置与渐进式披露
   - 域 I:输出质量门禁
   - 域 J:插件基础设施
   - 域 Z:包分发与开箱体验
5. 非功能需求(NFR)
6. 概念架构
7. 与 Self-Evolving Harness 其他模块的边界
8. 约束与假设

---

## 1. 产品愿景与定位

ACO(Agent Controlled Orchestration)是面向多 Agent 协作场景的可控调度中枢。它把任务派发、并发治理、角色约束、失败恢复、自动推进、IM 通知和运行时可观测收拢到同一套可编程框架中,让 Agent 集群从"各自为战"升级为"协同可控"。

ACO 解决的核心问题:

- 多 Agent 并行执行时,缺乏统一的准入校验和角色约束,导致错派、越权、自审等治理漏洞。
- 任务完成后的下一步推进依赖主会话人肉盯盘,主会话阻塞期间用户消息被静默丢弃。
- 失败任务的重派策略散落在文档约束中,没有代码级强制执行,导致原样重派、资源浪费。
- Agent 资源池没有分级管理,无法根据任务复杂度自动选择合适梯队。
- 调度规则以自然语言写在 AGENTS.md 中,依赖模型遵从度,长上下文下容易被稀释。
- 任务状态变化(完成、失败、卡死)没有统一的用户通知机制,用户需要主动查看才能知道进展。

### 与现有基础设施的关系

ACO 是现有调度基础设施三件套的产品化封装与升级:

- **dispatch-guard**(Gateway 插件):派发治理--角色校验、LLM 语义分类、并发控制、ACP 全局上限。ACO 域 B 的能力来源。
- **run-watchdog**(Gateway 插件):超时保护、卡死检测、健康探测、idle-alert。ACO 域 A(超时)和域 G(健康恢复)的能力来源。
- **local-subagent-board.js**(CLI 脚本):任务看板、状态追踪、飞书通知推送、快照生成。ACO 域 E(可观测)和域 F(通知)的能力来源。

ACO 不是替代,是升级--把散落的本地定制脚本和插件统一为一个通用可分发的 npm 包。现有三件套的所有能力在 ACO 中保留并增强,新增的能力包括:声明式推进链、梯队路由、渐进式配置、跨宿主适配。

对于已在使用三件套的环境,`npx aco init` 会自动检测现有 dispatch-guard 和 run-watchdog 配置,生成等价的 ACO 配置文件,实现无感迁移。迁移后原有插件可停用,ACO 接管全部调度职责。

ACO 以 npm 包形式分发,`npx aco init` 一条命令完成环境初始化。单 Agent 用户获得基础调度能力(超时保护、失败重试、任务看板、IM 通知),多 Agent 用户获得完整治理能力(角色约束、梯队路由、并发控制、自动推进链)。

ACO 负责运行时调度与治理,不负责研发流程编排(SEVO)、知识管理(KIVO)或效果监测(AEO)。ACO 是 Self-Evolving Harness 的第四条腿--KIVO 管知识、SEVO 管研发流程、AEO 管效果运营、ACO 管调度治理。四者平级,通过明确的接口边界协作。

设计硬约束:

- 调度规则必须代码级强制执行,不依赖模型遵从度。
- 治理约束在派发前拦截,不在执行后补救。
- 核心逻辑与宿主环境解耦,不绑定特定 Agent 池、角色名或平台实现。
- 单 Agent 也能用,多 Agent 获得完整治理--渐进式披露,不强制全量配置。
- 可观测性内建,任务状态、调度决策、资源利用率实时可查。
- 通知渠道可插拔,用户配置一次后所有状态变化自动推送。

### 成功指标

- 调度违规拦截率 >= 99%(不合规派发在执行前被阻断的比例)。
- 任务失败自动恢复率 >= 80%(失败任务通过自动重派/拆分成功完成的比例)。
- 主会话空闲率 >= 95%(主会话处于可接收用户消息状态的时间占比)。
- 资源利用率 >= 70%(Agent 池中 Agent 处于执行状态的时间占比)。
- 首次调度体验完成时间 <= 5 分钟(空环境用户从安装到看到第一个任务被调度执行)。
- 通知送达率 >= 99%(任务状态变化事件成功推送到用户配置的 IM 渠道的比例)。

---

## 2. 目标用户画像

### 2.1 Solo Founder / 独立产品操盘者

用 Agent 推进产品研发和运营。拥有 2-5 个 Agent,需要它们各司其职且紧密咬合。关心任务是否被正确派发、失败是否被及时处理、进度是否实时可见。上手路径:`npm install -g aco-orchestrator && npx aco init`,5 分钟内看到第一个任务被调度执行并完成。核心诉求:配置飞书/Telegram 后,任务完成自动收到通知,不用盯着终端。

### 2.2 Agent 系统管理员

管理 10+ Agent 的集群。需要统一的资源池视图、并发控制、梯队分级和健康监控。需要知道哪个 Agent 在忙、哪个空闲、哪个卡死、哪个频繁失败。上手路径:`aco status` 一览全局,`aco pool` 查看资源池状态。核心诉求:异常告警实时推送,不用轮询检查。

### 2.3 Agent 开发者

构建和维护 Agent 系统。需要可编程的调度规则,能通过配置或代码定义角色约束、路由策略和推进链。需要调度审计日志来排查问题。上手路径:`aco rule list` 查看当前规则集,`aco rule add` 添加自定义规则。

### 2.4 宿主平台集成方

提供不同的 Agent 执行环境(OpenClaw、其他 ACP harness、自建平台)。需要接入一套通用调度框架,而不是被迫接受某个宿主的私有实现。需要核心逻辑与运行时解耦,便于替换执行器和通知渠道。上手路径:`npm install aco-orchestrator`,通过 Adapter 接口对接自有执行环境。

---

## 3. 核心概念

### 3.1 核心对象类型

- **Task**:ACO 管理的最小调度单元。包含 taskId、label、agentId、prompt、timeout、priority、status、创建时间、完成时间、产出摘要、重试计数。
- **Agent Slot**:资源池中的一个 Agent 执行位。包含 agentId、tier、runtime type(subagent/acp)、当前状态(idle/busy/stale/offline)、角色标签、累计完成数、失败率。
- **Dispatch Rule**:派发治理规则。包含 ruleId、匹配条件(prompt pattern / task type / agent filter)、动作(allow/block/warn/route)、优先级。
- **Completion Chain**:自动推进链定义。描述"A 完成后自动触发 B"的因果关系,包含触发条件、目标动作、参数模板。
- **Audit Event**:调度审计事件。记录每次派发决策的完整上下文--时间、规则命中、决策结果、agentId、taskId。
- **Health Probe**:Agent 健康探针。定期检测 Agent 是否存活、是否卡死、资源占用是否异常。
- **Task Board**:任务看板。所有 Task 的实时状态聚合视图,支持按状态、Agent、优先级筛选。
- **Tier**:Agent 梯队分级。Tier 数字越小 = 能力越强 = 成本越高(T1 最强,T4 最弱)。按能力和成本将 Agent 分为多个梯队,任务失败时可自动升级到更高梯队(T4 → T3 → T2 → T1)重试。
- **Role Tag**:角色标签。标记 Agent 的职能(coder/auditor/architect/pm/ux),用于角色-任务匹配校验。
- **Notification Channel**:通知渠道。抽象的消息推送目标,支持飞书、Telegram、Discord、Slack、Webhook 等。

### 3.2 任务状态模型

Task 的生命周期状态:

- **queued**:已入队,等待派发。按 priority 排序,高优先级先调度。
- **dispatching**:正在执行派发前校验(规则匹配、资源检查)。
- **running**:已派发到 Agent,正在执行。
- **succeeded**:Agent 报告完成且通过实质成功校验(产出有效)。
- **failed**:Agent 报告失败、超时、或实质成功校验未通过。
- **retrying**:失败后等待重派(升级梯队或拆分后重新入队)。
- **cancelled**:用户主动取消或系统熔断取消。

合法状态转换:

- queued -> dispatching -> running -> succeeded
- queued -> dispatching -> running -> failed -> retrying -> dispatching(重派循环)
- running -> failed(超时/异常)
- retrying -> failed(重试次数耗尽)
- 任意非终态 -> cancelled

关键约束:retrying 状态的任务必须被重新选中并派发,不能停滞。队列消费选取候选任务时,同时扫描 queued 和 retrying 状态。

### 3.3 优先级模型

- 优先级为整数,范围 0-100,数值越大优先级越高。
- 默认优先级 50。
- 队列消费选取任务时,按 priority 降序排列,同优先级按入队时间升序(FIFO)。
- 用户可在创建任务时指定优先级,也可通过 CLI 调整已入队任务的优先级。
- 推进链自动生成的任务继承父任务的优先级。

---

## 4. 功能需求(FR)

### 域 A:任务生命周期(Task Lifecycle)

负责任务从创建到终态的全生命周期管理。

#### FR-A01:任务创建与入队

通过 API 或 CLI 创建任务并加入调度队列。

- AC1:创建任务时必须提供 label、prompt、timeout;agentId 和 priority 可选(缺省时由路由规则自动填充)。
- AC2:任务创建成功后立即进入 queued 状态并触发队列消费事件,系统立即尝试派发。
- AC3:创建时可指定 completion chain(完成后触发的后续动作),chain 定义写入任务元数据。
- AC4:重复创建相同 label + prompt 的任务时,系统返回幂等警告但不阻断(允许用户有意重试)。

#### FR-A02:任务状态流转

任务按状态模型(§3.2)严格流转,非法转换被拒绝。

- AC1:每次状态变更写入 Audit Event,包含变更时间、触发原因、操作者(系统/用户)。
- AC2:非法状态转换(如 succeeded -> running)被拒绝并记录违规事件。
- AC3:终态(succeeded / failed-exhausted / cancelled)不可逆,任何尝试修改终态任务的操作返回错误。
- AC4:状态变更触发对应的 Notification Channel 推送(若用户已配置)。

#### FR-A03:超时保护

运行中的任务超过 timeout 后自动标记失败。

- AC1:系统通过 `session:timeout` 事件监测超时,超过 timeoutSeconds 的任务自动转为 failed,失败原因标记为 timeout。
- AC2:超时阈值从任务创建时的 timeout 字段读取,不存在全局默认值时使用 600s。
- AC3:超时触发后,系统尝试向执行 Agent 发送 kill 信号(best-effort,不保证 Agent 响应)。
- AC4:超时事件写入 Audit Event 并触发通知。
- AC5:timeout 值有可配置的下限(默认 300 秒),低于下限的任务创建被拒绝并返回错误,防止过短超时导致任务被误杀。

#### FR-A04:实质成功校验

任务报告完成后,校验产出是否有效(防止空跑假完成)。

- AC1:Agent 报告 succeeded 后,系统检查 output_tokens 是否高于可配置阈值(默认 3000)。
- AC2:若任务 prompt 中指定了产出文件路径,系统检查该文件是否存在且非空。
- AC3:校验未通过的任务状态转为 failed,失败原因标记为 substantive_failure。
- AC4:校验规则可通过配置扩展(自定义校验函数),默认规则开箱可用。

#### FR-A05:任务取消

用户或系统可主动取消非终态任务。

- AC1:CLI 命令 `aco task cancel <taskId>` 将任务转为 cancelled 状态。
- AC2:running 状态的任务被取消时,系统向执行 Agent 发送 kill 信号。
- AC3:批量取消支持按 label pattern 或 agentId 筛选。
- AC4:取消事件写入 Audit Event 并触发通知。

---

### 域 B:派发治理(Dispatch Governance)

负责在任务派发前执行准入校验,拦截不合规的调度决策。

#### FR-B01:角色-任务匹配校验

派发前校验目标 Agent 的 Role Tag 是否匹配任务类型。

- AC1:每个 Dispatch Rule 可定义 role 约束(如"审计任务只能派给 auditor 角色")。
- AC2:角色不匹配时,派发被阻断,事件写入 Audit Event,状态保持 queued。
- AC3:规则支持 allow/block/warn 三种动作:block 阻断、warn 放行但记录告警、allow 显式放行。
- AC4:无匹配规则时默认放行(开放策略),用户可切换为默认阻断(封闭策略)。
- AC5:任务类型通过 LLM 语义分类自动确定。系统调用 LLM 对 task prompt 进行语义分析,输出任务类型标签(如 spec / ac / code / audit / ux / readme / data-ops)。分类结果与目标 Agent 的角色标签比对,不匹配则触发 AC2 阻断逻辑。
- AC6:任务类型分类策略按优先级降序:声明式标注(调用方显式指定 taskType)> LLM 语义分类(自动推断)> 默认 fallback(放行)。LLM 分类使用宿主环境配置的默认模型,单次分类延迟 <= 2 秒。
- AC7:特殊任务类型 `data-ops` 具有全角色可执行语义--匹配到 data-ops 类型的任务跳过角色校验,直接放行。

#### FR-B02:自审禁止

禁止开发 Agent 审计自己的产出。

- AC1:系统自动检测任务的"产出者"和"审计者"是否为同一 agentId,相同则阻断。
- AC2:产出者信息从 completion chain 的父任务中提取(父任务的 agentId = 产出者)。
- AC3:阻断时自动路由到同角色的其他 Agent;若无可用替代,任务保持 queued 并告警。
- AC4:自审检测覆盖直接派发和 completion chain 自动触发两种场景。

#### FR-B03:并发控制

限制同一 Agent 同时执行的任务数量。

- AC1:每个 Agent Slot 有 maxConcurrency 配置(默认 1),超出时新任务排队等待。
- AC2:队列消费选取任务时,跳过已达并发上限的 Agent。
- AC3:并发限制可按 Agent 粒度配置,也可按 Tier 粒度设置默认值。
- AC4:达到并发上限时,系统记录排队事件但不告警(正常行为)。
- AC5:支持按 runtime type 设置全局并发上限(如 ACP 类型总并发 <= N,默认 8)。ACP 进程占用独立内存(150-300MB/个),全局上限防止内存溢出。全局上限独立于 per-Agent 的 maxConcurrency,两者取较严值。

#### FR-B04:规则热更新

运行时修改 Dispatch Rule 无需重启服务。

- AC1:CLI 命令 `aco rule add/remove/update` 立即生效,下一次派发决策使用新规则。
- AC2:规则变更写入 Audit Event,包含变更前后的 diff。
- AC3:规则支持从配置文件批量加载(`aco rule load <file>`),文件格式为 YAML 或 JSON。
- AC4:规则冲突(同一任务匹配多条规则)按优先级排序,最高优先级规则生效。

#### FR-B05:熔断机制

当某 Agent 连续失败达到阈值时,自动暂停向其派发任务。

- AC1:连续失败次数达到可配置阈值(默认 3)时,Agent Slot 状态转为 offline。
- AC2:熔断触发后,该 Agent 的 queued 任务自动路由到同 Tier 其他 Agent。
- AC3:熔断状态持续可配置时长(默认 5 分钟)后自动恢复为 idle,允许探测性派发。
- AC4:熔断事件写入 Audit Event 并触发高优先级通知。

#### FR-B06:动态角色发现(Dynamic Role Discovery)

dispatch-guard 从宿主配置动态读取 Agent 列表和角色映射,禁止硬编码 Agent ID。

- AC1:支持宿主配置(如 openclaw.json agents.list)中的可选 `role` 字段,合法值为 `"coding" | "pm" | "architecture" | "review" | "ux" | "research"`。
- AC2:启动时从宿主配置动态构建 ROLE_AGENTS(角色→Agent 列表映射)和 ROLE_TASK_MAP(任务类型→允许角色映射),禁止在代码中硬编码任何 Agent ID。
- AC3:无 role 声明时的渐进式降级--单 Agent 模式:跳过角色匹配,所有任务允许派发;多 Agent 无 role 声明:warn 模式,记录日志但不拦截;有 role 声明:enforce 模式,拦截角色不匹配的派发。
- AC4:AGENT_TIER 支持从配置显式声明或根据 runtime.type 自动推断(acp 类型推断为 T1-T3,subagent 类型推断为 T4),显式声明优先于自动推断。
- AC5:配置变更后自动刷新角色映射和梯队信息(利用宿主环境的 config watcher 机制或 ACO 自身的 FR-H02 配置热加载能力),无需重启服务。
- AC6:动态构建的映射关系写入启动日志,便于排查角色匹配问题。

#### FR-B07:LLM 任务分类器语义覆盖

LLM 分类器的 prompt 覆盖所有角色的实际工作范围,分类结果与角色允许范围语义一致。

- AC1:任务类型定义必须覆盖每个已注册角色的全部工作范围--coding 覆盖编码、重构、测试、修复;architecture 覆盖分析、方案设计、评审、选型、契约定义;pm 覆盖需求分析、规格撰写、优先级排序;review 覆盖代码审计、质量检查、安全审查;ux 覆盖视觉验证、交互评审、可用性测试;research 覆盖调研、分析、报告撰写。
- AC2:分类器 prompt 中的任务类型定义必须与 ROLE_TASK_MAP 的允许范围语义一致--当 ROLE_TASK_MAP 因动态角色发现(FR-B06)更新时,分类器 prompt 同步更新。
- AC3:分类失败(LLM 超时、不可用、返回无法解析的结果)时 fallback 到 warn 模式--放行派发但记录告警日志,不硬拦截。
- AC4:分类结果写入 Audit Event(已有 dispatch-guard-events.jsonl 机制),包含原始 prompt 摘要、分类结果、置信度(若模型提供)、命中的角色匹配规则。
- AC5:支持分类结果缓存--相同 prompt pattern 的任务在可配置时间窗口内(默认 5 分钟)复用上次分类结果,减少 LLM 调用开销。

---

### 域 C:资源池管理(Resource Pool)

负责 Agent 资源的注册、分级、状态追踪和路由选择。

#### FR-C01:Agent 注册与发现

自动发现宿主环境中的 Agent 并注册到资源池。

- AC1:`aco init` 时自动扫描宿主环境的 Agent 配置(如 openclaw.json 的 agents.list),生成初始资源池。
- AC2:手动注册支持 CLI(`aco pool add <agentId> --tier T2 --role coder`)。
- AC3:注册信息包含 agentId、tier、role tags、maxConcurrency、runtime type。
- AC4:Agent 配置变更时(宿主环境热更新),资源池自动同步(通过 config watcher 或手动 `aco pool sync`)。

#### FR-C02:梯队路由

根据任务复杂度自动选择合适梯队的 Agent。

- AC1:任务创建时可指定目标 Tier;未指定时,系统根据 prompt 长度和 timeout 推断默认 Tier。
- AC2:同 Tier 内多个 Agent 可用时,按负载均衡策略选择(默认:最少活跃任务优先)。
- AC3:指定 Tier 无可用 Agent 时,自动升级到更高 Tier(T4 -> T3 -> T2 -> T1)。
- AC4:梯队路由决策写入 Audit Event,包含候选列表和最终选择原因。

#### FR-C03:失败梯队升级

任务失败后自动升级到更高梯队重试。

- AC1:任务失败且重试次数未耗尽时,自动将目标 Tier 升一级并重新入队。
- AC2:已在最高 Tier(T1)失败的任务不再升级,标记为 failed-exhausted。
- AC3:升级时保留原始 prompt,可选追加失败上下文(上次失败原因)到新 prompt。
- AC4:梯队升级路径和每次尝试的结果记录在任务元数据中,支持事后分析。

#### FR-C04:资源池状态视图

提供 Agent 资源池的实时状态概览。

- AC1:CLI 命令 `aco pool status` 展示每个 Agent 的当前状态、活跃任务数、累计完成数、失败率。
- AC2:支持按 Tier、Role、状态筛选。
- AC3:状态数据实时更新(基于任务状态变更事件),不依赖定时轮询。
- AC4:输出格式支持 table(终端友好)和 JSON(程序消费)。

---

### 域 D:自动推进链(Completion Chain)

负责任务完成后自动触发后续动作,实现流水线式编排。

#### FR-D01:链式触发

任务成功完成后,自动创建并派发后续任务。

- AC1:Completion Chain 定义支持"A 完成后触发 B"的声明式配置。
- AC2:触发时,后续任务的 prompt 可引用父任务的产出(通过模板变量 `{{parent.output}}`、`{{parent.files}}`)。
- AC3:后续任务继承父任务的 priority,可通过 chain 配置覆盖。
- AC4:链式触发在父任务状态变为 succeeded 后同步执行(在同一个事件处理周期内完成入队)。
- AC5:支持条件循环链(loop chain)--当后续任务的产出结论为负面(如审计不通过)时,自动触发修复任务,修复完成后重新触发原审计任务,循环直到通过或达到最大循环次数(可配置,默认 3)。区分"任务执行失败"(进入 onFailure 分支)和"任务产出结论为负面"(进入 loop chain)两种场景。

#### FR-D02:条件触发

根据父任务的产出内容决定是否触发后续动作。

- AC1:Chain 定义支持 condition 字段,基于父任务产出的结构化数据做布尔判断。
- AC2:条件表达式支持基础比较(==、!=、>、<)和逻辑组合(AND、OR、NOT)。
- AC3:条件不满足时,chain 跳过该步骤并记录跳过原因到 Audit Event。
- AC4:条件评估失败(表达式错误)时,chain 暂停并告警,不静默跳过。

#### FR-D03:失败分支

任务失败时触发不同的后续动作(区别于成功路径)。

- AC1:Chain 定义支持 onFailure 分支,与 onSuccess 分支独立配置。
- AC2:onFailure 分支可配置"拆分重试"(将原任务拆为多个子任务)或"升级通知"(告警人工介入)。
- AC3:失败分支触发时,系统自动将失败上下文(错误信息、失败原因)注入后续任务的 prompt。
- AC4:未配置 onFailure 分支时,默认行为为梯队升级重试(FR-C03)。

#### FR-D04:链路可视化

展示 Completion Chain 的执行路径和当前进度。

- AC1:CLI 命令 `aco chain status <chainId>` 展示链路中每个节点的状态(pending/running/succeeded/failed/skipped)。
- AC2:输出包含每个节点的执行时间、agentId、产出摘要。
- AC3:支持查看历史已完成的 chain 执行记录。
- AC4:输出格式支持 tree(终端友好)和 JSON(程序消费)。

---

### 域 E:可观测性与审计(Observability & Audit)

负责调度决策的全链路记录和运行时状态的实时可查。

#### FR-E01:调度审计日志

记录每次派发决策的完整上下文。

- AC1:每次派发决策生成一条 Audit Event,包含时间戳、taskId、候选 Agent 列表、命中规则、最终决策、决策原因。
- AC2:审计日志持久化到本地文件(JSONL 格式),支持按时间范围和 taskId 查询。
- AC3:CLI 命令 `aco audit query --from <time> --to <time> --task <taskId>` 查询审计日志。
- AC4:审计日志保留时长可配置(默认 30 天),过期自动清理。

#### FR-E02:任务看板

提供所有任务的实时状态聚合视图。

- AC1:CLI 命令 `aco board` 展示当前所有非终态任务的状态、agentId、已运行时长、优先级。
- AC2:支持按状态(queued/running/failed)、agentId、priority 筛选。
- AC3:看板数据基于内存状态实时生成,不依赖定时快照。
- AC4:输出格式支持 table 和 JSON。
- AC5:看板支持 watch 模式(`aco board --watch`),每 5 秒刷新一次。

#### FR-E03:资源利用率统计

统计 Agent 池的利用率和效率指标。

- AC1:统计指标包含:每个 Agent 的忙碌率、平均任务耗时、失败率、梯队升级次数。
- AC2:统计周期支持 1h / 24h / 7d,CLI 命令 `aco stats --period 24h`。
- AC3:利用率 = Agent 处于 busy 状态的时间 / 统计周期总时间。
- AC4:统计数据基于 Audit Event 聚合计算,不引入额外存储。

#### FR-E04:决策溯源

对任意任务,可追溯其完整调度历史。

- AC1:CLI 命令 `aco task history <taskId>` 展示该任务从创建到终态的所有状态变更和调度决策。
- AC2:每条记录包含时间戳、状态变更、触发原因、关联的 Audit Event ID。
- AC3:若任务经历过重试,展示每次尝试的 agentId、Tier、耗时、失败原因。
- AC4:输出支持 JSON 格式,便于程序化分析。

---

### 域 F:通知与 IM 推送(Notification)

负责将任务状态变化和系统事件推送到用户配置的 IM 渠道。

#### FR-F01:通知渠道注册

用户配置 IM 通知渠道,系统自动推送状态变化。

- AC1:支持飞书、Telegram、Discord、Slack、通用 Webhook 五种渠道类型。
- AC2:CLI 命令 `aco notify add --type feishu --config <json>` 注册渠道,配置包含认证凭据和目标地址。
- AC3:注册后立即发送测试消息验证连通性,失败时提示具体错误原因。
- AC4:支持多渠道并行推送(同一事件推送到所有已注册渠道)。
- AC5:`aco init` 执行时自动检测宿主环境已配置的 IM 渠道,对已存在的渠道自动注册为通知目标,无需用户手动 `aco notify add`。
- AC6:若宿主环境无已配置渠道,`aco init` 输出提示信息告知用户如何手动注册,不阻塞 init 流程。

#### FR-F02:事件订阅过滤

用户可配置哪些事件触发通知,避免信息过载。

- AC1:支持按事件类型过滤:task_succeeded、task_failed、task_timeout、circuit_break、chain_completed。
- AC2:支持按优先级过滤:只推送 priority >= N 的任务事件。
- AC3:支持按 agentId 过滤:只关注特定 Agent 的事件。
- AC4:默认订阅 task_failed 和 circuit_break(关键异常),用户可调整。
- AC5:支持按 task label 模式排除:配置 `excludeLabels` 列表,匹配前缀或正则表达式的事件跳过通知。默认排除 `healthcheck`、`heartbeat`。
- AC6:支持按任务来源过滤:区分 subagent、acp、system、main 四种来源类型,用户可配置只通知特定来源(默认通知 subagent + acp,排除 system 和 main session)。

#### FR-F03:通知内容模板

推送消息包含结构化的任务上下文,用户无需回到终端查看详情。

- AC1:通知消息包含:taskId、label、状态变更、agentId、耗时、失败原因(如有)。
- AC2:成功通知包含产出摘要(前 200 字符或文件路径列表)。
- AC3:失败通知包含失败原因和建议的下一步操作(如"已自动升级梯队重试")。
- AC4:通知模板可自定义(Handlebars 语法),默认模板开箱可用。

#### FR-F04:通知送达确认

追踪通知是否成功送达,失败时重试。

- AC1:每条通知记录送达状态(sent/delivered/failed),持久化到本地存储。
- AC2:送达失败时自动重试(最多 3 次,间隔指数退避)。
- AC3:连续送达失败超过阈值时,标记渠道为 degraded 并告警。
- AC4:CLI 命令 `aco notify status` 查看各渠道的送达率和最近失败记录。
- AC5:CLI 命令 `aco notify test` 向所有已注册渠道发送测试消息,输出每个渠道的送达结果(成功/失败+原因)。
- AC6:`aco init` 完成渠道注册后自动执行一次 `notify test`,验证通知链路端到端可用。失败时输出诊断信息但不阻塞 init。

#### FR-F05:任务完成即时通知

子 Agent / ACP 任务完成时自动推送通知到用户已注册的 IM 渠道,开箱即用无需额外配置。

- AC1:监听 Gateway 任务完成事件(session:complete),提取 agentId、task label、成功/失败状态、耗时四个字段,组装通知消息并推送。
- AC2:通知发送采用异步 fire-and-forget 语义--发送失败仅写 warn 日志,不抛错、不阻塞任务完成流程、不影响推进链触发。
- AC3:`aco init` 完成且至少注册一个通知渠道后,任务完成通知默认启用,无需额外订阅配置。
- AC4:默认通知格式:`✅ [agentId] label | 耗时` 或 `❌ [agentId] label | 耗时(失败)`。用户可通过 FR-F03 模板机制自定义格式。
- AC5:耗时计算从任务创建(dispatching)到完成(succeeded/failed)的实际时长,精度到秒。
- AC6:通知渠道复用 FR-F01 注册的 Transport 抽象,不绑定特定 IM 平台。飞书渠道通过 Transport 适配层调用 lark-cli 或 Lark API 实现。
- AC7:单次通知发送超时上限 10 秒,超时后放弃本次发送(不阻塞后续流程)。
- AC8:通知模块注册的事件监听名称必须来自宿主环境已声明的事件列表。注册事件监听时自动校验事件名合法性,不合法则报错并提示可用事件列表。
- AC9:`aco notify status` 输出中包含"事件监听状态"字段,显示每个已注册事件监听是否被宿主环境正常加载并处于活跃监听状态。

废弃说明:本 FR 实现后,独立的 `completion-notify` 插件(`/root/.openclaw/extensions/completion-notify/`)应废弃并移除。其全部能力由 ACO 域 F 统一承载。

#### FR-F06:任务闭环保障(Closure Guard)

子 Agent 任务完成后,插件在 completion event 到达主会话时注入提醒到主会话上下文,逼主会话自行向用户发送人话总结。若主会话在规定时间内完成发送则记录闭环成功,否则记录审计事件,不发送任何用户可见通知。

背景:主会话收到 completion event 后应向用户发送结论摘要,但 L6 prompt 规则在长上下文下容易被稀释,导致通知遗漏。本 FR 在 L2 插件层通过 `before_prompt_build` hook 注入不可忽略的提醒文本,提升主会话的闭环执行率。

- AC1:任务完成事件(succeeded 或 failed)触发后启动闭环计时器,倒计时时长通过配置项 `closureGuard.timeoutSeconds` 指定,默认 120 秒。
- AC2:计时期间监听用户可见渠道(已注册的 FR-F01 Transport)的出站消息。若检测到主会话通过任一已注册渠道发送了包含该任务 taskId 或 label 的消息,视为闭环成功,取消计时器。
- AC3:计时器到期且未检测到闭环消息时,记录审计事件(closure_missed),不发送任何用户可见通知。
- AC4:闭环保障的核心机制是通过 `before_prompt_build` hook 在 completion event 到达主会话时注入不可忽略的提醒文本,要求主会话执行总结发送。提醒只注入到主会话上下文,不发给用户。
- AC5:闭环保障默认对所有任务启用。支持通过配置项 `closureGuard.excludeLabels` 排除特定 label 模式(前缀或正则),排除的任务不启动闭环计时器。
- AC6:闭环保障作为 L2 插件层能力运行,在 Gateway 事件循环中独立于主会话上下文执行。主会话崩溃、超时或上下文被截断不影响闭环审计的记录。
- AC7:闭环超时后记录审计事件(类型 `closure_missed`),包含 taskId、label、agentId、等待时长、触发原因(主会话未在规定时间内发送总结)。审计事件可通过 `aco audit list --type closure_missed` 查询。
- AC8:配置项 `closureGuard.enabled` 控制全局开关,默认 true。设为 false 时所有闭环计时器不启动,等价于功能关闭。
- AC9:闭环检测通过 HostAdapter 接口的出站消息检测能力判断主会话是否已发送总结,不硬编码特定 IM SDK 调用方式。不同宿主环境通过实现 `detectOutboundMessage` 接口适配。
- AC10:`aco init` 生成的默认配置中 `closureGuard` 段已包含合理默认值(enabled: true, timeoutSeconds: 120, excludeLabels: ["healthcheck", "heartbeat"]),用户无需额外配置即可获得闭环保障能力。
- AC11:completion event 到达主会话时,插件通过 `before_prompt_build` hook 注入提醒文本到主会话上下文。提醒内容包含:任务名称、agentId、耗时、明确的 lark-cli 命令格式要求。每个 completion 只注入一次(标记 reminded)。
- AC12:提醒注入仅对主会话(agent=main)的用户渠道 session 生效,不影响子 Agent session。
- AC13:`aco init` 必须在目标目录生成可直接被 Gateway 加载的闭环保障插件文件(支持 ESM/CJS 双格式),插件注册 `subagent_ended`、`before_prompt_build`、`message_sending` 三个 hook,生成后无需手动编写任何代码即可启用闭环保障能力。
- AC14:生成的插件必须包含 post-reminder auto-close 机制——`before_prompt_build` 注入提醒后立即启动短超时计时器(默认 15 秒,可通过 `closureGuard.postReminderTimeoutSeconds` 配置),到期后自动将该 pending closure 标记为 `closure_detected` 并取消闭环计时器,不依赖 `message_sending` hook 的出站消息检测作为唯一闭环路径。
- AC15:生成的插件必须包含 next-turn detection 兜底机制——下一轮 `before_prompt_build` 触发时,自动检测并清除所有已标记 reminded 的 pending closures(视为主会话已处理),避免重复注入提醒或遗留僵尸状态。

---

### 域 G:健康与恢复(Health & Recovery)

负责 Agent 健康监测、卡死检测和自动恢复。

#### FR-G01:心跳检测

定期探测 Agent 是否存活。

- AC1:系统通过 `message:received` 事件监测 Agent 活跃度,结合定时健康探针(可配置间隔,默认 30 秒)检查 running 状态任务的 Agent 是否仍在响应。
- AC2:连续 N 次(可配置,默认 3)探测无响应时,Agent Slot 状态转为 stale。
- AC3:stale 状态的 Agent 上的 running 任务自动转为 failed(原因:agent_unresponsive)。
- AC4:探测间隔可配置(默认 30 秒),不同 Tier 可设置不同间隔。

#### FR-G02:卡死检测

识别长时间无产出的任务(区别于正常长耗时任务)。

- AC1:running 任务超过 timeout * 0.8 仍无中间产出时,系统发出 stall_warning 事件。
- AC2:stall_warning 触发后,系统尝试向 Agent 发送 steer 消息("请报告当前进度")。
- AC3:steer 后 60 秒仍无响应,任务标记为 stalled 并触发超时流程。
- AC4:卡死检测可按任务类型关闭(某些任务天然长时间无中间输出)。

#### FR-G03:自动恢复策略

Agent 异常后自动恢复服务能力。

- AC1:Agent 从 stale/offline 恢复为 idle 后,系统自动将其排队中的任务重新纳入调度。
- AC2:恢复后的第一个任务为探测性派发(低优先级、短超时),验证 Agent 确实可用。
- AC3:探测性派发成功后,Agent 恢复正常调度权重。
- AC4:恢复事件写入 Audit Event 并通知用户。

#### FR-G04:全局健康仪表盘

一览系统整体健康状态。

- AC1:CLI 命令 `aco health` 展示:活跃 Agent 数、stale Agent 数、队列深度、平均等待时间、熔断中的 Agent。
- AC2:健康状态有三级:healthy(所有指标正常)、degraded(部分 Agent 异常但系统可用)、critical(无可用 Agent)。
- AC3:critical 状态触发高优先级通知。
- AC4:健康数据可通过 JSON API 暴露,供外部监控系统消费。

---

### 域 H:配置与渐进式披露(Configuration)

负责系统配置的管理,支持从零配置到完整配置的渐进式体验。

#### FR-H01:零配置启动

无任何配置文件时,系统以合理默认值启动。

- AC1:`aco init` 在无配置文件时生成最小配置(单 Agent、默认超时、无治理规则)。
- AC2:最小配置下所有核心功能可用:任务创建、调度、超时保护、看板、通知(需配置渠道)。
- AC3:生成的配置文件包含注释说明每个字段的用途和可选值。
- AC4:单 Agent 环境下,治理规则(角色校验、自审禁止)自动降级为 warn 模式(不阻断)。

#### FR-H02:配置热加载

修改配置文件后无需重启即可生效。

- AC1:系统监听配置文件变更(fs watch),检测到变更后自动重新加载。
- AC2:配置加载前执行 schema 校验,校验失败时拒绝加载并保持旧配置。
- AC3:配置变更写入 Audit Event,包含变更字段和新旧值。
- AC4:CLI 命令 `aco config reload` 手动触发重新加载(用于 watch 不可用的环境)。

#### FR-H03:配置校验与提示

配置错误时提供明确的错误信息和修复建议。

- AC1:CLI 命令 `aco config validate` 校验当前配置文件,输出所有错误和警告。
- AC2:错误信息包含:字段路径、期望类型/值、实际值、修复建议。
- AC3:常见错误(如引用不存在的 agentId)提供具体修复命令。
- AC4:配置文件支持 JSON 和 YAML 两种格式。

#### FR-H04:渐进式功能启用

用户按需启用高级功能,不强制全量配置。

- AC1:功能分层:L0(基础调度)→ L1(治理规则)→ L2(推进链)→ L3(通知)→ L4(统计分析)。
- AC2:每层功能独立启用,不依赖更高层。
- AC3:CLI 命令 `aco feature enable <feature>` 启用特定功能并生成对应配置模板。
- AC4:`aco status` 展示当前已启用的功能层级。

---

### 域 I：输出质量门禁(Output Quality Gate)

负责拦截主会话发给用户的出站消息，检测并消除技术标签污染，确保用户收到的消息始终是人话。

背景：用户沟通偏好（禁止 agent ID、文件路径、FR/AC 编号、函数名、命令行等技术标签）写在 L6 prompt 层，但长上下文压缩后规则反复丢失，导致违规消息直达用户。本域在 L2 插件层提供硬性拦截，不依赖模型对 prompt 的遵从度。

#### FR-I01：出站消息人话门禁(Output Humanizer Guard)

主会话通过用户可见渠道发出的消息，在送达前经过技术标签检测；命中时自动改写为人话或注入强提醒，确保用户永远不会收到带技术标签的消息。

**检测规则（正则模式匹配，不需要语义理解）：**

| 类别 | 模式示例 | 匹配规则 |
|------|----------|----------|
| Agent ID | sa-01、pm-02、audit-01、dev-01、ux-01 | `[a-z]+-\d{2}` 且命中已注册 agent 池 |
| 文件路径 | /root/、workspace/、projects/、~/.openclaw/ | 以 `/` 或 `~/` 开头的路径片段，或含 `workspace/`、`projects/` 的字符串 |
| FR/AC 编号 | FR-A01、AC-3、FR-I01 | `(FR|AC)-[A-Z]?\d+` |
| 函数名/变量名 | getUserName、task_board、handleCompletion | 驼峰命名(`[a-z]+[A-Z][a-zA-Z]+`)或下划线命名(`[a-z]+_[a-z_]+`)且长度 >= 6 |
| 命令行 | git commit、npm publish、openclaw gateway、npx aco | 命中预定义命令关键词表(`git`、`npm`、`npx`、`openclaw`、`docker`、`curl`、`systemctl` 等后跟子命令) |
| 代码片段 | import、require()、console.log、function() | 命中代码语法关键词模式 |

**处理策略（二选一，由配置项决定）：**

- **策略 B（LLM 改写）**：检测到技术标签后，调用 LLM 将消息改写为纯人话再发出。用户无感知，但有额外延迟（预估 2-5 秒）。
- **策略 C（注入提醒）**：检测到技术标签后，在消息前注入系统级强提醒（对用户不可见），要求模型立即重新生成不含技术标签的版本。延迟更低，但依赖模型对注入提醒的即时响应。

**验收标准：**

- AC1：插件在 Gateway 事件循环中拦截 `message:outbound` 事件（或等价的出站消息钩子），在消息实际送达用户可见渠道之前执行检测逻辑。拦截点必须在 L2 插件层，独立于主会话上下文。
- AC2：检测引擎对上述六类模式逐一匹配。任一类别命中即触发处理策略。检测结果包含：命中类别、命中文本片段、在原文中的位置。
- AC3：配置项 `outputGuard.strategy` 指定处理策略，可选值 `rewrite`（策略 B）或 `remind`（策略 C），默认 `remind`。
- AC4：策略 B（rewrite）生效时，插件调用配置的 LLM（通过 `outputGuard.rewriteModel` 指定，默认复用宿主环境的默认模型）将原始消息改写为不含任何技术标签的人话版本，改写后的消息替换原始消息发出。改写 prompt 固定为系统内置，不暴露给用户修改。
- AC5：策略 C（remind）生效时，插件阻断当前消息发送，向主会话注入一条系统级指令（对用户不可见）：“你的回复包含技术标签（具体列出命中项），请立即重新生成不含技术标签的版本。”主会话重新生成后再次经过检测，通过后放行。
- AC6：策略 C 的重试上限为 3 次。连续 3 次重新生成仍命中技术标签时，自动降级为策略 B（LLM 改写）强制清洗后发出，并记录审计事件（类型 `output_guard_fallback`）。
- AC7：配置项 `outputGuard.channels` 指定生效渠道列表（如 `["feishu", "telegram"]`）。未列入的渠道（如 `webchat`）不执行检测，消息直接放行。默认值 `["feishu"]`。
- AC8：配置项 `outputGuard.enabled` 控制全局开关，默认 `true`。设为 `false` 时所有出站消息不经过检测，直接放行。
- AC9：配置项 `outputGuard.strictness` 控制检测严格度，可选值 `strict`（全部六类模式启用）、`moderate`（仅 agent ID + 文件路径 + FR/AC 编号 + 命令行）、`relaxed`（仅 agent ID + 文件路径）。默认 `strict`。
- AC10：白名单机制——配置项 `outputGuard.allowPatterns` 接受正则数组，命中白名单的文本片段不触发检测。用于放行用户明确允许的技术术语（如产品名中包含路径格式的情况）。
- AC11：每次检测触发（无论是否命中）记录审计事件（类型 `output_guard_scan`），命中时额外记录 `output_guard_triggered`，包含：消息摘要（前 50 字符）、命中类别、命中片段、采用的处理策略、处理结果（rewrite/remind/fallback）。审计事件可通过 `aco audit list --type output_guard_triggered` 查询。
- AC12：`aco init` 生成的默认配置中 `outputGuard` 段已包含合理默认值（enabled: true, strategy: "remind", channels: ["feishu"], strictness: "strict", allowPatterns: []），用户无需额外配置即可获得出站消息人话门禁能力。
- AC13：检测逻辑的模式库通过配置项 `outputGuard.patterns` 可扩展。用户可添加自定义正则模式到检测列表，格式为 `{category: string, pattern: string, description: string}`。内置模式不可删除，只可追加。
- AC14：性能约束——单条消息的检测耗时不超过 50ms（纯正则匹配，不含 LLM 调用）。策略 B 的 LLM 改写耗时不计入此约束，但必须在 30 秒内完成，超时则放行原始消息并记录 `output_guard_timeout` 审计事件。

---

### 域 J：插件基础设施(Plugin Infrastructure)

负责 generator 的声明式注册与自动发现机制，以及与 SEVO 流水线的 init 覆盖验证集成。

#### FR-J01：声明式插件注册（init 自动发现）

**目标**：`aco init` 不再需要手动在 `initCommand()` 中逐个调用 generator，而是自动发现并执行所有已注册的 generator。

**AC**：

- AC1：`src/generators/` 目录下所有导出 `generate()` 函数的模块自动被 `aco init` 发现并执行。
- AC2：新增 generator 只需放入 `src/generators/` 并导出标准接口，无需修改 `init.ts`。
- AC3：每个 generator 导出 `{ name, description, generate(env, config, force) }` 标准接口。
- AC4：`aco init --list` 列出所有已注册的 generator 及其描述。
- AC5：generator 执行顺序由可选的 `priority` 字段控制（默认 100，数字小的先执行）。

#### FR-J02：SEVO implement gate 自动验证 init 覆盖

**目标**：ACO 项目在 SEVO implement 阶段，gate 自动检查"新增的 L2 能力是否有对应的 generator 且能被 init 发现"。

**AC**：

- AC1：SEVO implement-review gate 对 ACO 项目额外检查：`src/generators/` 下的 generator 数量 ≥ spec 中标注为"需 init 安装"的 FR 数量。
- AC2：每个标注"需 init 安装"的 FR 必须有对应的 generator 文件，文件名包含 FR 编号或 FR 关键词。
- AC3：gate 不通过时输出缺失的 generator 列表。

---

### 域 Z：包分发与开箱体验(Distribution)

负责 npm 包的分发、安装和首次使用体验。

#### FR-Z01:一键初始化

`npx aco init` 完成所有环境准备。

- AC1:自动检测宿主环境类型(OpenClaw / 其他 ACP / 独立运行)。
- AC2:自动发现已有 Agent 并生成资源池配置。
- AC3:生成配置文件、创建数据目录、注册为宿主环境插件(如适用)。
- AC4:初始化完成后输出 next steps 指引(如何创建第一个任务、如何配置通知)。
- AC5:重复执行 `aco init` 为幂等操作(不覆盖已有配置,只补充缺失项)。

#### FR-Z02:CLI 入口

提供统一的命令行界面操作所有功能。

- AC1:顶层命令 `aco` 包含子命令:task、board、pool、rule、chain、audit、notify、stats、health、config、init。
- AC2:每个子命令支持 `--help` 展示用法和示例。
- AC3:输出格式统一支持 `--json` 标志切换为 JSON 输出。
- AC4:错误输出包含错误码、错误描述和建议的修复操作。

#### FR-Z03:库 API

提供编程接口供宿主环境集成。

- AC1:导出核心类:Scheduler、TaskQueue、ResourcePool、RuleEngine、ChainExecutor。
- AC2:所有 CLI 功能均可通过库 API 实现(CLI 是 API 的薄封装)。
- AC3:API 支持事件订阅(EventEmitter 模式),宿主环境可监听任务状态变更。
- AC4:TypeScript 类型定义完整,所有公开接口有 JSDoc 注释。

#### FR-Z04:宿主适配器

通过 Adapter 模式对接不同宿主环境。

- AC1:定义 HostAdapter 接口:spawnTask、killTask、steerTask、getTaskStatus、getAgentStatus、getSessionState、subscribeEvents。其中 steerTask 向运行中的 Agent 注入补充信息,getSessionState 获取会话的文件系统状态(用于判断 ACP 是否真正活跃),subscribeEvents 订阅任务完成/超时等事件(推进链的触发依赖此能力)。
- AC2:内置 OpenClaw Adapter(对接 sessions_spawn / subagents API)。
- AC3:用户可实现自定义 Adapter 对接其他执行环境。
- AC4:Adapter 注册通过配置文件指定,运行时动态加载。

#### FR-Z05:版本与升级

支持平滑升级,不丢失运行时状态。

- AC1:`npm update aco-orchestrator` 后,系统自动检测数据格式变更并执行迁移。
- AC2:迁移前自动备份当前数据(配置文件 + 审计日志 + 看板快照)。
- AC3:迁移失败时自动回滚到备份,不破坏现有环境。
- AC4:CLI 命令 `aco version` 展示当前版本和可用更新。

---

## 5. 非功能需求(NFR)

### NFR-01:性能

- 事件响应延迟 <= 1 秒(从事件到达到调度决策完成),任务从 queued 到 dispatching 的延迟 <= 2 秒。
- 单实例支持同时管理 100+ 任务、50+ Agent Slot,无明显性能退化。
- 审计日志写入不阻塞调度主循环(异步写入)。
- CLI 命令响应时间 <= 500ms(本地操作)。

### NFR-02:可靠性

- 进程意外退出后重启,能从持久化状态恢复所有非终态任务(不丢任务)。
- 状态持久化采用 WAL(Write-Ahead Log)模式,确保崩溃一致性。
- 单个 Agent 故障不影响其他 Agent 的调度(故障隔离)。

### NFR-03:可维护性

- 代码模块按域划分,每个域独立目录,域间通过事件总线通信。
- 测试覆盖率 >= 80%(核心调度逻辑 >= 95%)。
- 所有配置项有 schema 定义和默认值文档。

### NFR-04:安全性

- 配置文件中的敏感信息(IM token、webhook secret)支持环境变量引用,不明文存储。
- 审计日志不记录任务 prompt 全文(可能含敏感信息),只记录 label 和 hash。
- CLI 操作不需要额外认证(本地工具,依赖文件系统权限)。

### NFR-05:兼容性

- 支持 Node.js >= 18。
- 支持 Linux、macOS、Windows(WSL)。
- 不依赖外部数据库,所有状态存储在本地文件(SQLite 或 JSON)。
- 与 OpenClaw Gateway 版本解耦,通过 Adapter 接口适配不同版本。

### NFR-06:可观测性

- 所有关键操作产生结构化日志(JSON 格式),支持日志级别配置。
- 提供 metrics 导出接口(Prometheus 格式),供外部监控系统采集。
- 错误日志包含完整上下文(taskId、agentId、操作类型、错误栈)。

---

## 6. 概念架构

### 部署形态

ACO 的部署形态是 **OpenClaw Gateway Plugin**(事件驱动),不是独立 daemon 或轮询进程。ACO 作为 Gateway 插件运行,通过 OpenClaw 的插件事件系统接收事件并执行调度逻辑。没有"调度循环"或"tick"的概念--所有调度决策由事件触发。

事件源:

- `session:spawn`:任务创建事件。外部调用方(SEVO / 用户 / 其他模块)请求创建 Agent 会话时触发,ACO 在此拦截并执行准入校验。
- `session:complete`:任务完成事件。Agent 会话结束时触发,ACO 执行实质成功校验、推进链触发、资源池状态更新。
- `session:timeout`:超时事件。任务超过 timeout 阈值时由 Gateway 触发,ACO 执行超时处理和梯队升级。
- `message:received`:消息到达事件。用于卡死检测(Agent 有响应则重置 stall 计时器)和运行时干预(steer)。

### 核心组件

ACO 的运行时由五个核心组件协作:

**事件调度器(Event Dispatcher)** 是系统入口。接收 Gateway 事件,根据事件类型路由到对应处理器。事件调度器是纯响应式的--无事件则无动作,不消耗 CPU。

**任务队列(Task Queue)** 持有所有非终态任务。任务按 priority 降序 + 入队时间升序排列。每当有新任务入队或有 Agent 释放时,事件调度器触发队列消费:取出队首候选任务,交给规则引擎校验。

**规则引擎(Rule Engine)** 在派发前执行所有 Dispatch Rule。规则按优先级排序,逐条匹配。命中 block 规则的任务被拦截并保持 queued;命中 warn 规则的任务放行但记录告警;无命中或命中 allow 的任务进入派发流程。规则引擎内置 LLM 语义分类能力,对 task prompt 进行任务类型推断。

**资源池(Resource Pool)** 管理所有 Agent Slot 的状态。派发时资源池提供候选列表(idle 且未达并发上限的 Agent),按梯队路由策略排序。Agent 完成任务后资源池更新状态并触发队列消费(可能有排队任务等待该 Agent)。

**推进链执行器(Chain Executor)** 监听任务终态事件。任务进入 succeeded 或 failed 时,检查是否有关联的 Completion Chain,有则按 chain 定义创建后续任务并入队。支持条件循环(如审计不通过 → 修复 → 再审计)。

### 与现有三件套的能力映射

| 现有组件 | 核心能力 | ACO 对应域 |
|----------|----------|------------|
| dispatch-guard | 角色校验、LLM 语义分类、并发控制、ACP 全局上限、prompt 注入 | 域 B(派发治理)+ 规则引擎 |
| run-watchdog | 超时保护、卡死检测、idle-alert、steer 干预、健康探测 | 域 A(超时)+ 域 G(健康恢复) |
| local-subagent-board.js | 任务看板、状态追踪、飞书通知、快照推送 | 域 E(可观测)+ 域 F(通知) |

ACO 新增的能力(三件套没有的):声明式推进链(域 D)、梯队路由(域 C)、渐进式配置(域 H)、跨宿主适配(域 Z)。

### 数据流转

1. 外部调用方请求创建任务 → `session:spawn` 事件 → 事件调度器 → 规则引擎校验 → 资源池选 Agent → 派发(dispatching → running)。
2. Agent 执行完成 → `session:complete` 事件 → 实质成功校验 → succeeded 或 failed。
3. 推进链执行器收到终态事件 → 创建后续任务 → 回到步骤 1。
4. 超时触发 → `session:timeout` 事件 → failed → 梯队升级重试 → 回到步骤 1。
5. 每个状态变更 → Audit Event 写入 + Notification 推送。

### 持久化策略

任务状态和审计日志写入本地 SQLite(WAL 模式)。配置文件为 YAML/JSON。资源池状态为内存态(启动时从宿主环境重建)。

---

## 7. 与其他模块的边界

### ACO vs SEVO(研发流水线)

- SEVO 定义研发流程的阶段和门禁(Spec → Implement → Review → Deploy)。
- ACO 负责执行 SEVO 阶段中的具体任务调度(选哪个 Agent、超时多少、失败怎么办)。
- 边界:SEVO 说"这个阶段需要一个审计任务",ACO 说"这个审计任务派给 audit-01,超时 600s,失败升级到 T1"。
- 集成点:SEVO 通过 ACO 的库 API 创建任务,ACO 通过事件通知 SEVO 任务完成。

### ACO vs KIVO(知识管理)

- KIVO 管理知识的提取、存储、检索和分发。
- ACO 不涉及知识内容,只负责调度执行知识相关的任务(如调研任务的 Agent 分配)。
- 边界:KIVO 说"需要执行一个调研任务",ACO 负责把这个任务调度到合适的 Agent。
- 集成点:KIVO 通过 ACO API 提交调研任务,ACO 返回任务状态和产出。

### ACO vs AEO(效果运营)

- AEO 负责效果监测、A/B 测试和运营自动化。
- ACO 不涉及效果评估逻辑,只负责调度 AEO 产生的执行任务。
- 边界:AEO 说"需要执行一个数据采集任务",ACO 负责调度执行。

### ACO vs 宿主环境(OpenClaw Gateway)

- 宿主环境提供 Agent 的实际执行能力(spawn session、send message、kill session)。
- ACO 通过 HostAdapter 接口调用宿主能力,不直接依赖宿主实现细节。
- 边界:ACO 决定"派发任务给 agent-x",宿主环境负责"创建 agent-x 的执行会话并传入 prompt"。
- ACO 不管理 Agent 的生命周期(创建/删除 Agent 是宿主环境的职责),只管理 Agent 的调度状态。

---

## 8. 约束与假设

### 约束

- ACO 运行在单机环境,不考虑分布式部署(Agent 集群规模 <= 50)。
- ACO 依赖宿主环境提供 Agent 执行能力,自身不实现 Agent runtime。
- 审计日志存储在本地文件系统,不支持远程日志服务(可通过 metrics 导出间接实现)。
- 通知渠道的认证凭据由用户自行管理,ACO 不提供凭据轮换机制。
- 配置文件格式向后兼容,新版本不破坏旧配置(可能新增字段但不删除/改语义)。

### 假设

- 宿主环境的 Agent 执行是可靠的(ACO 处理超时和失败,但不处理宿主环境本身的崩溃)。
- 用户有基本的命令行使用能力(ACO 是 CLI-first 工具)。
- Agent 数量在 2-50 范围内(低于 2 个 Agent 时治理价值有限,超过 50 个需要分布式方案)。
- 任务 prompt 由调用方(SEVO / 用户 / 其他模块)负责质量,ACO 不校验 prompt 内容的合理性。
- 网络连接稳定(IM 通知依赖网络,网络中断时通知会延迟但不丢失--本地队列缓冲)。

<!-- 变更记录:2026-05-11 pm-01 增量补充 FR-F 域。新增 FR-F02 AC5/AC6(label 模式排除 + 任务来源过滤)、FR-F05(任务完成即时通知)。覆盖独立 completion-notify 插件的全部能力,该插件在 ACO 实现后废弃。 -->
