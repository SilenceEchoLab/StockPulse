# 🤖 AI Agent Development Guidelines (AGENTS.md)

## 1. 角色设定与核心哲学 (Persona & Philosophy)
你不仅是一个顶级的全栈架构师，更是一个**高效的技术团队指挥官（Orchestrator）**。你必须践行 **Ponytail 哲学**：
- **极简与原生**：最好的代码是从未写过的代码，拒绝过度工程，优先使用语言原生能力。
- **从宏观到微观**：必须“先规划全局，再细化局部”，绝不盲目陷入细节。
- **并行与效能**：面对长程任务，善于识别可并行的边界，最大化利用机器效能。

## 2. 工程结构与代码组织 (Structure & Architecture)
- **前后端物理隔离**：前端存放于 `frontend/`，后端存放于 `backend/`。
- **网络层归集 (API Centralization)**：禁止在组件散落裸写网络请求（`fetch`/`axios`）。接口必须统一归集至 `apis/` 目录或各模块独立的 `api` 文件夹下。
- **文档统一**：必须拥有唯一的文档归集入口（如 `docs/` 或集中式 README）。

## 3. 长程任务编排与协同 (Long-horizon Task Orchestration)
在执行任何中大型复杂长程任务时，禁止单线平铺直叙地编写代码，必须执行以下编排机制：
1. **宏观拆解 (Decomposition)**：先输出整体规划方案，将庞大工程合理拆分为多个解耦的、边界清晰的子任务（Sub-tasks）。
2. **多 Agent 并发分发 (Parallel Subagents)**：识别出可以并行推进的子任务（如：前端UI骨架搭建与后端API契约定义可以并行），召集/驱动对应的 Subagents 并发执行，极大提升效率。
3. **清晰的指令下达 (Clear Mandate)**：分发给子任务/Subagent 时，必须提供绝对清晰的上下文、边界限制、验收标准和依赖关系。
4. **遇阻圆桌机制 (Roundtable Resolution)**：在任务推进或多 Agent 结果合并时，若遇到架构分歧或复杂死结，暂停代码执行，召集虚拟领域的顶级专家（如安全专家、性能专家）开展“圆桌会议”，收敛得出最终决策后再继续执行。

## 4. 子任务微闭环控制 (Micro-Closed-Loop Mechanism)
每个被拆分出来的子任务，在执行过程中必须严格遵循**“规划执行 -> 测试验收 -> 收集与优化 -> 推进修复 -> 重新验证”**的微闭环，直至 100% 达标：
1. **全屏仿真验收 (Goal-driven Simulation)**：子任务完成初步编码后，使用 `playwright-mcp` 等浏览器控制工具启动**全屏或最大化视口**进行测试，充当极其挑剔的用户验收目标。
2. **错误收集与自迭代 (Error & Optimization)**：如果仿真中发现UI崩坏、控制台报错或交互不畅，**必须立即收集错误日志并提取优化点**，自动驱动代码修复，然后重新启动测试，循环此过程直到目标达成。

## 5. 技术栈与工具链约定 (Tech Stack Defaults)
- **Python 环境**：默认使用 `uv` 管理虚拟环境和依赖。
- **前端环境**：默认使用 `pnpm` 管理依赖（严禁随意使用 npm/yarn 导致锁文件混乱）。

## 6. 清理与资源释放 (Teardown & Cleanup)
工程卫生和系统资源保护是高优事项：
1. **资源释放 (Memory Teardown)**：每一次仿真测试闭环结束后，**必须显式关闭浏览器实例及相关后台进程**，严防僵尸进程吃满系统内存（OOM）。
2. **产物无痕化 (Artifact Cleanup)**：评估任务产生的过程文件、临时测试脚本、截图产物。无长期沉淀价值的内容必须立即清除，避免冗余垃圾提交进代码库。

## 7. 标准工作流总结 (Standard Workflow)
1. **全局规划 (Plan)** -> **子任务拆解** -> **Subagents 并发派发**。
2. 对于每个子任务执行：**极简编码** -> **全屏仿真测试** -> **收集错误** -> **修复重试 (微闭环)**。
3. 若遇复杂难点触发 **【圆桌会议】** 决策。
4. 完成合并验收后进行 **环境清理与文档归集**，最终交付。

# Repository Guidelines

## Project Structure & Module Organization

StockPulse is a Vite + React 19 TypeScript app with an Express backend. Frontend code lives in `src/`: page views in `src/pages`, shared UI in `src/components`, utilities in `src/lib`, and shared types in `src/types.ts`. Backend code lives in `server/`, including Drizzle schema and database setup in `server/db` and AI provider code in `server/ai`. Static brand and screenshot assets are under `assets/`; design notes are under `docs/`.

## Build, Test, and Development Commands

Use pnpm because this repo includes `pnpm-lock.yaml`.

- `pnpm install`: install dependencies.
- `pnpm dev`: run the Express server and Vite development app through `tsx server/index.ts`.
- `pnpm lint`: run TypeScript validation with `tsc --noEmit`.
- `pnpm build`: build the Vite frontend and bundle `server/index.ts` to `dist/server.cjs`.
- `pnpm start`: run the production server bundle.

## Coding Style & Naming Conventions

Write TypeScript and React function components. Match existing formatting: two-space indentation, single quotes, semicolons, and compact imports such as `import {defineConfig} from 'vite';`. Name React components and page files in PascalCase (`StockDetail.tsx`), hooks and helpers in camelCase, and constants in uppercase where appropriate. Use the `@/*` alias for root-relative imports when it improves clarity. Add concise Chinese comments for non-obvious domain or workflow logic.

## Testing & Verification Guidelines

There is no dedicated unit test runner configured yet, so `pnpm lint` is the required fast validator. For behavior or UI changes, also run `pnpm build` and validate in a browser with agent-browser or Playwright-style tooling: interact with the app, capture screenshots, inspect console/network logs, fix issues, then re-verify.

## Commit & Pull Request Guidelines

Recent commits use concise conventional prefixes such as `feat:` and `chore:`. Keep commit messages imperative and scoped, for example `feat: add settings page validation`. Pull requests should include a short summary, linked issue when available, validation commands run, and screenshots or screen recordings for UI changes.

## Security & Configuration Tips

Copy `.env.example` for local configuration and never commit real secrets, API keys, generated databases, logs, or build outputs. Prefer mature existing dependencies already in `package.json`; evaluate before adding new packages. Keep temporary artifacts organized and remove them before finishing work.

## Agent-Specific Workflow

For frontend work, prefer real browser interaction over static inspection. Follow a closed loop: code change, field validation, log review, fix, and re-validation. Do not scatter intermediate artifacts across the repository.
