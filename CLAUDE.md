# CLAUDE.md

revcut is a local, single-user web app that turns hand-picked videos and photos into a beat-synced, 9:16, 20–25 s IG Reel. The AI drafts a version, the user edits it, and the user exports it.

**`docs/SPEC.md` is the source of truth.** Read the relevant section before working on a feature. If the code needs to differ from the SPEC, stop and ask. Once the user agrees, update the SPEC in the same change.

## Rules

### 1. Keep code simple

- Write the minimum code that satisfies the SPEC. Don't add features, options, or config that weren't asked for.
- Add an abstraction only when two real implementations already exist, like the Anthropic and OpenAI adapters. If something has one caller, inline it.
- Keep logic in pure functions (timing math, validation, planner). Keep I/O at the edges (routes, jobs).
- Make surgical changes. Don't refactor or reformat code the task doesn't touch, and match the surrounding style.
- If a solution feels big, look for a smaller one before writing it.

### 2. Think before implementation

- Before coding, state:
  - what you'll change
  - which SPEC section it implements
  - your assumptions
  - how you'll verify it
- If the request or the SPEC is ambiguous, ask. Don't pick an interpretation silently.
- Work phase by phase (SPEC §16). Don't start the next phase until the user has accepted the current one.
- Raise tradeoffs and simpler alternatives, and push back when something looks wrong.

### 3. Use TDD where it applies

- For anything that can be tested without a human, write a failing test first, then the code:
  - `packages/shared`: timing math, `sliceWindow`, validation rules, song changes, Live Photo grouping
  - `packages/shared` planner: the invariants listed in SPEC §15
  - metadata parsing (`resolveCaptureTime`, `placeLabel`): sanitized JSON in `fixtures/metadata/`
  - AI adapters: test against recorded responses in fixtures, never live calls
  - API routes: state transitions and 4xx cases
  - `analyzer`: synthetic audio, e.g. a 120 BPM click track
- A bug fix starts with a test that reproduces the bug.
- Where TDD doesn't fit (UI feel, video and color quality, the IG safe zone):
  1. Write down the manual acceptance check from SPEC §16 before implementing.
  2. Implement.
  3. Run the check and report the result.
- Tests must never call paid APIs (Anthropic, OpenAI, Google) or depend on private media.
  - Private samples live in `fixtures/private/`, which is gitignored.
  - Tests that need those samples skip when the files are missing.

## Project invariants

- Timeline cut points are stored in **beats**, never seconds. Frame times are always computed from absolute beat timestamps (`packages/shared/src/timing.ts`).
- Preview and render use the **same** `packages/composition` component. Never add logic that exists on only one side.
- `DATA_DIR` lives inside the WSL filesystem, never under `/mnt/c` or on the NAS.
- The server listens on `127.0.0.1` only. There is no auth, by design.
- User-facing text (UI and error messages) is in Traditional Chinese (Taiwan).

## Commands

See `README.md` for setup and the full list. The ones you'll use most:

```bash
pnpm dev                              # web :5173 + server :3000
pnpm test                             # vitest, all TS packages
pnpm typecheck
uv run --project analyzer pytest      # Python tests
pnpm db:generate && pnpm db:migrate   # after changing the Drizzle schema
```
