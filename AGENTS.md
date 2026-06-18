
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
