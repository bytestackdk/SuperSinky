# Super Sinky

A browser multiplayer game of age-of-sail naval warfare. Wooden ships, broadsides,
shifting wind and whirlpools, seen from above at a slight angle.

```bash
npm start
```

Then open <http://localhost:3000>. Set `PORT` to serve elsewhere.

**There are no dependencies.** The server needs nothing but a stock Node install
(18+), including the WebSocket layer, so it drops onto a plain Linux box as-is.

---

## Playing

| Key | Action |
| --- | --- |
| `←` `→` | Put the helm over |
| `↑` | Boost — 2.4× speed while the reserve lasts |
| `Q` / `E` | Select the port / starboard broadside |
| `S` | Swap firing side |
| `Space` | Fire the broadside |
| `M` | Mute · `H` Hide help · `Esc` Back to the lobby |

When the ten minutes are up you get a results screen: every captain with their
ships sunk, kills and losses. In a team deathmatch each fleet is listed
separately with its own totals, and the **match is won by the fleet with the
most kills** — team kills cost a captain a point but do not take a kill off the
fleet's tally, so the score is only the tie-break.

A round lasts **ten minutes**. After the first minute the battle area starts
closing in, one step every minute, through seven areas — the seventh is the
smallest, about 42% of the map, and it holds for the last three minutes so the
endgame is fought somewhere you can still manoeuvre. Get caught outside it and
you go down in about four seconds: long enough to turn and run, not long enough
to ignore. The area closes on a patch of open water picked per map, so the
endgame is a clear stretch of sea rather than an island, and it is somewhere
different every round.

**Whirlpools stop appearing once the fifth area begins** — by then there is not
enough sea room to dodge one fairly. Any already turning spin themselves out.

Your name is remembered on the device. From the front page you can join a listed
lobby or create one with a name, an optional password, and either **death match**
(every ship for itself) or **team death match** (the server splits everyone into
two teams automatically).

The lobby owner adds and removes bots, one per click. In a team deathmatch
each fleet has its own pair of buttons, so you can fill both sides — a full
4-v-4 of bots is fine, as is three humans and five bots split however you like.

### What to know before you sail

- **The wind rules everything.** There is no throttle: your speed comes entirely
  from your heading relative to the wind. Running before it is roughly three
  times faster than beating into it, and the wind slowly shifts in both
  direction and strength, so a good station one minute is a bad one the next.
  You can read the wind off the water itself — streaks race downwind, a few of
  them tipped with arrowheads, and whitecaps break when it pipes up. It never falls properly slack:
  the breeze ranges from about 0.6 to full, so a shift changes your best
  heading rather than leaving you becalmed. The sails on every ship are braced square to it too, and the
  compass shows both the wind and your own heading.
- **Broadsides, not turrets.** Guns fire square out of one side, at a fixed
  range. You aim entirely by steering. The firing side is lit up: a glowing
  rail, run-out barrels and chevrons pointing where the broadside will go,
  brightest when the guns are loaded.
- **Boost is your escape.** Holding `↑` gives you three seconds at 2.4× speed —
  enough to cover a third of the map — and the reserve takes 14 seconds to
  refill. It multiplies whatever the wind is giving you, so it will drag you off
  a lee shore even when you are beating and slow.
- **Stay out of it and she repairs herself.** Ten seconds without firing a shot
  or taking a scratch and the crew start patching her up at 4 health a second.
  One hit — or one shot of your own — resets the clock.
- **Lead your target.** A ball can be well over a second in the air.
- **Shoot over land, but not over hills.** Flat sand and grass are no obstacle;
  hills and mountains stop a shot dead.
- **Land hurts.** Sail into it and you stop and take damage. The map edge just
  stops you.
- **Ramming is a shove, not a weapon.** Bow-first into someone's flank hurts
  them more than it hurts you, but far less than a broadside, and neither ship
  can ram again for three seconds. Bow to bow, you both stop dead — but only
  for a moment; hulls always push apart rather than locking together.
- **Team damage is on.** A team kill costs you a point.
- **Whirlpools.** The outer rim can be escaped under sail. Past about halfway
  in, nothing you do will save you.
- **A ship at zero health explodes** before she goes under, throwing burning
  debris and planks in her own colours.
- **A ship loaded with super shot glows.** You can see it coming.
- **Watch the wakes.** Every ship leaves a spreading trail of disturbed water
  behind her for a few seconds — useful for working out where someone went.

### Power-ups

| | Effect |
| --- | --- |
| Larger sail | More speed (stacks up to 3). She starts under two small sails; the first upgrade sets a third, and each one after that lets out more canvas |
| Extra cannon | One more gun per side (stacks up to 6) |
| Super shot | 2.3× damage for 15 seconds — and she visibly glows while it lasts |
| Rapid fire | Shorter reload, −18% per stack (stacks up to 3: 2.1s down to 1.2s) |
| Small / large repair | +25 / +60 health |

Power-ups do not expire — a crate floats until somebody sails over it. The
spawner keeps ten on the map at a time. Picking one up shows its name above the
water, so you always know what you just got.

Every wreck is worth visiting: a sinking ship spills up to three of the
power-ups it was carrying, and if it was carrying none it still leaves one
random crate behind.

---

## How it fits together

```
server/
  index.js    HTTP static host + WebSocket endpoint + message routing
  ws.js       RFC 6455 WebSocket server (no dependencies)
  lobby.js    Lobby lifecycle, teams, bots, the per-lobby game loop
  game.js     Authoritative simulation: ships, gunnery, collisions, wind
  bot.js      Bot captains
shared/
  constants.js  Tuning values, used verbatim by both sides
  mapgen.js     Deterministic island generation
public/
  js/terrain.js  Bakes the map into an offscreen image
  js/render.js   Canvas renderer
  js/main.js     Menu flow, interpolation, frame loop
  js/net.js      Socket + snapshot buffer
  js/ui.js       Screens, lobby chrome, HUD
  js/input.js    Keyboard intent
  js/audio.js    Procedural sound, layered and positional (no audio assets)
test/
  mechanics.test.js  Game rules in isolation
  client.test.js     Client rendering against a stubbed canvas
  e2e.test.js        Real HTTP + WebSocket against a live server
```

**The server is authoritative.** Clients send intent only — turn, side, range,
fire — and receive snapshots at 20 Hz while the simulation runs at 30 Hz. The
browser decides nothing that affects the game.

**Assets are cache-busted.** `index.html` is served no-cache and every local
script and stylesheet it references carries a `?v=` build id hashed from the
asset contents. Without it a browser would take fresh HTML and keep serving
stale JavaScript from its cache after an update, leaving the page a mix of old
and new code. Versioned URLs are then safe to cache for a year; unversioned
ones must be revalidated.

**The round is the server's business too.** It owns the clock and the closing
boundary, sends both in every snapshot, and ends the match itself when the ten
minutes are up — the client only draws them and shows the final table.

**The client reconnects on its own.** Browsers, proxies and sleeping laptops all
drop idle sockets. If the line goes down, anything the player deliberately asked
for is held and replayed once it is back — their name goes out first — and
returning to a backgrounded tab reconnects immediately rather than needing a
page refresh.

**Maps travel as a seed.** The server sends about a dozen island definitions rather
than a tile grid. Both sides evaluate the identical continuous height field, so
the server gets tiles for collision and line-of-fire while the client samples it
finely enough to draw smooth, organic coastlines. Decorations (houses, windmills,
lighthouses, palms) are generated server-side so every player sees the same
island.

**The angled view** squashes the world vertically and lifts anything with height
up the screen. Cliffs get real faces, masts and sails stand upright over
foreshortened hulls.

**Boost, repair and reload are all server-side**, like everything else: the
client only sends whether the boost key is down, and reads the reserve, the
repair flag and the reload fraction back out of the snapshot.

**The front page has a battle behind it.** The menu and lobby screens sit over
a live diorama: seven ships in two fleets circling, firing broadsides, blowing
up and respawning, with gulls overhead. It is driven by the real renderer, so
it is the actual game art rather than a picture, and it stops the moment a
match is on screen.

**Seagulls are client-side only.** A flock drifts across every half minute or
so, roughly downwind, with shadows on the water and the odd cry. They are
ambient decoration, so they cost the server nothing and do not need to agree
between players.

**Sound is synthesised, not sampled.** Each effect is layered — a transient, a
body and a tail — rather than one oscillator, and a broadside fires its guns a
few milliseconds apart so six of them roll instead of clicking. Everything is
placed in the stereo field by bearing and attenuated by distance, through a
compressor so a full broadside cannot clip.

### Rendering the map

The terrain is baked once into an offscreen canvas when a match starts, then
blitted per frame. Baking samples the height field at 10-world-unit resolution
(~194k samples). The island lobe positions are flattened and cached once per map
rather than recomputed per sample — without that the bake took 2.5 seconds of
blocked main thread; it is now a few hundred milliseconds behind a progress bar.

---

## Tests

```bash
npm test
```

Three suites, ~130 checks, no test framework:

- **mechanics** — sailing angles, grounding, the map edge, broadside geometry,
  the boost reserve (drain, refill, and that it still works upwind), the
  out-of-combat repair clock and everything that resets it, rapid fire,
  shooting over flat land vs. into hills, ramming and its grace period, every
  power-up, sink drops, team-kill scoring, respawn placement, whirlpool escape
  thresholds and when they stop appearing, five collision geometries that must
  never leave two ships stuck together, the ten-minute round and its closing
  battle area (step timing, easing, drowning outside it, and that the final
  arena lands on open water),
  and map generation across several seeds (including that the client's height
  field agrees with the server's tile grid).
- **client** — loads the real client scripts against a stubbed DOM and canvas,
  including booting the whole client (main.js and all) against a fake socket
  and pushing real server messages through it in the order the server sends
  them —
  bakes a map, and renders 90 frames covering every ship state, power-up,
  particle type, decoration, zoom level and map corner. It also runs two
  simulated minutes of the front-page battle, and checks that a respawning ship
  is never drawn between her old and new positions. The stub rejects non-finite
  coordinates, which is how a canvas usually fails silently.
- **e2e** — spawns the real server and drives it over real WebSocket frames:
  static files, path traversal, the handshake, passwords, team balancing,
  per-team bots and who is allowed to touch them, capacity limits, host
  permissions, input reaching the simulation,
  disconnect cleanup, a 75-second live match, and a client that sits idle for a
  minute and must still be able to create a lobby.

Run one suite with `npm run test:mechanics`, `test:client` or `test:e2e`.

### Capacity

One Node process carrying 40 concurrent 8-ship lobbies (320 ships, all bots)
spends under **0.5% of a single core** on simulation. Outbound snapshots are
roughly 7 KiB/s per connected client, so bandwidth, not CPU, is the limit.

The world is 2800 × 2800 units, which makes for a busy sea with eight ships on
it. Cannon range is a fixed 560, so the guns reach a fifth of the way across.

---
