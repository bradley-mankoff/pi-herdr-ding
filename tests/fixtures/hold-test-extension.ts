/**
 * A stand-in for another extension that holds the sound: on the first agent run it emits
 * the hold event this package documents, and never again, so a test can see one held turn
 * followed by a turn that plays.
 *
 * HOLD_FIRST_TURN: set to "1" to emit on the first run; unset, the stand-in does nothing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function holdTestExtension(pi: ExtensionAPI): void {
	if (process.env.HOLD_FIRST_TURN !== "1") return;
	let held = false;
	pi.on("agent_start", () => {
		if (held) return;
		held = true;
		pi.events.emit("pi-herdr-ding:hold", { reason: "a Run is still moving" });
	});
}
