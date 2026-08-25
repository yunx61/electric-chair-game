(() => {
  const $ = (s) => document.querySelector(s);
  const lobby = $('#lobby');
  const game = $('#game');
  const nameInput = $('#nameInput');
  const codeInput = $('#codeInput');
  const createBtn = $('#createBtn');
  const joinBtn = $('#joinBtn');
  const resumeBtn = $('#resumeBtn');
  const roomCode = $('#roomCode');
  const copyBtn = $('#copyBtn');
  const leaveBtn = $('#leaveBtn');
  const chairGrid = $('#chairGrid');
  const confirmBtn = $('#confirmBtn');
  const selectionText = $('#selectionText');
  const statusTitle = $('#statusTitle');
  const statusSub = $('#statusSub');
  const turnNo = $('#turnNo');
  const resultOverlay = $('#resultOverlay');
  const resultTitle = $('#resultTitle');
  const resultDetail = $('#resultDetail');
  const gameOverOverlay = $('#gameOverOverlay');
  const winnerTitle = $('#winnerTitle');
  const winnerDetail = $('#winnerDetail');
  const restartBtn = $('#restartBtn');
  const backBtn = $('#backBtn');
  const toast = $('#toast');

  let ws;
  let state = null;
  let selectedSeat = null;
  let reconnectTimer = null;
  let lastResultKey = null;

  const storedName = localStorage.getItem('ec_name');
  if (storedName) nameInput.value = storedName;
  refreshResumeButton();

  function wsUrl() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }

  function connect(onOpen) {
    if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) {
      if (ws.readyState === WebSocket.OPEN) onOpen?.();
      else ws.addEventListener('open', () => onOpen?.(), { once: true });
      return;
    }
    ws = new WebSocket(wsUrl());
    ws.addEventListener('open', () => {
      clearTimeout(reconnectTimer);
      onOpen?.();
    });
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', () => {
      if (state && state.phase !== 'game_over') {
        showToast('通信が切れました。再接続しています…');
        reconnectTimer = setTimeout(resumeSession, 1200);
      }
    });
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
      state = msg.state;
      selectedSeat = null;
      showGame();
      render();
    }
    if (msg.type === 'error') showToast(msg.message);
    if (msg.type === 'left') backToLobby();
  }

  function createRoom() {
    const name = getName();
    connect(() => send({ type: 'create_room', name }));
  }

  function joinRoom() {
    const code = codeInput.value.replace(/\D/g, '');
    if (code.length !== 6) return showToast('6桁のルームIDを入力してください');
    const name = getName();
    connect(() => send({ type: 'join_room', code, name }));
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

  function backToLobby() {
    state = null;
    selectedSeat = null;
    localStorage.removeItem('ec_session');
    game.classList.remove('active');
    lobby.classList.add('active');
    resultOverlay.classList.add('hidden');
    gameOverOverlay.classList.add('hidden');
    refreshResumeButton();
  }

  function render() {
    if (!state) return;
    roomCode.textContent = state.code;
    turnNo.textContent = state.turnNumber || '—';
    state.players.forEach((p, i) => {
      const card = $(`#p${i}card`);
      $(`#p${i}name`).textContent = p?.name || 'WAITING';
      $(`#p${i}score`).textContent = p?.score ?? 0;
      $(`#p${i}shock`).textContent = `⚡ ${p?.shocks ?? 0} / 3`;
      card.classList.toggle('you', state.you === i);
      card.classList.toggle('active-turn', (state.phase === 'set_trap' && state.setterIndex === i) || (state.phase === 'choose_seat' && state.sitterIndex === i));
      card.classList.toggle('offline', p && !p.connected);
    });

    renderStatus();
    renderChairs();
    renderResult();
    renderGameOver();
  }

  function renderStatus() {
    const me = state.you;
    const setter = state.players[state.setterIndex];
    const sitter = state.players[state.sitterIndex];

    if (state.phase === 'waiting') {
      statusTitle.textContent = '対戦相手を待っています';
      statusSub.textContent = `ROOM ${state.code} を相手に伝えてください`;
    } else if (state.phase === 'set_trap') {
      if (state.canSetTrap) {
        statusTitle.textContent = '電気イスを仕掛けろ';
        statusSub.textContent = `${sitter?.name} が座りそうなイスを1脚選択`;
      } else {
        statusTitle.textContent = `${setter?.name} が仕掛け中…`;
        statusSub.textContent = '相手の選択はあなたの端末には送信されません';
      }
    } else if (state.phase === 'choose_seat') {
      if (state.canChooseSeat) {
        statusTitle.textContent = '座るイスを選べ';
        statusSub.textContent = '電気イスを読み切ってポイントを奪え';
      } else {
        statusTitle.textContent = `${sitter?.name} が着席を選択中…`;
        statusSub.textContent = '決定されるまで待機してください';
      }
    } else if (state.phase === 'result') {
      statusTitle.textContent = '判定中';
      statusSub.textContent = '次のターンへ移ります';
    } else if (state.phase === 'game_over') {
      statusTitle.textContent = 'GAME OVER';
      statusSub.textContent = '勝敗が決まりました';
    }

    const actionable = state.canSetTrap || state.canChooseSeat;
    confirmBtn.classList.toggle('danger', state.canSetTrap);
    confirmBtn.textContent = state.canSetTrap ? 'このイスに電気を仕掛ける' : 'このイスに座る';
    confirmBtn.disabled = !actionable || selectedSeat == null;
    selectionText.textContent = selectedSeat == null
      ? (actionable ? 'イスを選択してください' : '相手の操作を待っています')
      : `${selectedSeat}番を選択中 — 決定前なら変更できます`;
  }

  function renderChairs() {
    chairGrid.innerHTML = '';
    const actionable = state.canSetTrap || state.canChooseSeat;
    for (let n = 1; n <= 12; n++) {
      const available = state.remainingSeats.includes(n);
      const b = document.createElement('button');
      b.className = `chair ${available ? 'available' : 'removed'} ${selectedSeat === n ? 'selected' : ''}`;
      b.disabled = !available || !actionable;
      b.setAttribute('aria-label', `${n}番のイス`);
      b.innerHTML = `<span class="num">${n}</span>`;
      b.addEventListener('click', () => {
        selectedSeat = n;
        renderStatus();
        renderChairs();
      });
      chairGrid.appendChild(b);
    }
  }

  function renderResult() {
    const r = state.lastResult;
    if (!r || state.phase !== 'result') {
      resultOverlay.classList.add('hidden');
      return;
    }
    const key = `${state.turnNumber}-${r.playerIndex}-${r.seat}-${r.shocked}`;
    resultOverlay.classList.remove('hidden');
    resultOverlay.classList.toggle('shock', r.shocked);
    if (r.shocked) {
      resultTitle.textContent = 'SHOCK!';
      resultDetail.textContent = `${r.seat}番は電気イス。${r.pointsBefore} PT → 0 PT`;
      if (lastResultKey !== key && navigator.vibrate) navigator.vibrate([80, 40, 180, 50, 280]);
    } else {
      resultTitle.textContent = 'SAFE';
      resultDetail.textContent = `${r.seat}番を獲得！ +${r.gained} PT`;
      if (lastResultKey !== key && navigator.vibrate) navigator.vibrate(50);
    }
    lastResultKey = key;
  }

  function renderGameOver() {
    if (state.phase !== 'game_over') {
      gameOverOverlay.classList.add('hidden');
      return;
    }
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
  }

  function confirmSelection() {
    if (selectedSeat == null || !state) return;
    const seat = selectedSeat;
    confirmBtn.disabled = true;
    if (state.canSetTrap) send({ type: 'set_trap', seat });
    else if (state.canChooseSeat) send({ type: 'choose_seat', seat });
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => toast.classList.add('hidden'), 2400);
  }

  createBtn.addEventListener('click', createRoom);
  joinBtn.addEventListener('click', joinRoom);
  resumeBtn.addEventListener('click', resumeSession);
  confirmBtn.addEventListener('click', confirmSelection);
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); });
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.code); showToast('ルームIDをコピーしました'); }
    catch { showToast(`ROOM ${state.code}`); }
  });
  leaveBtn.addEventListener('click', () => {
    if (!state || confirm('対戦を退出しますか？')) send({ type: 'leave' });
  });
  restartBtn.addEventListener('click', () => send({ type: 'restart' }));
  backBtn.addEventListener('click', () => { send({ type: 'leave' }); setTimeout(backToLobby, 100); });

  // Attempt a silent resume on refresh; if it fails, the lobby remains usable.
  if (getSession()) resumeSession();
})();
