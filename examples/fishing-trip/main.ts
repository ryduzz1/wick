import { macro, type Context, type RouteAction } from "wick";
import toDock from "./routes/to-dock.js";
import toVendor from "./routes/to-vendor.js";

// A trip as a state machine: walk from the spawn to the dock, fish until the
// bag's last slot fills, walk to the vendor, sell, and reset back to the
// spawn, which is the start point every trip begins from. The two walks are
// routes cut from a recorded demonstration (see README.md); each one stops
// as soon as the prompt shows that the character has arrived.
export default macro({
  async run(ctx: Context) {
    const { screen, settings, log } = ctx;
    const zone = screen.track("bar", { color: "#3ccf5a", tolerance: 40 });
    const tick = screen.track("bar", { color: "#ffffff", tolerance: 40, minPixels: 2 });
    const prompt = screen.track("prompt", { color: "#f2c14e" });
    const bagFull = screen.track("lastSlot", { color: "#6ebedc", tolerance: 12 });
    const menu = screen.track("menu", { color: "#393b3d", tolerance: 6, minPixels: 200 });
    const sellButton = screen.track("sellButton", { color: "#56b46e", tolerance: 12 });
    const minGap = Number(settings.minGap);

    // Walks a route until the prompt shows up somewhere new: it may still be
    // showing where the route starts.
    const walk = async (s: Context, route: readonly RouteAction[]) => {
      let away = !prompt.seen;
      const arrived = () => (away ||= !prompt.seen) && prompt.seen;
      const r = await s.input.play(route, { until: arrived, settle: 1000 });
      return r.reached;
    };

    const stats = await ctx.states(
      {
        toDock: {
          timeout: 6000,
          async run(s) {
            return (await walk(s, toDock)) ? "cast" : "recover";
          },
        },
        cast: {
          timeout: 4000,
          async run(s) {
            if (bagFull.seen) return "toVendor";
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
        toVendor: {
          timeout: 8000,
          async run(s) {
            return (await walk(s, toVendor)) ? "sell" : "recover";
          },
        },
        sell: {
          timeout: 5000,
          async run(s) {
            s.input.press("e");
            await s.waitUntil(() => menu.seen && sellButton.seen);
            s.input.click({ at: "sellButton" });
            await s.waitUntil(() => !bagFull.seen);
            s.input.press("escape");
            await s.waitUntil(() => !menu.seen);
            log("Sold a bag of fish.");
            return "home";
          },
        },
        home: {
          timeout: 5000,
          async run(s) {
            await s.character.reset();
            return "toDock";
          },
        },
        recover: {
          timeout: 5000,
          async run(s) {
            s.log("Lost; resetting to the spawn.");
            s.input.press("escape");
            await s.character.reset();
            return "toDock";
          },
        },
      },
      { start: "toDock", recover: "recover", startPoint: "spawn", loops: Number(settings.trips) },
    );
    log(`Made ${stats.loops} trips; ${stats.timeouts} timeouts, ${stats.recoveries} recoveries.`);
  },
});
