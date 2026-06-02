# NFR-LLM-TIMEOUT：L2 插件 LLM 语义判定超时上限

L2 插件中所有 LLM 语义判定调用（dispatch-guard 任务分类、异步纪律豁免判定、spec-first 判定等）的 AbortController 超时上限为 360 秒（360000ms）。

超时内未返回结果按 fallback 策略处理（默认放行 + 记录告警）。

## 原因
LLM 请求通过中转服务转发（penguin proxy），在多任务并发时可能因排队阻塞导致响应延迟。3-15 秒超时在实际运行中持续触发 AbortError，导致分类器形同虚设。360 秒为用户于 2026-06-02 确认的上限。

## 决策记录
- 决策人：于长煦（CEO）
- 决策时间：2026-06-02 23:26
- 生效范围：ACO 全部 L2 插件 + SEVO pipeline LLM 调用
