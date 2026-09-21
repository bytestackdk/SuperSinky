/* Super Sinky - constants shared by server and client. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SSConst = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TERRAIN = {
    WATER: 0,
    SHALLOW: 1,
    SAND: 2,
    GRASS: 3,
    HILL: 4,
    MOUNTAIN: 5
  };

  // Height thresholds used to turn the generated height field into terrain.
  var BANDS = [
    { t: TERRAIN.WATER, h: -Infinity, elev: 0 },
    { t: TERRAIN.SHALLOW, h: 0.30, elev: 0 },
    { t: TERRAIN.SAND, h: 0.40, elev: 3 },
    { t: TERRAIN.GRASS, h: 0.47, elev: 9 },
    { t: TERRAIN.HILL, h: 0.66, elev: 26 },
    { t: TERRAIN.MOUNTAIN, h: 0.84, elev: 52 }
  ];

  return {
    PROTOCOL: 3,

    TERRAIN: TERRAIN,
    BANDS: BANDS,

    // ---- world -------------------------------------------------------
    TILE: 40,
    MAP_TILES: 70,           // -> 2800 x 2800 world units
    WORLD: 70 * 40,
    FINE: 10,                // render sampling resolution of the height field
    EDGE_MARGIN: 190,        // land is kept this far from the map border
    MAX_ELEV: 52,

    TICK_HZ: 30,
    SNAPSHOT_HZ: 20,

    // ---- the round ---------------------------------------------------
    ROUND_SECONDS: 600,      // ten minutes, then the match is over
    SHRINK_START: 60,        // the first closing-in is at one minute
    SHRINK_EVERY: 60,
    SHRINK_STEPS: 7,         // one a minute, then it holds for the last two
    ZONE_FINAL: 0.42,        // final arena width as a fraction of the map
    ZONE_EASE: 6,            // seconds the boundary takes to move each step
    OUTSIDE_DPS: 25,         // caught outside, she goes down in about 4s
    ZONE_WARN: 260,          // start warning this far inside the boundary

    // ---- ships -------------------------------------------------------
    SHIP_HP: 100,
    SHIP_LEN: 76,            // bow-to-stern
    SHIP_BEAM: 26,           // width
    SHIP_HALF_LEN: 38,
    SHIP_HALF_BEAM: 13,
    BASE_SPEED: 132,         // world units / second at perfect sailing
    TURN_RATE: 1.75,         // rad / second at full way
    ACCEL: 1.9,              // how fast speed chases the wind-derived target
    RESPAWN_DELAY: 5.0,
    SPAWN_PROTECT: 2.5,

    // Boost: a short sprint on a slow-filling reserve.
    BOOST_MULT: 2.4,
    BOOST_SECONDS: 3.0,      // full reserve, spent flat out
    BOOST_REFILL: 14,        // seconds from empty back to full
    BOOST_MIN_START: 0.12,   // enough in hand to be worth engaging

    // Out of action long enough and the crew start patching her up.
    REGEN_DELAY: 10,
    REGEN_RATE: 4,           // health per second

    // ---- wind --------------------------------------------------------
    WIND_MIN: 0.62,          // it never falls properly slack any more
    WIND_MAX: 1.00,
    WIND_TURN: 0.085,        // rad / second maximum drift
    WIND_CHANGE_EVERY: [9, 20],

    // ---- gunnery -----------------------------------------------------
    RANGE: 560,              // fixed - there is no range selection any more
    BALL_SPEED: 560,
    BALL_DAMAGE: 10,
    SUPER_MULT: 2.3,
    SUPER_TIME: 15,
    RELOAD: 2.1,
    CANNONS_BASE: 2,
    CANNONS_MAX: 6,
    SPREAD: 0.055,           // radians of random scatter per ball

    // ---- collisions --------------------------------------------------
    RAM_DAMAGE: 9,
    RAM_SELF_DAMAGE: 3,
    HEADON_DAMAGE: 3,
    GROUND_DAMAGE: 13,
    GROUND_COOLDOWN: 1.1,
    COLLIDE_COOLDOWN: 3.0,   // grace period before either ship can ram again
    STUN_TIME: 0.7,

    // ---- whirlpools --------------------------------------------------
    WHIRL_LAST_AREA: 4,      // no new whirlpools once the 5th area begins
    WHIRL_MAX: 2,
    WHIRL_RADIUS: 210,
    WHIRL_LIFE: 30,
    WHIRL_SPAWN: [18, 34],
    WHIRL_PULL: 340,
    WHIRL_SWIRL: 1.15,
    WHIRL_CORE: 36,
    WHIRL_DPS: 55,

    // ---- power-ups ---------------------------------------------------
    PU_MAX: 10,              // the spawner tops the map up to this many
    PU_HARD_MAX: 30,         // safety ceiling; sink drops may push past PU_MAX
    PU_SPAWN: [2.6, 5.2],
    PU_RADIUS: 30,
    PU: {
      SAIL: 'sail',
      CANNON: 'cannon',
      SUPER: 'super',
      RAPID: 'rapid',
      REPAIR_S: 'repair_s',
      REPAIR_L: 'repair_l'
    },
    PU_WEIGHTS: [
      ['sail', 15],
      ['cannon', 18],
      ['super', 16],
      ['rapid', 17],
      ['repair_s', 24],
      ['repair_l', 12]
    ],
    SAIL_BONUS: 0.22,        // per stack
    SAIL_MAX_STACK: 3,
    RAPID_BONUS: 0.18,       // reload time cut per stack
    RAPID_MAX_STACK: 3,
    REPAIR_S_AMOUNT: 25,
    REPAIR_L_AMOUNT: 60,
    DROP_MAX: 3,

    // ---- lobbies -----------------------------------------------------
    MODE_DM: 'dm',
    MODE_TDM: 'tdm',
    MAX_PLAYERS: 8,
    TEAM_SIZE: 4,
    LOBBY_NAME_MAX: 24,
    PLAYER_NAME_MAX: 16,

    TEAM_COLORS: ['#e6394d', '#9b5de5'],
    TEAM_NAMES: ['Crimson Fleet', 'Violet Armada'],
    FFA_COLORS: [
      '#f4a259', '#5bc0eb', '#e6394d', '#9bde7e',
      '#c77dff', '#ffd166', '#ff8fa3', '#7bdff2'
    ]
  };
});
