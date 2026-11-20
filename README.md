# pi-herdr-ding

A pi package that plays a "needs attention" sound at the end of every turn in a pi session
running inside herdr, with no pop-up. Use it with herdr's own pi sound turned off, so the
sound means the turn is over and it is your turn.

It plays whether or not you are looking at the pane: a dim screen or a moment away should
not hide a silent cue. It plays nothing outside herdr, in a session without a screen (print
mode, a Run node), or in a sub-agent.

Another extension can hold the sound for one turn by emitting an event during the turn, for
example when the session started work that carries on without you.

The first version was built for Factory Bead `pi-herdr-ding-sy1`; the Factory's Spec is Epic
`fac-o2r` in [github.com/bradley-mankoff/factory](https://github.com/bradley-mankoff/factory).

Install: `pi install git:github.com/bradley-mankoff/pi-herdr-ding`

## herdr settings to pair it with

Turn herdr's own pi sound and its pop-ups off, and leave the rest of the settings alone:

```toml
[ui.toast]
delivery = "off"

[ui.sound.agents]
pi = "off"
```

With those in place, herdr no longer dings or shows a pop-up when a pi turn ends, and this
package is the only thing that makes the sound. herdr's check marks for unseen idle panes
are unchanged.

## Holding the sound from another extension

Emit `pi-herdr-ding:hold` on pi's event bus during the turn. The payload is not read: the
event is the hold. It lasts until that run settles, so the next turn plays again.

```ts
pi.events.emit("pi-herdr-ding:hold", {
  reason: "a Run is still moving and nothing waits on the Human",
});
```

`reason` is a convention for the emitter's own logs and for anyone reading the call; this
package ignores it and any other payload. Emit the event once per turn that should be
silent, at any point during that turn; the hold is cleared when the turn settles, so the next
turn plays again. A hold emitted while the session is idle applies to the next settled turn.

The Factory's Project Manager uses this hold while one of its project's Runs is still moving
and nothing waits on the Human.

## How the sound is played

The build tried herdr's own request sound first, in a separate headless herdr session
(`herdr --session <name> server`), never in the person's own herdr, with pop-ups off:

```toml
# the probe's config.toml
[ui.toast]
delivery = "off"

[ui.sound]
enabled = true
```

Then, with `HERDR_CONFIG_PATH` naming that file:

```sh
herdr --session pi-herdr-ding-probe notification show 'pi-herdr-ding probe' --sound request
```

With herdr 0.9.4 on macOS on 2026-11-20 it answered:

```json
{"id":"cli:notification:show","result":{"reason":"disabled","shown":false,"type":"notification_show"}}
```

The headless server's log recorded the request as completed, and no sound played. herdr
turns the whole notification off when toasts are off, so its request sound cannot be used
with pop-ups off. The package therefore plays a macOS system sound directly:

```sh
afplay /System/Library/Sounds/Ping.aiff
```

That is the sound this package asks for, and the tests check for exactly that file. It shows
no pop-up. If a later herdr version plays its request sound with pop-ups off, this choice can
be revisited with the same probe.

## Tests

`npm test` drives real pi sessions in RPC, print and JSON modes with this extension loaded,
and puts stand-in `herdr` and `afplay` commands first on `PATH`. The stand-ins write down
their calls, so a test reads what the session asked for without starting herdr or playing a
sound. The tests never run the real herdr.
