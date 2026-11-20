/**
 * ding: plays the "needs attention" sound when a pi turn has settled, so a session in a
 * herdr pane tells the Human it is his turn even with herdr's own pi sound off.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The macOS system sound the build chose: herdr's own request sound plays nothing with
 * pop-ups off, so the package plays this file directly and shows no pop-up. */
const NEEDS_ATTENTION_SOUND = "/System/Library/Sounds/Ping.aiff";

/** The event another extension emits to keep the turn it is in silent. Its payload is
 * ignored: the event is the hold, and it lasts until this run settles. */
const HOLD_EVENT = "pi-herdr-ding:hold";

export default function ding(pi: ExtensionAPI): void {
	// herdr injects both values into every pane it runs; a session without them is outside
	// herdr, where no one is waiting on a herdr pane to hear this sound.
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;

	/** Whether another extension held the turn in progress. It is cleared as the run
	 * settles, so a hold covers one settled turn and the next one plays again, and an event
	 * from an extension loaded before or after this one is never lost to handler order. */
	let held = false;

	pi.events.on(HOLD_EVENT, () => {
		held = true;
	});
	pi.on("agent_settled", (_event, ctx) => {
		const wasHeld = held;
		held = false;
		// A print-mode session and a Run node have no screen; only a session someone can see
		// should tell the Human its turn is over.
		if (!ctx.hasUI || wasHeld) return;
		// A sound that fails to play is not worth failing the turn over, and nothing waits on
		// the result, so the callback drops afplay's error instead of reporting it.
		execFile("afplay", [NEEDS_ATTENTION_SOUND], () => {});
	});
}
