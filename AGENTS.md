# Working agreement

- Wick works only from outside the Roblox client: window capture in, OS-level input out. Never add code that opens a handle to, reads or writes the memory of, or injects into the Roblox process, and never add anything meant to evade Roblox's anti-cheat. This applies to every feature, including "read-only" ones.
- Input goes only to the macro's target window, only while it is focused, and the global kill switch must always work.
- Keep Roblox-specific code inside the `roblox` target. The engine core, vision, input and runtime stay target-agnostic.
- Prefer the `sim` target for automated tests so they run headless in CI.
- Shared macros are untrusted code. Keep them inside the sandbox described in `docs/FORMAT.md#permissions-and-the-sandbox`; never give macro code filesystem, network, process or general OS access.
- The user handles manual testing on their device. Do not drive Roblox or other device UI for verification unless explicitly requested. Run relevant automated checks and provide manual test fixtures or instructions when useful.
- At the end of each implementation pass, update `docs/ROADMAP.md` with completed work, remaining priorities, and verification results. Distinguish partial progress from completed features.
- Commit and push to the current branch's remote whenever a coherent set of changes is done and relevant automated checks pass; there's no need to ask first. This is the user's standing request. Preserve unrelated work, never force-push, and report a blocked push accurately.
- Large passes are welcome. Commit at checkpoints inside a long pass so progress is never only local.
