/* Super Sinky - screens, lobby chrome and HUD updates. */
(function (global) {
  'use strict';

  var C = global.SSConst;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  var toastTimer = null;
  function toast(msg, ok) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (ok ? ' ok' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, 2800);
  }

  function showScreen(name) {
    var screens = ['menu', 'lobby', 'game'];
    for (var i = 0; i < screens.length; i++) {
      var s = $('screen-' + screens[i]);
      if (s) s.classList.toggle('active', screens[i] === name);
    }
  }

  function modeLabel(mode) {
    return mode === C.MODE_TDM ? 'Team death match' : 'Death match';
  }

  function colorFor(p, mode) {
    if (mode === C.MODE_TDM && p.team >= 0) return C.TEAM_COLORS[p.team];
    return C.FFA_COLORS[p.colorIdx % C.FFA_COLORS.length];
  }

  // =====================================================================
  // Lobby browser
  // =====================================================================

  function renderLobbyList(list, onJoin) {
    var wrap = $('lobbyList');
    wrap.innerHTML = '';
    if (!list.length) {
      var p = el('p', 'empty', 'No lobbies yet — create the first one below.');
      wrap.appendChild(p);
      return;
    }

    list.forEach(function (l) {
      var row = el('div', 'lobby-row');
      var main = el('div', 'lr-main');

      var nameLine = el('div', 'lr-name');
      nameLine.appendChild(el('span', null, l.name));
      nameLine.appendChild(el('span', 'tag ' + l.mode, l.mode === C.MODE_TDM ? '4v4' : 'FFA'));
      if (l.hasPassword) nameLine.appendChild(el('span', 'tag lock', 'locked'));
      if (l.state === 'playing') nameLine.appendChild(el('span', 'tag live', 'in progress'));
      main.appendChild(nameLine);

      var total = l.players + l.bots;
      var meta = modeLabel(l.mode) + ' · ' + total + '/' + l.capacity + ' ships';
      if (l.bots) meta += ' (' + l.bots + ' bot' + (l.bots > 1 ? 's' : '') + ')';
      main.appendChild(el('div', 'lr-meta', meta));
      row.appendChild(main);

      var btn = el('button', 'btn small', total >= l.capacity ? 'Full' : 'Join');
      btn.disabled = total >= l.capacity;
      btn.onclick = function () { onJoin(l); };
      row.appendChild(btn);

      wrap.appendChild(row);
    });
  }

  // =====================================================================
  // Lobby room
  // =====================================================================

  function renderLobby(state, myId) {
    $('lobbyTitle').textContent = state.name;
    var sub = modeLabel(state.mode);
    if (state.hasPassword) sub += ' · password protected';
    if (state.state === 'playing') sub += ' · match in progress';
    $('lobbySub').textContent = sub;
    $('crewCount').textContent = '(' + state.players.length + '/' + state.capacity + ')';

    var isHost = state.hostId === myId;
    var locked = state.state === 'playing';

    var wrap = $('teamsWrap');
    wrap.innerHTML = '';

    $('ffaBotControls').classList.toggle('hidden', state.mode === C.MODE_TDM);

    if (state.mode === C.MODE_TDM) {
      for (var t = 0; t < 2; t++) {
        var members = state.players.filter(function (p) { return p.team === t; });
        wrap.appendChild(teamBlock(
          C.TEAM_NAMES[t], C.TEAM_COLORS[t], members, myId, state, C.TEAM_SIZE, t, isHost, locked));
      }
      $('botNote').textContent = isHost
        ? 'Add bots to either side to even up the fleets.'
        : 'Only the host can add or remove bots.';
    } else {
      wrap.appendChild(teamBlock(
        null, null, state.players, myId, state, state.capacity, null, isHost, locked));
      $('botNote').textContent = isHost
        ? 'Every ship for itself.'
        : 'Every ship for itself. Only the host can add or remove bots.';
    }

    var startBtn = $('startGame');
    if (state.state === 'playing') {
      startBtn.textContent = 'Rejoin the battle';
      startBtn.disabled = false;
      $('startHint').textContent = 'The match is already under way.';
    } else {
      startBtn.textContent = 'Weigh anchor';
      startBtn.disabled = !isHost;
      $('startHint').textContent = isHost
        ? 'You are the host. Start whenever your crew is ready.'
        : 'Waiting for the host to start the match.';
    }

    var endBtn = $('endMatch');
    endBtn.classList.toggle('hidden', !(isHost && state.state === 'playing'));

    var full = state.players.length >= state.capacity;
    $('addBot').disabled = !isHost || full || locked;
    $('removeBot').disabled = !isHost || locked ||
      !state.players.some(function (p) { return p.bot; });
  }

  /** Called with ('addBot'|'removeBot', teamIndex) from the per-team buttons. */
  var onBotChange = null;
  function setBotHandler(fn) { onBotChange = fn; }

  function teamBlock(title, color, members, myId, state, slots, team, isHost, locked) {
    var block = el('div', 'team-block');
    if (title) {
      var h = el('div', 'team-title');
      var dot = el('span', 'team-dot');
      dot.style.background = color;
      h.appendChild(dot);
      h.appendChild(el('span', null, title + ' (' + members.length + '/' + slots + ')'));

      // Each fleet gets its own pair of bot buttons, for the host only.
      if (team !== null && team !== undefined) {
        var controls = el('div', 'team-bots');
        var minus = el('button', 'btn ghost small', '\u2212 Bot');
        minus.disabled = !isHost || locked || !members.some(function (p) { return p.bot; });
        minus.onclick = function () { if (onBotChange) onBotChange('removeBot', team); };
        var plus = el('button', 'btn ghost small', '+ Bot');
        plus.disabled = !isHost || locked || members.length >= slots ||
          state.players.length >= state.capacity;
        plus.onclick = function () { if (onBotChange) onBotChange('addBot', team); };
        controls.appendChild(minus);
        controls.appendChild(plus);
        h.appendChild(controls);
      }
      block.appendChild(h);
    }

    var list = el('div', 'crew-list');
    members.forEach(function (p) {
      var row = el('div', 'crew-row');
      var sw = el('span', 'swatch');
      sw.style.background = colorFor(p, state.mode);
      row.appendChild(sw);
      var who = el('span', 'who', p.name);
      if (p.id === myId) who.textContent += ' (you)';
      row.appendChild(who);
      if (p.host) row.appendChild(el('span', 'badge', 'host'));
      if (p.bot) row.appendChild(el('span', 'badge', 'bot'));
      list.appendChild(row);
    });

    for (var i = members.length; i < slots; i++) {
      list.appendChild(el('div', 'crew-row empty-slot', 'empty berth'));
    }
    block.appendChild(list);
    return block;
  }

  // =====================================================================
  // In-game HUD
  // =====================================================================

  var SIDE_NAME = { '-1': 'Port', '1': 'Starboard' };

  function windWord(strength) {
    if (strength < 0.55) return 'Light';
    if (strength < 0.72) return 'Moderate';
    if (strength < 0.88) return 'Fresh';
    return 'Strong';
  }

  /** Mirrors Game.sailEfficiency so the HUD can show your point of sail. */
  function sailEfficiency(heading, windDir) {
    var c = Math.cos(heading - windDir);
    return 0.44 + 0.56 * Math.pow((c + 1) / 2, 0.85);
  }

  function pointOfSail(heading, windDir) {
    var d = Math.abs(Math.atan2(Math.sin(heading - windDir), Math.cos(heading - windDir)));
    if (d < 0.6) return 'running';
    if (d < 1.9) return 'reaching';
    return 'beating';
  }

  function formatClock(seconds) {
    var t = Math.max(0, Math.ceil(seconds));
    var m = Math.floor(t / 60);
    var ss = t % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function updateRound(state) {
    var timer = $('roundTimer');
    if (timer) {
      timer.textContent = formatClock(state.timeLeft);
      timer.className = 'round-timer' + (state.timeLeft <= 30 ? ' low' : '');
    }

    var note = $('roundNote');
    if (note) {
      var untilShrink = state.nextShrinkIn;
      if (state.shrinks >= C.SHRINK_STEPS) {
        note.textContent = 'Final battle area';
        note.className = 'round-note urgent';
      } else if (untilShrink !== null && untilShrink <= 10) {
        note.textContent = 'Closing in ' + Math.ceil(untilShrink) + 's';
        note.className = 'round-note urgent';
      } else {
        note.textContent = 'Area ' + state.shrinks + ' / ' + C.SHRINK_STEPS;
        note.className = 'round-note';
      }
    }

    var warn = $('zoneWarn');
    if (warn) warn.classList.toggle('hidden', !state.meOutside);
  }

  function updateHud(state) {
    var me = state.me;
    updateRound(state);

    // Wind readout: strength, and how well your current heading uses it.
    var windEl = $('windSpeed');
    if (windEl) {
      if (me && me.alive) {
        var eff = sailEfficiency(me.angle, state.wind.dir);
        windEl.textContent = windWord(state.wind.strength) + ' \u00b7 ' +
          Math.round(eff * 100) + '% ' + pointOfSail(me.angle, state.wind.dir);
      } else {
        windEl.textContent = windWord(state.wind.strength);
      }
    }

    // --- own ship card ---
    if (me) {
      $('ownName').textContent = me.name;
      $('scorePill').textContent = me.score >= 0 ? me.score : me.score;

      var hpFrac = Math.max(0, Math.min(1, me.hp / C.SHIP_HP));
      var hpBar = $('healthFill').parentElement;
      hpBar.className = 'bar health' + (hpFrac <= 0.25 ? ' critical' : (hpFrac <= 0.55 ? ' hurt' : ''));
      $('healthFill').style.width = (hpFrac * 100) + '%';
      $('healthText').textContent = Math.round(me.hp);

      var rl = Math.max(0, Math.min(1, me.reload));
      var rlBar = $('reloadFill').parentElement;
      rlBar.className = 'bar reload' + (rl >= 1 ? ' ready' : '');
      $('reloadFill').style.width = (rl * 100) + '%';
      $('reloadText').textContent = rl >= 1 ? 'GUNS READY' : 'RELOADING';

      var boost = Math.max(0, Math.min(1, me.boost || 0));
      var boostBar = $('boostFill').parentElement;
      boostBar.className = 'bar boost' +
        (me.boosting ? ' firing' : (boost >= 1 ? ' full' : (boost < 0.12 ? ' empty' : '')));
      $('boostFill').style.width = (boost * 100) + '%';
      $('boostText').textContent = me.boosting
        ? 'BOOSTING'
        : (boost >= 1 ? 'BOOST READY' : 'BOOST ' + Math.round(boost * 100) + '%');

      $('sideLabel').textContent = SIDE_NAME[String(me.side)] || '—';
      $('gunLabel').textContent = me.cannons + ' / side';

      var buffs = $('buffs');
      buffs.innerHTML = '';
      if (me.sails > 0) buffs.appendChild(el('span', 'buff sail', 'Sails +' + me.sails));
      if (me.cannons > C.CANNONS_BASE) {
        buffs.appendChild(el('span', 'buff', 'Guns +' + (me.cannons - C.CANNONS_BASE)));
      }
      if (me.rapid > 0) buffs.appendChild(el('span', 'buff rapid', 'Fire rate +' + me.rapid));
      if (me.range > 0) buffs.appendChild(el('span', 'buff range', 'Range +' + me.range));
      if (me.superTime > 0) {
        buffs.appendChild(el('span', 'buff super', 'Super shot ' + me.superTime.toFixed(1) + 's'));
      }
      if (me.regen) buffs.appendChild(el('span', 'buff regen', 'Repairing'));

      var resp = $('respawn');
      if (!me.alive) {
        resp.classList.remove('hidden');
        $('respawnText').textContent = me.respawnIn > 0
          ? 'Refitting — back in ' + me.respawnIn.toFixed(1) + 's'
          : 'Making sail...';
      } else {
        resp.classList.add('hidden');
      }
    }

    renderScoreboard(state);
  }

  function renderScoreboard(state) {
    var board = $('scoreboard');
    var ships = state.ships.slice();

    if (state.mode === C.MODE_TDM) {
      var totals = [0, 0];
      ships.forEach(function (s) { if (s.team === 0 || s.team === 1) totals[s.team] += s.score; });
      board.innerHTML = '';
      for (var t = 0; t < 2; t++) {
        var head = el('div', 'team-score-head');
        var left = el('span');
        var dot = el('span', 'dot');
        dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:' + C.TEAM_COLORS[t];
        left.appendChild(dot);
        left.appendChild(document.createTextNode(C.TEAM_NAMES[t]));
        head.appendChild(left);
        head.appendChild(el('b', null, String(totals[t])));
        head.style.color = C.TEAM_COLORS[t];
        board.appendChild(head);

        ships.filter(function (s) { return s.team === t; })
          .sort(function (a, b) { return b.score - a.score; })
          .forEach(function (s) { board.appendChild(scoreRow(s, state)); });
      }
    } else {
      board.innerHTML = '';
      var head2 = el('div', 'score-head');
      head2.appendChild(el('span', null, 'Ships sunk'));
      head2.appendChild(el('span', null, String(state.ships.length)));
      board.appendChild(head2);
      ships.sort(function (a, b) { return b.score - a.score; })
        .forEach(function (s) { board.appendChild(scoreRow(s, state)); });
    }
  }

  function scoreRow(s, state) {
    var row = el('div', 'score-row' + (s.id === state.meId ? ' me' : '') + (s.alive ? '' : ' dead'));
    var dot = el('span', 'dot');
    dot.style.background = s.color;
    row.appendChild(dot);
    var nm = el('span', 'nm', s.name);
    row.appendChild(nm);
    if (s.isBot) row.appendChild(el('span', 'bt', 'BOT'));
    row.appendChild(el('span', 'pts', String(s.score)));
    return row;
  }

  // =====================================================================
  // Kill feed
  // =====================================================================

  function pushKill(html, teamKill) {
    var feed = $('killfeed');
    var line = el('div', 'kill-line' + (teamKill ? ' tk' : ''));
    line.innerHTML = html;
    feed.appendChild(line);
    if (feed.children.length > 5) feed.removeChild(feed.firstChild);
    setTimeout(function () {
      if (line.parentNode) line.parentNode.removeChild(line);
    }, 5200);
  }

  /** Totals for one fleet. The team result is decided on kills. */
  function teamTally(rows, team) {
    var t = { kills: 0, deaths: 0, score: 0 };
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].team !== team) continue;
      t.kills += rows[i].kills;
      t.deaths += rows[i].deaths;
      t.score += rows[i].score;
    }
    return t;
  }

  function columnHeader() {
    var head = el('div', 'standing-cols');
    head.appendChild(el('span', 'rank', ''));
    head.appendChild(el('span', 'dot', ''));
    head.appendChild(el('span', 'nm', 'Captain'));
    head.appendChild(el('span', 'num', 'Sunk'));
    head.appendChild(el('span', 'num', 'Kills'));
    head.appendChild(el('span', 'num', 'Lost'));
    return head;
  }

  function showStandings(msg, myId) {
    var box = $('standings');
    if (!box) return;
    box.innerHTML = '';

    var rows = (msg.standings || []).slice();
    var banner = $('matchWinner');
    var sub = $('matchOverSub');
    banner.className = 'match-winner';
    banner.textContent = '';
    banner.style.color = '';

    $('matchOverTitle').textContent = msg.timeUp ? 'Time!' : 'Match over';

    if (!rows.length) {
      sub.textContent = 'No ships were in the water.';
      $('matchOver').classList.remove('hidden');
      return;
    }

    if (msg.mode === C.MODE_TDM) {
      showTeamResult(box, rows, banner, sub, myId);
    } else {
      showFreeForAllResult(box, rows, banner, sub, myId);
    }

    $('matchOver').classList.remove('hidden');
  }

  function showFreeForAllResult(box, rows, banner, sub, myId) {
    // The server already sorts on score, then kills, then fewest losses.
    var top = rows[0];
    var tied = rows.filter(function (r) {
      return r.score === top.score && r.kills === top.kills && r.deaths === top.deaths;
    });

    if (tied.length > 1) {
      banner.className = 'match-winner draw';
      banner.textContent = 'A draw \u2014 ' + top.score + (top.score === 1 ? ' ship' : ' ships') + ' each';
      sub.textContent = tied.map(function (r) { return r.name; }).join(', ') + ' finish level.';
    } else {
      banner.textContent = '\u2691 ' + top.name;
      banner.style.color = C.FFA_COLORS[top.colorIdx % C.FFA_COLORS.length];
      sub.textContent = 'Wins with ' + top.score + (top.score === 1 ? ' ship sunk' : ' ships sunk') +
        ', losing ' + top.deaths + (top.deaths === 1 ? ' of her own.' : ' of her own.');
    }

    box.appendChild(columnHeader());
    rows.forEach(function (r, i) {
      box.appendChild(standingRow(r, i, myId, C.MODE_DM, tied.length === 1 && i === 0));
    });
  }

  function showTeamResult(box, rows, banner, sub, myId) {
    var tally = [teamTally(rows, 0), teamTally(rows, 1)];

    // The fleet that sank the most enemy ships takes the match. Team kills
    // cost a captain a point, so score is the tie-break, then fewest losses.
    var winner = -1;
    if (tally[0].kills !== tally[1].kills) winner = tally[0].kills > tally[1].kills ? 0 : 1;
    else if (tally[0].score !== tally[1].score) winner = tally[0].score > tally[1].score ? 0 : 1;
    else if (tally[0].deaths !== tally[1].deaths) winner = tally[0].deaths < tally[1].deaths ? 0 : 1;

    if (winner < 0) {
      banner.className = 'match-winner draw';
      banner.textContent = 'A draw \u2014 ' + tally[0].kills + ' kills each';
      sub.textContent = 'Neither fleet could be separated.';
    } else {
      banner.textContent = '\u2691 ' + C.TEAM_NAMES[winner];
      banner.style.color = C.TEAM_COLORS[winner];
      var w = tally[winner], l = tally[1 - winner];
      var line = 'Take the match on kills, ' + w.kills + ' to ' + l.kills + '.';
      if (w.score !== w.kills || l.score !== l.kills) {
        line += ' Scores after team kills: ' + w.score + ' to ' + l.score + '.';
      }
      sub.textContent = line;
    }

    // Winning fleet first.
    var order = winner < 0 ? [0, 1] : [winner, 1 - winner];
    order.forEach(function (t) {
      var head = el('div', 'team-total');
      var dot = el('span', 'team-dot');
      dot.style.background = C.TEAM_COLORS[t];
      head.appendChild(dot);
      head.appendChild(el('span', 'nm', C.TEAM_NAMES[t]));
      if (t === winner) head.appendChild(el('span', 'won', 'Winner'));
      head.appendChild(el('span', 'tot', tally[t].kills + (tally[t].kills === 1 ? ' kill' : ' kills')));
      head.style.color = C.TEAM_COLORS[t];
      box.appendChild(head);

      box.appendChild(columnHeader());
      rows.filter(function (r) { return r.team === t; })
        .forEach(function (r, i) {
          box.appendChild(standingRow(r, i, myId, C.MODE_TDM, t === winner));
        });
    });
  }

  function standingRow(r, i, myId, mode, highlight) {
    var row = el('div', 'standing-row' +
      (r.id === myId ? ' me' : '') + (highlight ? ' winner' : ''));
    row.appendChild(el('span', 'rank', '#' + (i + 1)));
    var dot = el('span', 'dot');
    dot.style.background = mode === C.MODE_TDM && r.team >= 0
      ? C.TEAM_COLORS[r.team]
      : C.FFA_COLORS[r.colorIdx % C.FFA_COLORS.length];
    row.appendChild(dot);
    row.appendChild(el('span', 'nm', r.name + (r.bot ? ' \u2699' : '')));
    row.appendChild(el('span', 'num sunk', String(r.score)));
    row.appendChild(el('span', 'num dim', String(r.kills)));
    row.appendChild(el('span', 'num dim', String(r.deaths)));
    return row;
  }

  global.UI = {
    $: $, el: el, toast: toast, showScreen: showScreen,
    modeLabel: modeLabel, colorFor: colorFor,
    renderLobbyList: renderLobbyList, renderLobby: renderLobby,
    setBotHandler: setBotHandler,
    updateHud: updateHud, pushKill: pushKill,
    showStandings: showStandings, formatClock: formatClock
  };
})(window);
