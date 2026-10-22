'use strict';

/* =========================================================================
   Football Manager Lite — motor + interface
   Inclui exportação da rodada atual em CSV e TSV.
   Arquivo único, blindado contra execução duplicada via IIFE + guarda.
   ========================================================================= */

(function () {

  /* ------------------------- Guarda anti-duplicação ------------------------- */
  if (window.__FML_LOADED__) {
    if (window.console && console.warn) {
      console.warn('Football Manager Lite: app.js já carregado — execução duplicada ignorada.');
    }
    return;
  }
  window.__FML_LOADED__ = true;

  /* ------------------------- Configuração ------------------------- */
  const HOME_ADV        = 3;
  const NOISE           = 3;
  const K               = 0.032;
  const BASE_GOALS      = 1.30;
  const MAX_DIFF        = 26;
  const MAX_GOALS       = 7;
  const FORM_WEIGHT     = 2;
  const ROUNDS          = 99;
  const PROMOTED_COUNT  = 30;
  const RELEGATED_COUNT = 30;
  const REP_UPDATE_ROUNDS = [20, 40, 60, 80, 99];
  const REP_FACTOR      = 0.10;
  const REP_CAP         = 2.0;
  const STORAGE_KEY     = 'football-manager-v3';

  const TOTAL_TEAMS    = TEAMS_DATA.length;
  const TEAMS_PER_DIV  = Math.ceil(TOTAL_TEAMS / 3);
  const MIN_OVR        = Math.min.apply(null, TEAMS_DATA.map(function (t) { return t[1]; })) - 5;
  const MAX_OVR        = Math.max.apply(null, TEAMS_DATA.map(function (t) { return t[1]; })) + 5;

  /* ------------------------- Utilidades ------------------------- */

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function gauss() {
    var u = 0;
    var v = 0;
    while (u === 0) { u = Math.random(); }
    while (v === 0) { v = Math.random(); }
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function poisson(l) {
    var L = Math.exp(-l);
    var k = 0;
    var p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtOvr(v) {
    var r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function divisionOfIndex(idx) {
    if (idx < TEAMS_PER_DIV) { return 1; }
    if (idx < TEAMS_PER_DIV * 2) { return 2; }
    return 3;
  }

  /* Escapa um campo para CSV/TSV: envolve em aspas se contiver o separador,
     aspas, quebra de linha ou CR. Aspas internas viram "" (padrão RFC 4180). */
  function escapeDelimitedField(val, sep) {
    var s = String(val == null ? '' : val);
    if (s.indexOf('"') !== -1 ||
        s.indexOf(sep) !== -1 ||
        s.indexOf('\n') !== -1 ||
        s.indexOf('\r') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /* ------------------------- Estado ------------------------- */

  var state = null;
  var activeTab = 'div1';

  function createInitialState(season) {
    var teams = TEAMS_DATA.map(function (t, i) {
      return {
        id: i,
        name: t[0],
        country: t[2],
        overall: t[1],
        division: divisionOfIndex(i),
        form: [],
        lastRepDelta: 0,
        stats: { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 }
      };
    });

    var st = {
      season: season || 2025,
      round: 0,
      teams: teams,
      fixtures: { div1: [], div2: [], div3: [] },
      results: { div1: [], div2: [], div3: [] },
      history: [],
      repLog: [],
      lastRepUpdateRound: 0
    };

    buildFixtures(st);
    return st;
  }

  /* ------------------------- Calendário (método do círculo) ------------------------- */

  function circleMethod(ids) {
    var n = ids.length;
    var rot = ids.slice();
    var rounds = [];
    var totalRounds = n - 1;
    var half = n / 2;

    for (var r = 0; r < totalRounds; r++) {
      var games = [];
      for (var i = 0; i < half; i++) {
        var a = rot[i];
        var b = rot[n - 1 - i];
        if ((r + i) % 2 === 0) {
          games.push([a, b]);
        } else {
          games.push([b, a]);
        }
      }
      rounds.push(games);

      var next = [rot[0], rot[n - 1]].concat(rot.slice(1, n - 1));
      for (var j = 0; j < n; j++) {
        rot[j] = next[j];
      }
    }

    return rounds;
  }

  function buildFixtures(st) {
    st.fixtures = { div1: [], div2: [], div3: [] };
    st.results = { div1: [], div2: [], div3: [] };

    for (var d = 1; d <= 3; d++) {
      var key = 'div' + d;
      var ids = [];
      for (var i = 0; i < st.teams.length; i++) {
        if (st.teams[i].division === d) { ids.push(st.teams[i].id); }
      }
      var rounds = circleMethod(ids);
      st.fixtures[key] = rounds;
      st.results[key] = rounds.map(function () { return null; });
    }
  }

  /* ------------------------- Motor de partida ------------------------- */

  function calcForm(form) {
    if (form.length === 0) { return 0; }
    var pts = form.reduce(function (a, r) {
      return a + (r === 'W' ? 3 : r === 'D' ? 1 : 0);
    }, 0);
    return (pts / form.length - 1.5) * FORM_WEIGHT;
  }

  function simularPartida(home, away) {
    var formH = calcForm(home.form);
    var formA = calcForm(away.form);

    var diff = (home.overall + HOME_ADV + formH) - (away.overall + formA);
    diff += gauss() * NOISE;
    diff = clamp(diff, -MAX_DIFF, MAX_DIFF);

    var lamH = BASE_GOALS * Math.exp(K * diff);
    var lamA = BASE_GOALS * Math.exp(-K * diff);

    return {
      gH: Math.min(MAX_GOALS, poisson(lamH)),
      gA: Math.min(MAX_GOALS, poisson(lamA))
    };
  }

  function pushForm(team, res) {
    team.form.push(res);
    if (team.form.length > 5) { team.form.shift(); }
  }

  function applyResult(home, away, sc) {
    home.stats.played++;
    away.stats.played++;

    home.stats.gf += sc.gH;
    home.stats.ga += sc.gA;
    away.stats.gf += sc.gA;
    away.stats.ga += sc.gH;

    home.stats.gd = home.stats.gf - home.stats.ga;
    away.stats.gd = away.stats.gf - away.stats.ga;

    if (sc.gH > sc.gA) {
      home.stats.won++;
      home.stats.pts += 3;
      away.stats.lost++;
      pushForm(home, 'W');
      pushForm(away, 'L');
    } else if (sc.gH < sc.gA) {
      away.stats.won++;
      away.stats.pts += 3;
      home.stats.lost++;
      pushForm(home, 'L');
      pushForm(away, 'W');
    } else {
      home.stats.drawn++;
      away.stats.drawn++;
      home.stats.pts++;
      away.stats.pts++;
      pushForm(home, 'D');
      pushForm(away, 'D');
    }
  }

  /* ------------------------- Atualização de overall ------------------------- */

  function expectedPts(myOvr, oppOvr, isHome) {
    var diff = myOvr - oppOvr + (isHome ? HOME_ADV : -HOME_ADV);
    var pWin = 1 / (1 + Math.exp(-0.10 * diff));
    var pDraw = 0.25 * Math.exp(-0.015 * diff * diff);
    return 3 * pWin + pDraw;
  }

  function updateOveralls(st) {
    var acc = {};
    st.teams.forEach(function (t) {
      acc[t.id] = { real: 0, exp: 0 };
    });

    for (var d = 1; d <= 3; d++) {
      var key = 'div' + d;
      var fixtures = st.fixtures[key];
      var results = st.results[key];

      for (var r = st.lastRepUpdateRound; r < st.round; r++) {
        var fx = fixtures[r];
        var res = results[r];
        if (!fx || !res) { continue; }

        for (var g = 0; g < fx.length; g++) {
          var pair = fx[g];
          var sc = res[g];
          if (!sc) { continue; }

          var home = st.teams[pair[0]];
          var away = st.teams[pair[1]];

          var rh = 0;
          var ra = 0;
          if (sc.gH > sc.gA) { rh = 3; ra = 0; }
          else if (sc.gH < sc.gA) { rh = 0; ra = 3; }
          else { rh = 1; ra = 1; }

          acc[home.id].real += rh;
          acc[away.id].real += ra;

          acc[home.id].exp += expectedPts(home.overall, away.overall, true);
          acc[away.id].exp += expectedPts(away.overall, home.overall, false);
        }
      }
    }

    var changes = [];

    st.teams.forEach(function (t) {
      var a = acc[t.id];
      var delta = (a.real - a.exp) * REP_FACTOR;
      delta = clamp(delta, -REP_CAP, REP_CAP);

      var oldOvr = t.overall;
      t.overall = clamp(t.overall + delta, MIN_OVR, MAX_OVR);

      var applied = t.overall - oldOvr;
      t.lastRepDelta = applied;

      if (Math.abs(applied) >= 0.005) {
        changes.push({
          team: t.name,
          oldOvr: round2(oldOvr),
          newOvr: round2(t.overall),
          delta: round2(applied)
        });
      }
    });

    changes.sort(function (a, b) {
      return Math.abs(b.delta) - Math.abs(a.delta);
    });

    st.repLog.unshift({ round: st.round, changes: changes });
    if (st.repLog.length > 20) {
      st.repLog.length = 20;
    }
    st.lastRepUpdateRound = st.round;
  }

  /* ------------------------- Simulação ------------------------- */

  function simulateOneRound() {
    if (state.round >= ROUNDS) { return false; }

    var r = state.round;

    for (var d = 1; d <= 3; d++) {
      var key = 'div' + d;
      var fx = state.fixtures[key][r];
      var out = [];

      for (var g = 0; g < fx.length; g++) {
        var pair = fx[g];
        var home = state.teams[pair[0]];
        var away = state.teams[pair[1]];
        var sc = simularPartida(home, away);
        out.push(sc);
        applyResult(home, away, sc);
      }

      state.results[key][r] = out;
    }

    state.round++;

    if (REP_UPDATE_ROUNDS.indexOf(state.round) !== -1) {
      updateOveralls(state);
    }

    return true;
  }

  /* ------------------------- Classificação ------------------------- */

  function getStandings(st, div) {
    var teams = st.teams.filter(function (t) { return t.division === div; });

    teams.sort(function (a, b) {
      if (b.stats.pts !== a.stats.pts) { return b.stats.pts - a.stats.pts; }
      if (b.stats.gd !== a.stats.gd) { return b.stats.gd - a.stats.gd; }
      if (b.stats.gf !== a.stats.gf) { return b.stats.gf - a.stats.gf; }
      return a.name.localeCompare(b.name);
    });

    return teams;
  }

  /* ------------------------- Fim de temporada ------------------------- */

  function endOfSeason(st) {
    var d1 = getStandings(st, 1);
    var d2 = getStandings(st, 2);
    var d3 = getStandings(st, 3);

    var relegatedToDiv2 = d1.slice(d1.length - RELEGATED_COUNT);
    var promotedToDiv1 = d2.slice(0, PROMOTED_COUNT);
    var relegatedToDiv3 = d2.slice(d2.length - RELEGATED_COUNT);
    var promotedToDiv2 = d3.slice(0, PROMOTED_COUNT);

    st.history.unshift({
      season: st.season,
      div1Champion: d1[0] ? d1[0].name : '—',
      div2Champion: d2[0] ? d2[0].name : '—',
      div3Champion: d3[0] ? d3[0].name : '—',
      promotedToDiv1: promotedToDiv1.map(function (t) { return t.name; }),
      promotedToDiv2: promotedToDiv2.map(function (t) { return t.name; }),
      relegatedToDiv2: relegatedToDiv2.map(function (t) { return t.name; }),
      relegatedToDiv3: relegatedToDiv3.map(function (t) { return t.name; })
    });

    promotedToDiv1.forEach(function (t) { t.division = 1; });
    relegatedToDiv2.forEach(function (t) { t.division = 2; });
    promotedToDiv2.forEach(function (t) { t.division = 2; });
    relegatedToDiv3.forEach(function (t) { t.division = 3; });

    st.teams.forEach(function (t) {
      t.stats = { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
      t.form = [];
      t.lastRepDelta = 0;
    });

    st.season++;
    st.round = 0;
    st.lastRepUpdateRound = 0;
    buildFixtures(st);
  }

  /* ------------------------- Persistência ------------------------- */

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* Armazenamento indisponível ou cheio — segue sem persistir. */
    }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { return null; }

      var obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.teams) || obj.teams.length !== TEAMS_DATA.length) {
        return null;
      }
      if (!obj.fixtures || !obj.results) { return null; }
      if (!obj.fixtures.div1 || !obj.fixtures.div2 || !obj.fixtures.div3) { return null; }
      if (!obj.results.div1 || !obj.results.div2 || !obj.results.div3) { return null; }

      return obj;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------- Exportação da rodada (CSV/TSV) ------------------------- */

  function exportRound(fmt) {
    if (state.round === 0) {
      alert('Nenhuma rodada simulada ainda.\nSimule ao menos uma rodada antes de exportar.');
      return;
    }

    var r = state.round - 1;
    var sep = (fmt === 'tsv') ? '\t' : ';';
    var ext = (fmt === 'tsv') ? 'tsv' : 'csv';
    var mime = (fmt === 'tsv')
      ? 'text/tab-separated-values;charset=utf-8'
      : 'text/csv;charset=utf-8';

    var header = [
      'Rodada', 'Divisão',
      'Casa', 'País Casa', 'OVR Casa',
      'Gols Casa', 'Gols Fora',
      'OVR Fora', 'País Fora', 'Visitante'
    ];

    var rows = [header];

    for (var d = 1; d <= 3; d++) {
      var key = 'div' + d;
      var fx = (state.fixtures[key] && state.fixtures[key][r]) ? state.fixtures[key][r] : [];
      var res = (state.results[key] && state.results[key][r]) ? state.results[key][r] : [];

      for (var i = 0; i < fx.length; i++) {
        var h = state.teams[fx[i][0]];
        var a = state.teams[fx[i][1]];
        var sc = res[i] || { gH: 0, gA: 0 };

        rows.push([
          state.round,
          'Divisão ' + d,
          h.name,
          h.country,
          fmtOvr(h.overall),
          sc.gH,
          sc.gA,
          fmtOvr(a.overall),
          a.country,
          a.name
        ]);
      }
    }

    var lines = rows.map(function (row) {
      return row.map(function (v) {
        return escapeDelimitedField(v, sep);
      }).join(sep);
    });

    var content = '\uFEFF' + lines.join('\r\n') + '\r\n';

    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);

    var aEl = document.createElement('a');
    aEl.href = url;
    aEl.download = 'rodada-' + pad2(state.round) +
                   '-temporada-' + state.season +
                   '.' + ext;
    document.body.appendChild(aEl);
    aEl.click();
    document.body.removeChild(aEl);

    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ------------------------- Renderização ------------------------- */

  function renderStandings(div) {
    var teams = getStandings(state, div);
    var n = teams.length;

    var rows = teams.map(function (t, i) {
      var pos = i + 1;
      var cls = '';

      if (div === 1) {
        if (pos > n - RELEGATED_COUNT) { cls = 'zone-releg'; }
      } else if (div === 2) {
        if (pos <= PROMOTED_COUNT) { cls = 'zone-promo'; }
        else if (pos > n - RELEGATED_COUNT) { cls = 'zone-releg'; }
      } else {
        if (pos <= PROMOTED_COUNT) { cls = 'zone-promo'; }
      }

      var arrow = '';
      if (t.lastRepDelta > 0.05) { arrow = '<span class="ovr-up">▲</span>'; }
      else if (t.lastRepDelta < -0.05) { arrow = '<span class="ovr-down">▼</span>'; }

      return '<tr class="' + cls + '">' +
        '<td class="col-pos">' + pos + '</td>' +
        '<td class="col-team">' + escapeHtml(t.name) + '</td>' +
        '<td class="col-country">' + escapeHtml(t.country) + '</td>' +
        '<td class="col-ovr">' + fmtOvr(t.overall) + ' ' + arrow + '</td>' +
        '<td>' + t.stats.pts + '</td>' +
        '<td>' + t.stats.played + '</td>' +
        '<td>' + t.stats.won + '</td>' +
        '<td>' + t.stats.drawn + '</td>' +
        '<td>' + t.stats.lost + '</td>' +
        '<td>' + t.stats.gf + '</td>' +
        '<td>' + t.stats.ga + '</td>' +
        '<td>' + (t.stats.gd > 0 ? '+' + t.stats.gd : t.stats.gd) + '</td>' +
        '<td class="col-pts">' + t.stats.pts + '</td>' +
        '</tr>';
    }).join('');

    var legend = '';
    if (div === 1) {
      legend = '<span><span class="dot dot-red"></span>Rebaixamento (últimos ' + RELEGATED_COUNT + ')</span>';
    } else if (div === 2) {
      legend = '<span><span class="dot dot-green"></span>Promoção (top ' + PROMOTED_COUNT + ')</span>' +
               '<span><span class="dot dot-red"></span>Rebaixamento (últimos ' + RELEGATED_COUNT + ')</span>';
    } else {
      legend = '<span><span class="dot dot-green"></span>Promoção (top ' + PROMOTED_COUNT + ')</span>';
    }

    return '<section class="panel">' +
      '<div class="panel-head">' +
        '<h2>Divisão ' + div + ' — Classificação</h2>' +
        '<span class="meta">' + n + ' clubes · ' + state.round + '/' + ROUNDS + ' rodadas jogadas</span>' +
      '</div>' +
      '<div class="table-scroll">' +
        '<table class="standings">' +
          '<thead><tr>' +
            '<th>#</th>' +
            '<th class="col-team">Time</th>' +
            '<th class="col-country">País</th>' +
            '<th>OVR</th>' +
            '<th>P</th>' +
            '<th>J</th>' +
            '<th>V</th>' +
            '<th>E</th>' +
            '<th>D</th>' +
            '<th>GP</th>' +
            '<th>GC</th>' +
            '<th>SG</th>' +
            '<th>Pts</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="legend">' + legend +
        '<span><span class="ovr-up">▲</span> overall subiu na última atualização</span>' +
        '<span><span class="ovr-down">▼</span> overall caiu na última atualização</span>' +
      '</div>' +
    '</section>';
  }

  function renderRound() {
    if (state.round === 0) {
      return '<div class="empty">Nenhuma rodada simulada ainda. Clique em "Simular Rodada" para começar.</div>';
    }

    var r = state.round - 1;
    var html = '<h2 class="round-title">Rodada ' + state.round + ' / ' + ROUNDS + '</h2>';

    for (var d = 1; d <= 3; d++) {
      var key = 'div' + d;
      var fx = (state.fixtures[key] && state.fixtures[key][r]) ? state.fixtures[key][r] : [];
      var res = (state.results[key] && state.results[key][r]) ? state.results[key][r] : [];

      html += '<section class="round-div">';
      html += '<h3>Divisão ' + d + ' — ' + fx.length + ' jogos</h3>';
      html += '<ul class="games">';

      for (var i = 0; i < fx.length; i++) {
        var home = state.teams[fx[i][0]];
        var away = state.teams[fx[i][1]];
        var sc = res[i] || { gH: 0, gA: 0 };

        html += '<li class="game">' +
          '<span class="g-home">' + escapeHtml(home.name) + '</span>' +
          '<span class="g-score">' + sc.gH + ' — ' + sc.gA + '</span>' +
          '<span class="g-away">' + escapeHtml(away.name) + '</span>' +
          '</li>';
      }

      html += '</ul></section>';
    }

    return html;
  }

  function renderRepLog() {
    if (!state.repLog.length) {
      return '<div class="empty">Nenhuma atualização de overall registrada ainda. Elas ocorrem nas rodadas 20, 40, 60, 80 e 99.</div>';
    }

    var html = '';

    state.repLog.forEach(function (entry) {
      html += '<div class="rep-entry">';
      html += '<h3>Rodada ' + entry.round + ' — ' + entry.changes.length + ' clube(s) ajustado(s)</h3>';

      if (!entry.changes.length) {
        html += '<ul class="rep-list"><li>Sem alterações relevantes nesta janela.</li></ul>';
      } else {
        html += '<ul class="rep-list">';
        entry.changes.slice(0, 10).forEach(function (c) {
          var cls = c.delta > 0 ? 'delta-up' : 'delta-down';
          var sign = c.delta > 0 ? '+' : '';
          html += '<li>' +
            '<span class="rep-name">' + escapeHtml(c.team) + '</span>: ' +
            fmtOvr(c.oldOvr) + ' → ' + fmtOvr(c.newOvr) + ' ' +
            '<span class="' + cls + '">(' + sign + c.delta.toFixed(2) + ')</span>' +
          '</li>';
        });
        html += '</ul>';
      }

      html += '</div>';
    });

    return html;
  }

  function renderSeasons() {
    if (!state.history.length) {
      return '<div class="empty">Nenhuma temporada concluída ainda.</div>';
    }

    var html = '';

    state.history.forEach(function (h) {
      html += '<details class="season-card">';
      html += '<summary>Temporada ' + h.season + ' — Campeões: ' +
        escapeHtml(h.div1Champion) + ' (D1) · ' +
        escapeHtml(h.div2Champion) + ' (D2) · ' +
        escapeHtml(h.div3Champion) + ' (D3)</summary>';

      html += '<div class="season-body">';

      html += '<div class="champ-grid">' +
        '<div class="champ">Divisão 1<strong>' + escapeHtml(h.div1Champion) + '</strong></div>' +
        '<div class="champ">Divisão 2<strong>' + escapeHtml(h.div2Champion) + '</strong></div>' +
        '<div class="champ">Divisão 3<strong>' + escapeHtml(h.div3Champion) + '</strong></div>' +
      '</div>';

      html += '<div class="move-list"><h4 class="up">Promovidos à Divisão 1</h4><ol>' +
        h.promotedToDiv1.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') +
        '</ol></div>';

      html += '<div class="move-list"><h4 class="up">Promovidos à Divisão 2</h4><ol>' +
        h.promotedToDiv2.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') +
        '</ol></div>';

      html += '<div class="move-list"><h4 class="down">Rebaixados à Divisão 2</h4><ol>' +
        h.relegatedToDiv2.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') +
        '</ol></div>';

      html += '<div class="move-list"><h4 class="down">Rebaixados à Divisão 3</h4><ol>' +
        h.relegatedToDiv3.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') +
        '</ol></div>';

      html += '</div></details>';
    });

    return html;
  }

  function renderHistory() {
    return '<section class="history-block">' +
        '<h2>Atualizações de Overall</h2>' +
        renderRepLog() +
      '</section>' +
      '<section class="history-block">' +
        '<h2>Temporadas Concluídas</h2>' +
        renderSeasons() +
      '</section>';
  }

  function renderAll() {
    document.getElementById('status').textContent =
      'Temporada ' + state.season + ' · Rodada ' + state.round + '/' + ROUNDS;

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].dataset.tab === activeTab) {
        tabs[i].classList.add('active');
      } else {
        tabs[i].classList.remove('active');
      }
    }

    var content = document.getElementById('content');

    if (activeTab === 'div1') {
      content.innerHTML = renderStandings(1);
    } else if (activeTab === 'div2') {
      content.innerHTML = renderStandings(2);
    } else if (activeTab === 'div3') {
      content.innerHTML = renderStandings(3);
    } else if (activeTab === 'round') {
      content.innerHTML = renderRound();
    } else {
      content.innerHTML = renderHistory();
    }
  }

  /* ------------------------- Ações da interface ------------------------- */

  function simularRodada() {
    if (state.round >= ROUNDS) {
      alert('Temporada já concluída. Clique em "Nova Temporada" para iniciar a próxima.');
      return;
    }
    simulateOneRound();
    saveState();
    renderAll();
  }

  function simularCinco() {
    if (state.round >= ROUNDS) {
      alert('Temporada já concluída. Clique em "Nova Temporada" para iniciar a próxima.');
      return;
    }
    for (var i = 0; i < 5; i++) {
      if (state.round >= ROUNDS) { break; }
      simulateOneRound();
    }
    saveState();
    renderAll();
  }

  function simularTemporada() {
    if (state.round >= ROUNDS) {
      alert('Temporada já concluída. Clique em "Nova Temporada" para iniciar a próxima.');
      return;
    }
    while (state.round < ROUNDS) {
      simulateOneRound();
    }
    saveState();
    renderAll();
  }

  function novaTemporada() {
    if (state.round === 0) {
      alert('A temporada ainda não começou. Simule ao menos uma rodada.');
      return;
    }

    if (state.round >= ROUNDS) {
      endOfSeason(state);
      saveState();
      renderAll();
      return;
    }

    var ok = confirm(
      'A temporada está em andamento (rodada ' + state.round + '/' + ROUNDS + ').\n' +
      'Deseja reiniciar do zero, SEM promoções e rebaixamentos?'
    );
    if (!ok) { return; }

    var keepHistory = state.history;
    var keepRepLog = state.repLog;
    var keepSeason = state.season;

    state = createInitialState(keepSeason);
    state.history = keepHistory;
    state.repLog = keepRepLog;

    saveState();
    renderAll();
  }

  function exportState() {
    var data = JSON.stringify(state, null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var url = URL.createObjectURL(blob);

    var a = document.createElement('a');
    a.href = url;
    a.download = 'football-manager-lite-t' + state.season + '-r' + state.round + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function importStateFile(file) {
    var reader = new FileReader();

    reader.onload = function (ev) {
      var obj;
      try {
        obj = JSON.parse(ev.target.result);
      } catch (err) {
        alert('Erro: o arquivo não é um JSON válido.');
        return;
      }

      if (!obj || !Array.isArray(obj.teams) || obj.teams.length !== TEAMS_DATA.length) {
        alert('Arquivo inválido: o número de times não corresponde aos dados da app (' + TEAMS_DATA.length + ').');
        return;
      }
      if (!obj.fixtures || !obj.results ||
          !obj.fixtures.div1 || !obj.fixtures.div2 || !obj.fixtures.div3 ||
          !obj.results.div1 || !obj.results.div2 || !obj.results.div3) {
        alert('Arquivo inválido: calendários ausentes.');
        return;
      }

      if (!Array.isArray(obj.history)) { obj.history = []; }
      if (!Array.isArray(obj.repLog)) { obj.repLog = []; }
      if (typeof obj.lastRepUpdateRound !== 'number') { obj.lastRepUpdateRound = 0; }
      if (typeof obj.season !== 'number') { obj.season = 2025; }
      if (typeof obj.round !== 'number') { obj.round = 0; }

      state = obj;
      saveState();
      renderAll();
      alert('Estado importado com sucesso.');
    };

    reader.onerror = function () {
      alert('Não foi possível ler o arquivo.');
    };

    reader.readAsText(file);
  }

  /* ------------------------- Inicialização ------------------------- */

  function init() {
    var loaded = loadState();

    if (loaded) {
      state = loaded;
      if (!Array.isArray(state.history)) { state.history = []; }
      if (!Array.isArray(state.repLog)) { state.repLog = []; }
      if (typeof state.lastRepUpdateRound !== 'number') { state.lastRepUpdateRound = 0; }
    } else {
      state = createInitialState(2025);
      saveState();
    }

    document.getElementById('btn-sim-1').addEventListener('click', simularRodada);
    document.getElementById('btn-sim-5').addEventListener('click', simularCinco);
    document.getElementById('btn-sim-season').addEventListener('click', simularTemporada);
    document.getElementById('btn-new-season').addEventListener('click', novaTemporada);
    document.getElementById('btn-export').addEventListener('click', exportState);

    document.getElementById('btn-export-round-csv').addEventListener('click', function () {
      exportRound('csv');
    });
    document.getElementById('btn-export-round-tsv').addEventListener('click', function () {
      exportRound('tsv');
    });

    var fileInput = document.getElementById('file-import');
    document.getElementById('btn-import').addEventListener('click', function () {
      fileInput.click();
    });
    fileInput.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) { importStateFile(file); }
      e.target.value = '';
    });

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        activeTab = e.currentTarget.dataset.tab;
        renderAll();
      });
    }

    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
