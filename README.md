# pi-herdr-ding

A pi package that plays herdr's "needs attention" sound at the end of every turn in a pi session running inside herdr, with no pop-up. Use it with herdr's own pi sound turned off (`[ui.sound.agents] pi = "off"`), so the sound means the turn is over and it is your turn.

Another extension can hold the sound for one turn by emitting an event during the turn, for example when the session started work that carries on without you.

Not built yet: the first version is tracked in this repo's Beads.
