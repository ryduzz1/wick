import { macro, type Context } from "wick";

// Keeps the white tick inside the green zone. The tick drifts back on its
// own and each click pushes it forward, so: predict where the tick will be
// once a click would land, and click if that's behind the zone's center.
export default macro({
  async run(ctx: Context) {
    const { screen, input, loop, settings, log } = ctx;
    const zone = screen.track("bar", { color: "#3ccf5a", tolerance: 40 });
    const tick = screen.track("bar", { color: "#ffffff", tolerance: 40, minPixels: 2 });

    log("Waiting for the bar...");
    const found = await ctx.waitUntil(() => zone.seen && tick.seen, { timeout: 10_000 });
    if (!found) throw new Error("Couldn't find the bar. Is the minigame open, and is the bar region in the right place?");
    log("Found the bar.");

    const minGap = Number(settings.minGap);
    const lead = Number(settings.lead);
    const seconds = Number(settings.seconds);

    await loop.hz(
      120,
      () => {
        if (!zone.seen || !tick.seen) return;
        const ahead = tick.x + tick.velocity * input.latency * lead;
        if (ahead < zone.center) input.click({ at: { region: "bar" }, minGap });
      },
      { until: () => zone.missingFor > 2000 || (seconds > 0 && ctx.now() > seconds * 1000) },
    );
    log(zone.seen ? "Time's up." : "The bar is gone, so the minigame ended.");
  },
});
