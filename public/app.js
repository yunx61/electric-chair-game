(() => {
  const $ = (s) => document.querySelector(s);
  const lobby = $('#lobby');
  const game = $('#game');
  const nameInput = $('#nameInput');
  const codeInput = $('#codeInput');
  const createBtn = $('#createBtn');
  const joinBtn = $('#joinBtn');
  const resumeBtn = $('#resumeBtn');
  const inviteHint = $('#inviteHint');
  const roomCode = $('#roomCode');
  const shareBtn = $('#shareBtn');
  const leaveBtn = $('#leaveBtn');
  const chairGrid = $('#chairGrid');
  const confirmBtn = $('#confirmBtn');
  const selectionText = $('#selectionText');
  const statusTitle = $('#statusTitle');
  const statusSub = $('#statusSub');
  const thinkingDots = $('#thinkingDots');
  const turnNo = $('#turnNo');
  const gameNo = $('#gameNo');
  const connectionBar = $('#connectionBar');
  const connectionText = $('#connectionText');
  const opponentConnection = $('#opponentConnection');
  const confirmOverlay = $('#confirmOverlay');
  const confirmSeat = $('#confirmSeat');
  const confirmTitle = $('#confirmTitle');
  const confirmDetail = $('#confirmDetail');
  const finalChoiceBtn = $('#finalChoiceBtn');
  const cancelChoiceBtn = $('#cancelChoiceBtn');
  const resultOverlay = $('#resultOverlay');
  const resultKicker = $('#resultKicker');
  const resultSeat = $('#resultSeat');
  const resultTitle = $('#resultTitle');
  const resultDetail = $('#resultDetail');
  const resultScore = $('#resultScore');
  const trapReveal = $('#trapReveal');
  const trapRevealRing = $('#trapRevealRing');
  const gameOverOverlay = $('#gameOverOverlay');
  const winnerTitle = $('#winnerTitle');
  const winnerDetail = $('#winnerDetail');
  const seriesScore = $('#seriesScore');
  const restartBtn = $('#restartBtn');
  const rematchStatus = $('#rematchStatus');
  const backBtn = $('#backBtn');
  const toast = $('#toast');

  let ws;
  let state = null;
  let selectedSeat = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastResultKey = null;
  let audioCtx = null;
  let resultTimers = [];
  let connectionState = 'connecting';

  const storedName = localStorage.getItem('ec_name');
  if (storedName) nameInput.value = storedName;
  loadInviteCode();
  refreshResumeButton();

  function loadInviteCode() {
    const room = new URLSearchParams(location.search).get('room');
    if (/^\d{6}$/.test(room || '')) {
      codeInput.value = room;
      inviteHint.classList.remove('hidden');
    }
  }

  function wsUrl() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }

  function setConnection(kind) {
    connectionState = kind;
    connectionBar.className = `connection-bar ${kind}`;
    const labels = { connected: 'CONNECTED', connecting: 'CONNECTING', reconnecting: 'RECONNECTING', offline: 'OFFLINE' };
    connectionText.textContent = labels[kind] || kind.toUpperCase();
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: 'ping' }), 20000);
  }

  function connect(onOpen) {
    if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) {
      if (ws.readyState === WebSocket.OPEN) onOpen?.();
      else ws.addEventListener('open', () => onOpen?.(), { once: true });
      return;
    }
    setConnection(state ? 'reconnecting' : 'connecting');
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      clearTimeout(reconnectTimer);
      setConnection('connected');
      startHeartbeat();
      onOpen?.();
    });
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', () => {
      clearInterval(heartbeatTimer);
      setConnection('offline');
      if (state && state.phase !== 'game_over') {
        showToast('通信が切れました。再接続しています…');
        setConnection('reconnecting');
        reconnectTimer = setTimeout(resumeSession, 1200);
      }
    });
    ws.addEventListener('error', () => setConnection('offline'));
  }

  function send(payload) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function onMessage(e) {
    const msg = JSON.parse(e.data);
    if (msg.type === 'session') {
      localStorage.setItem('ec_session', JSON.stringify({ code: msg.roomCode, token: msg.playerToken }));
      refreshResumeButton();
    }
    if (msg.type === 'state') {
      const previous = state;
      state = msg.state;
      selectedSeat = null;
      confirmOverlay.classList.add('hidden');
      showGame();
      render(previous);
    }
    if (msg.type === 'error') showToast(msg.message);
    if (msg.type === 'left') backToLobby();
  }

  function createRoom() {
    unlockAudio();
    connect(() => send({ type: 'create_room', name: getName() }));
  }

  function joinRoom() {
    unlockAudio();
    const code = codeInput.value.replace(/\D/g, '');
    if (code.length !== 6) return showToast('6桁のルームIDを入力してください');
    connect(() => send({ type: 'join_room', code, name: getName() }));
  }

  function resumeSession() {
    const session = getSession();
    if (!session) return;
    connect(() => send({ type: 'resume', ...session }));
  }

  function getName() {
    const name = (nameInput.value.trim() || 'PLAYER').slice(0, 16);
    localStorage.setItem('ec_name', name);
    return name;
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem('ec_session')); }
    catch { return null; }
  }

  function refreshResumeButton() {
    resumeBtn.classList.toggle('hidden', !getSession());
  }

  function showGame() {
    lobby.classList.remove('active');
    game.classList.add('active');
  }

  function clearResultTimers() {
    resultTimers.forEach(clearTimeout);
    resultTimers = [];
  }

  function backToLobby() {
    clearResultTimers();
    state = null;
    selectedSeat = null;
    localStorage.removeItem('ec_session');
    game.classList.remove('active');
    lobby.classList.add('active');
    resultOverlay.classList.add('hidden');
    gameOverOverlay.classList.add('hidden');
    confirmOverlay.classList.add('hidden');
    refreshResumeButton();
    history.replaceState({}, '', location.pathname);
  }

  function render(previous) {
    if (!state) return;
    roomCode.textContent = state.code;
    turnNo.textContent = state.turnNumber || '—';
    gameNo.textContent = state.gameNumber || 1;

    state.players.forEach((p, i) => {
      const card = $(`#p${i}card`);
      $(`#p${i}name`).textContent = p?.name || 'WAITING';
      animateNumber($(`#p${i}score`), Number($(`#p${i}score`).textContent) || 0, p?.score ?? 0);
      $(`#p${i}shock`).textContent = `⚡ ${p?.shocks ?? 0} / 3`;
      $(`#p${i}wins`).textContent = `${p?.wins ?? 0} WIN`;
      card.classList.toggle('you', state.you === i);
      card.classList.toggle('active-turn', (state.phase === 'set_trap' && state.setterIndex === i) || (state.phase === 'choose_seat' && state.sitterIndex === i));
      card.classList.toggle('offline', p && !p.connected);
    });

    const opponent = state.players[1 - state.you];
    opponentConnection.textContent = opponent ? (opponent.connected ? '相手: ONLINE' : '相手: DISCONNECTED') : '相手待ち';
    opponentConnection.classList.toggle('bad', Boolean(opponent && !opponent.connected));

    renderStatus(previous);
    renderChairs();
    renderResult();
    renderGameOver();
  }

  function renderStatus(previous) {
    const setter = state.players[state.setterIndex];
    const sitter = state.players[state.sitterIndex];
    thinkingDots.classList.add('hidden');

    if (state.phase === 'waiting') {
      statusTitle.textContent = '対戦相手を待っています';
      statusSub.textContent = '右上の共有ボタンから招待リンクを送れます';
      thinkingDots.classList.remove('hidden');
    } else if (state.phase === 'set_trap') {
      if (state.canSetTrap) {
        statusTitle.textContent = '電気イスを仕掛けろ';
        statusSub.textContent = `${sitter?.name} が座りそうなイスを1脚選択`;
      } else {
        statusTitle.textContent = `${setter?.name} が仕掛け中…`;
        statusSub.textContent = '電気イスの番号はあなたの端末へ送られません';
        thinkingDots.classList.remove('hidden');
      }
    } else if (state.phase === 'choose_seat') {
      if (state.canChooseSeat) {
        statusTitle.textContent = '座るイスを選べ';
        statusSub.textContent = '相手の読みを外してポイントを奪え';
      } else {
        statusTitle.textContent = `${sitter?.name} が着席を選択中…`;
        statusSub.textContent = '決定されるまで待機してください';
        thinkingDots.classList.remove('hidden');
      }
    } else if (state.phase === 'result') {
      statusTitle.textContent = '判定';
      statusSub.textContent = '結果を確認中…';
    } else if (state.phase === 'game_over') {
      statusTitle.textContent = 'GAME OVER';
      statusSub.textContent = '勝敗が決まりました';
    }

    const actionable = state.canSetTrap || state.canChooseSeat;
    confirmBtn.classList.toggle('danger', state.canSetTrap);
    confirmBtn.textContent = state.canSetTrap ? '電気イスを決定' : '着席する';
    confirmBtn.disabled = !actionable || selectedSeat == null;
    selectionText.textContent = selectedSeat == null
      ? (actionable ? '円周上のイスを選択してください' : '相手の操作を待っています')
      : `${selectedSeat}番を選択中 — 決定前なら変更できます`;

    if (previous && previous.phase !== state.phase && ['set_trap', 'choose_seat'].includes(state.phase)) playCue('turn');
  }

  function renderChairs() {
    chairGrid.querySelectorAll('.chair-slot').forEach(el => el.remove());
    const actionable = state.canSetTrap || state.canChooseSeat;
    for (let n = 1; n <= 12; n++) {
      const available = state.remainingSeats.includes(n);
      const slot = document.createElement('div');
      slot.className = 'chair-slot';
      slot.style.setProperty('--angle', `${(n - 1) * 30}deg`);
      const b = document.createElement('button');
      b.className = `chair ${available ? 'available' : 'removed'} ${selectedSeat === n ? 'selected' : ''}`;
      b.disabled = !available || !actionable;
      b.setAttribute('aria-label', `${n}番のイス`);
      b.innerHTML = `<span class="chair-back"></span><span class="chair-seat"></span><span class="num">${n}</span>`;
      b.addEventListener('click', () => {
        unlockAudio();
        playCue('select');
        selectedSeat = n;
        renderStatus();
        renderChairs();
      });
      slot.appendChild(b);
      chairGrid.appendChild(slot);
    }
  }

  function openConfirm() {
    if (selectedSeat == null || !state) return;
    unlockAudio();
    confirmSeat.textContent = selectedSeat;
    if (state.canSetTrap) {
      confirmTitle.textContent = `${selectedSeat}番に電気を仕掛ける？`;
      confirmDetail.textContent = '決定後は相手が着席するまで変更できません';
      finalChoiceBtn.textContent = '仕掛ける';
      finalChoiceBtn.classList.add('danger');
    } else {
      confirmTitle.textContent = `${selectedSeat}番に座る？`;
      confirmDetail.textContent = '決定するとすぐ判定されます';
      finalChoiceBtn.textContent = '座る';
      finalChoiceBtn.classList.remove('danger');
    }
    confirmOverlay.classList.remove('hidden');
    playCue('confirm');
  }

  function finalChoice() {
    if (selectedSeat == null || !state) return;
    const seat = selectedSeat;
    confirmOverlay.classList.add('hidden');
    confirmBtn.disabled = true;
    playCue('lock');
    if (state.canSetTrap) send({ type: 'set_trap', seat });
    else if (state.canChooseSeat) send({ type: 'choose_seat', seat });
  }

  function renderResult() {
    const r = state.lastResult;
    if (!r || state.phase !== 'result') {
      if (state.phase !== 'game_over') resultOverlay.classList.add('hidden');
      return;
    }
    const key = `${state.gameNumber}-${state.turnNumber}-${r.playerIndex}-${r.seat}-${r.shocked}`;
    if (lastResultKey === key) return;
    lastResultKey = key;
    clearResultTimers();

    resultOverlay.className = `overlay result-overlay ${r.shocked ? 'shock' : 'safe'} reveal-1`;
    resultKicker.textContent = 'JUDGEMENT';
    resultSeat.textContent = r.seat;
    resultTitle.textContent = '判定…';
    resultDetail.textContent = `${state.players[r.playerIndex]?.name || 'PLAYER'} が ${r.seat}番に着席`;
    resultScore.textContent = '';
    trapReveal.classList.add('hidden');
    trapRevealRing.innerHTML = '';
    playCue('suspense');

    resultTimers.push(setTimeout(() => {
      resultOverlay.classList.remove('reveal-1');
      resultOverlay.classList.add('reveal-2');
      if (r.shocked) {
        resultTitle.textContent = 'ELECTRIC!';
        resultDetail.textContent = `${r.seat}番は電気イス`;
        resultScore.textContent = `${r.pointsBefore} PT → 0 PT`;
        playCue('shock');
        if (navigator.vibrate) navigator.vibrate([80, 40, 180, 50, 280]);
      } else {
        resultTitle.textContent = 'SAFE';
        resultDetail.textContent = `${r.seat}番を獲得`;
        resultScore.textContent = `+${r.gained} PT`;
        playCue('safe');
        if (navigator.vibrate) navigator.vibrate(50);
      }
    }, 1100));

    if (!r.shocked && r.trapSeat) {
      resultTimers.push(setTimeout(() => {
        resultOverlay.classList.add('reveal-3', 'trap-stage');
        resultKicker.textContent = 'TRAP REVEAL';
        resultSeat.textContent = r.trapSeat;
        resultTitle.textContent = `電気イスは ${r.trapSeat}番`;
        resultDetail.textContent = 'ここに仕掛けられていました';
        resultScore.textContent = '';
        trapRevealRing.innerHTML = '';
        for (let seat = 1; seat <= 12; seat++) {
          const dot = document.createElement('div');
          dot.className = `trap-mini-seat${seat === r.trapSeat ? ' hot' : ''}${seat === r.seat ? ' sat' : ''}`;
          dot.style.setProperty('--i', seat - 1);
          dot.innerHTML = `<span>${seat}</span>`;
          trapRevealRing.appendChild(dot);
        }
        trapReveal.classList.remove('hidden');
        playCue('reveal');
        if (navigator.vibrate) navigator.vibrate([35, 40, 90]);
      }, 2200));
    } else {
      resultTimers.push(setTimeout(() => resultOverlay.classList.add('reveal-3'), 2350));
    }
  }

  function renderGameOver() {
    if (state.phase !== 'game_over') {
      gameOverOverlay.classList.add('hidden');
      return;
    }
    clearResultTimers();
    resultOverlay.classList.add('hidden');
    gameOverOverlay.classList.remove('hidden');
    const winner = state.winnerIndex == null ? null : state.players[state.winnerIndex];
    winnerTitle.textContent = winner ? `${winner.name} WIN` : 'DRAW';
    const reasons = {
      forty_points: '40ポイント到達',
      three_shocks: '3回感電',
      one_seat_left: 'イスが残り1脚',
      opponent_left: '相手プレイヤーが退出',
      disconnect_timeout: '相手が再接続しませんでした'
    };
    winnerDetail.textContent = `${reasons[state.endReason] || '対戦終了'} / ${state.players[0].score} - ${state.players[1].score} PT`;
    seriesScore.textContent = `SERIES  ${state.players[0].wins} - ${state.players[1].wins}`;
    const mine = Boolean(state.rematchVotes?.[state.you]);
    const theirs = Boolean(state.rematchVotes?.[1 - state.you]);
    restartBtn.disabled = mine;
    restartBtn.textContent = mine ? '再戦希望を送信済み' : '再戦を希望する';
    rematchStatus.textContent = mine && theirs ? '両者同意 — 再戦を開始します' : theirs ? '相手が再戦を希望しています' : mine ? '相手の同意を待っています…' : '両者が希望すると同じルームで再戦します';
  }

  function animateNumber(el, from, to) {
    if (from === to) { el.textContent = to; return; }
    const start = performance.now();
    const duration = 450;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function inviteUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', state.code);
    return url.toString();
  }

  async function shareInvite() {
    if (!state) return;
    const url = inviteUrl();
    const text = `ELECTRIC CHAIR DUEL / ROOM ${state.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'ELECTRIC CHAIR DUEL', text, url });
      else {
        await navigator.clipboard.writeText(url);
        showToast('招待リンクをコピーしました');
      }
    } catch (e) {
      if (e?.name !== 'AbortError') showToast(url);
    }
  }

  function unlockAudio() {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }

  function tone(freq, duration, type = 'square', gain = 0.035, delay = 0) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + duration + 0.03);
  }

  function playCue(kind) {
    if (!audioCtx) return;
    if (kind === 'select') tone(520, .07, 'square', .025);
    if (kind === 'confirm') { tone(330, .08, 'square', .025); tone(440, .09, 'square', .025, .08); }
    if (kind === 'lock') tone(190, .16, 'sawtooth', .035);
    if (kind === 'turn') { tone(260, .09, 'square', .02); tone(390, .09, 'square', .02, .12); }
    if (kind === 'suspense') { tone(110, .35, 'sawtooth', .02); tone(105, .35, 'sawtooth', .02, .45); }
    if (kind === 'safe') { tone(523, .12, 'triangle', .04); tone(659, .13, 'triangle', .04, .12); tone(784, .24, 'triangle', .05, .25); }
    if (kind === 'reveal') { tone(220, .08, 'sawtooth', .025); tone(440, .1, 'square', .03, .08); tone(880, .18, 'triangle', .04, .18); }
    if (kind === 'shock') {
      [95, 150, 70, 210, 55].forEach((f, i) => tone(f, .18, i % 2 ? 'square' : 'sawtooth', .07, i * .055));
    }
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => toast.classList.add('hidden'), 2400);
  }

  createBtn.addEventListener('click', createRoom);
  joinBtn.addEventListener('click', joinRoom);
  resumeBtn.addEventListener('click', () => { unlockAudio(); resumeSession(); });
  confirmBtn.addEventListener('click', openConfirm);
  finalChoiceBtn.addEventListener('click', finalChoice);
  cancelChoiceBtn.addEventListener('click', () => confirmOverlay.classList.add('hidden'));
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); });
  shareBtn.addEventListener('click', shareInvite);
  leaveBtn.addEventListener('click', () => {
    if (!state || confirm('対戦を退出しますか？')) send({ type: 'leave' });
  });
  restartBtn.addEventListener('click', () => { unlockAudio(); send({ type: 'rematch_vote' }); });
  backBtn.addEventListener('click', () => { send({ type: 'leave' }); setTimeout(backToLobby, 100); });

  document.addEventListener('pointerdown', unlockAudio, { once: true });
  if (getSession()) resumeSession();
})();
