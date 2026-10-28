import { macro, type Context } from "wick";

// A looping macro as a state machine: wait for the prompt and cast, wait for
// the bar, play the bar minigame, repeat. Each state has a timeout; when one
// runs out, "recover" works out what went wrong (a disconnect dialog, or a
// cast that never landed) and fixes it. Before every loop, the HUD must look
// like it did at the start, so the macro notices if it ended up somewhere else.
export default macro({
  async run(ctx: Context) {
    const { screen, settings, log } = ctx;
    const zone = screen.track("bar", { color: "#3ccf5a", tolerance: 40 });
    const tick = screen.track("bar", { color: "#ffffff", tolerance: 40, minPixels: 2 });
    const prompt = screen.track("prompt", { color: "#f2c14e" });
    const dialog = screen.track("dialog", { color: "#393b3d", tolerance: 6, minPixels: 200 });
    const hud = screen.track("hud", { color: "#465a82" });
    const minGap = Number(settings.minGap);

    const stats = await ctx.states(
      {
        cast: {
          timeout: 4000,
          async run(s) {
            await s.waitUntil(() => prompt.seen);
            s.input.press("e");
            return "bite";
          },
        },
        bite: {
          timeout: 3000,
          async run(s) {
            await s.waitUntil(() => zone.seen && tick.seen);
            return "play";
          },
        },
        play: {
          timeout: 10_000,
          async run(s) {
            await s.loop.hz(
              120,
              () => {
                if (!tick.seen || !zone.seen) return;
                if (tick.x + tick.velocity * s.input.latency < zone.center) s.input.click({ minGap });
              },
              { until: () => zone.missingFor > 100 },
            );
            return "cast";
          },
        },
        recover: {
          timeout: 15_000,
          async run(s) {
            if (dialog.seen) {
              s.log("Disconnected; rejoining.");
              await s.game.rejoin();
              await s.waitUntil(() => hud.seen && !dialog.seen);
            } else {
              s.log("Stuck; resetting the character.");
              await s.character.reset();
              await s.waitUntil(() => prompt.seen);
            }
            return "cast";
          },
        },
      },
      { recover: "recover", startPoint: "hud", loops: Number(settings.loops) },
    );
    log(`Played ${stats.loops} rounds; ${stats.timeouts} timeouts, ${stats.recoveries} recoveries.`);
  },
});
