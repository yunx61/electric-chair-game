(()=>{
'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const E={
 lobby:$('#lobby'),game:$('#game'),name:$('#nameInput'),soloName:$('#soloNameInput'),code:$('#codeInput'),create:$('#createBtn'),join:$('#joinBtn'),resume:$('#resumeBtn'),inviteHint:$('#inviteHint'),
 goOnline:$('#goOnlineBtn'),goSolo:$('#goSoloBtn'),goChallenge:$('#goChallengeBtn'),rules:$('#rulesBtn'),achievements:$('#achievementsBtn'),history:$('#historyBtn'),sound:$('#soundBtn'),achievementCount:$('#achievementCount'),soundState:$('#soundState'),
 startAi:$('#startAiBtn'),aiRoster:$('#aiRoster'),challengeGrid:$('#challengeGrid'),roomCode:$('#roomCode'),roomLabel:$('#roomLabel'),share:$('#shareBtn'),leave:$('#leaveBtn'),chairGrid:$('#chairGrid'),confirm:$('#confirmBtn'),selection:$('#selectionText'),statusTitle:$('#statusTitle'),statusSub:$('#statusSub'),thinking:$('#thinkingDots'),turnNo:$('#turnNo'),gameNo:$('#gameNo'),connectionBar:$('#connectionBar'),connectionText:$('#connectionText'),opponentConnection:$('#opponentConnection'),
 confirmOverlay:$('#confirmOverlay'),confirmSeat:$('#confirmSeat'),confirmTitle:$('#confirmTitle'),confirmDetail:$('#confirmDetail'),finalChoice:$('#finalChoiceBtn'),cancelChoice:$('#cancelChoiceBtn'),
 gameContext:$('#gameContext'),resultOverlay:$('#resultOverlay'),resultKicker:$('#resultKicker'),resultSeat:$('#resultSeat'),resultTitle:$('#resultTitle'),resultDetail:$('#resultDetail'),resultScore:$('#resultScore'),trapReveal:$('#trapReveal'),trapRevealRing:$('#trapRevealRing'),
 gameOver:$('#gameOverOverlay'),winnerTitle:$('#winnerTitle'),winnerDetail:$('#winnerDetail'),seriesScore:$('#seriesScore'),challengeResult:$('#challengeResult'),restart:$('#restartBtn'),rematchStatus:$('#rematchStatus'),back:$('#backBtn'),toast:$('#toast'),
 rulesOverlay:$('#rulesOverlay'),achievementsOverlay:$('#achievementsOverlay'),historyOverlay:$('#historyOverlay'),soundOverlay:$('#soundOverlay'),achievementList:$('#achievementList'),historyList:$('#historyList'),bgmToggle:$('#bgmToggle'),seToggle:$('#seToggle'),
 startOverlay:$('#startOverlay'),startMode:$('#startMode'),startP0:$('#startP0'),startP1:$('#startP1'),startP0Img:$('#startP0Img'),startP1Img:$('#startP1Img'),aiBanner:$('#aiBanner'),aiAvatar:$('#aiAvatar'),aiStyle:$('#aiStyle'),aiName:$('#aiName'),aiQuote:$('#aiQuote'),challengeBanner:$('#challengeBanner')
};

const AI_PROFILES=[
 {id:'rei',name:'レイ',style:'冷徹分析型',img:'/assets/ai-rei.webp',blurb:'履歴と得点状況を解析。HARDでは癖を強く読む。',unlock:0,quotes:['その選択は記録した。','数字は嘘をつかない。','次の一手は予測できる。']},
 {id:'gou',name:'ゴウ',style:'豪胆ギャンブラー',img:'/assets/ai-gou.webp',blurb:'高得点を恐れず踏み込む。罠も強気。',unlock:0,quotes:['デカい数字ほど燃えるだろ。','守ってばかりじゃ勝てないぜ。','さあ、勝負しようぜ。']},
 {id:'mika',name:'ミカ',style:'読心トリックスター',img:'/assets/ai-mika.webp',blurb:'裏の裏を狙い、パターンを意図的に崩す。',unlock:2,quotes:['読んだつもりが一番危ないよ。','同じ手をもう一度…って思った？','ふふ、どっちかな。']},
 {id:'nagi',name:'ナギ',style:'慎重堅実型',img:'/assets/ai-nagi.webp',blurb:'リスクを抑え、勝ち筋を静かに積む。',unlock:5,quotes:['焦らない。それが一番。','危険な勝負は必要な時だけ。','一つずつ確実に。']}
];
const CHALLENGES=[
 {id:'no_shock',title:'NO SHOCK',desc:'一度も感電せずにAIへ勝利。',meta:'標準ルール / NORMAL',ai:'rei',difficulty:'normal'},
 {id:'six_turns',title:'SIX TURN',desc:'6ターン以内にAIへ勝利。',meta:'標準ルール / HARD',ai:'gou',difficulty:'hard'},
 {id:'high_risk',title:'HIGH RISK',desc:'7〜12番だけの高得点イス。30PT先取・感電2回で敗北。',meta:'特殊ルール / HARD',ai:'mika',difficulty:'hard'},
 {id:'sudden',title:'SUDDEN DEATH',desc:'25PT先取。ただし感電1回で即敗北。',meta:'特殊ルール / HARD',ai:'nagi',difficulty:'hard'}
];
const ACHIEVEMENTS=[
 {id:'first_win',name:'FIRST WIN',desc:'初勝利を達成'},
 {id:'no_shock',name:'PERFECT SAFE',desc:'感電0回で勝利'},
 {id:'seat12',name:'HIGH ROLLER',desc:'12番をSAFEで獲得'},
 {id:'streak3',name:'HOT STREAK',desc:'3連勝を達成'},
 {id:'rei_hard',name:'ANALYST BREAKER',desc:'レイ HARDに勝利'},
 {id:'challenge2',name:'CHALLENGER',desc:'チャレンジを2種類クリア'}
];

const defaultProgress=()=>({soloWins:0,onlineWins:0,totalWins:0,streak:0,bestStreak:0,achievements:{},challenges:{},history:[]});
let progress=loadJSON('ec_progress',defaultProgress());
let ws,state=null,selectedSeat=null,reconnectTimer=null,heartbeatTimer=null,lastResultKey=null,lastGameOverKey=null,audioCtx=null,ambientNodes=null,resultTimers=[],startTimer=null;
let selectedAi='rei',difficulty='normal',currentChallenge=null,revealTrapSeat=null,revealSafeSeat=null,matchFlags={safe12:false};
function syncVisualViewport(){const vv=window.visualViewport;const h=Math.round(vv?.height||window.innerHeight);const o=Math.round(vv?.offsetTop||0);document.documentElement.style.setProperty('--vvh',`${h}px`);document.documentElement.style.setProperty('--vvo',`${o}px`)}
syncVisualViewport();window.addEventListener('resize',syncVisualViewport);window.visualViewport?.addEventListener('resize',syncVisualViewport);window.visualViewport?.addEventListener('scroll',syncVisualViewport);
let bgmEnabled=localStorage.getItem('ec_bgm')!=='off',seEnabled=localStorage.getItem('ec_se')!=='off';

function loadJSON(k,fallback){try{return JSON.parse(localStorage.getItem(k)||'null')||fallback}catch{return fallback}}
function saveProgress(){localStorage.setItem('ec_progress',JSON.stringify(progress));renderProgressUI()}
function aiById(id){return AI_PROFILES.find(x=>x.id===id)||AI_PROFILES[0]}
function isUnlocked(p){return progress.soloWins>=p.unlock}
function safeText(v){return String(v??'')}

const savedName=localStorage.getItem('ec_name')||'';E.name.value=savedName;E.soloName.value=savedName;
renderProgressUI();renderAiRoster();renderChallenges();renderSoundSettings();loadInviteCode();refreshResumeButton();

function switchTab(name){$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$$('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`${name}Tab`))}
function loadInviteCode(){const room=new URLSearchParams(location.search).get('room');if(/^\d{6}$/.test(room||'')){E.code.value=room;E.inviteHint.classList.remove('hidden');switchTab('online')}}
function cleanAndSaveName(input){const name=(input.value.trim()||'PLAYER').replace(/[<>]/g,'').slice(0,16);localStorage.setItem('ec_name',name);E.name.value=name;E.soloName.value=name;return name}

function renderProgressUI(){
 const done=ACHIEVEMENTS.filter(a=>progress.achievements[a.id]).length;E.achievementCount.textContent=`${done}/${ACHIEVEMENTS.length}`;
 E.soundState.textContent=(bgmEnabled||seEnabled)?'SOUND ON':'SOUND OFF';
 E.achievementList.innerHTML=ACHIEVEMENTS.map(a=>`<div class="achievement-item ${progress.achievements[a.id]?'':'locked'}"><b>${progress.achievements[a.id]?'✓ ':'○ '}${a.name}</b><span>${a.desc}</span></div>`).join('');
 E.historyList.innerHTML=progress.history.length?progress.history.map(h=>`<div class="history-item"><b>${h.win?'WIN':'LOSE'} / ${h.mode==='ai'?h.opponent:'ONLINE'} ${h.difficulty?`(${h.difficulty.toUpperCase()})`:''}</b><span>${h.score} - ${h.oppScore} PT / ${h.date}</span></div>`).join(''):'<div class="history-item"><span>まだ対戦履歴がありません。</span></div>';
}
function unlockAchievement(id){if(!progress.achievements[id]){progress.achievements[id]=true;showToast(`実績解除：${ACHIEVEMENTS.find(a=>a.id===id)?.name||id}`)}}
function renderAiRoster(){
 E.aiRoster.innerHTML='';
 AI_PROFILES.forEach(p=>{const unlocked=isUnlocked(p);const b=document.createElement('button');b.className=`ai-choice ${selectedAi===p.id?'active':''} ${unlocked?'':'locked'}`;b.dataset.ai=p.id;if(!unlocked)b.dataset.lock=`SOLO ${p.unlock}勝で解放`;b.innerHTML=`<img src="${p.img}" alt="${p.name}"><span class="ai-info"><b>${p.name}</b><small>${p.style}</small></span>`;b.onclick=()=>{if(!unlocked){showToast(`${p.name}はSOLO ${p.unlock}勝で解放`);return}selectedAi=p.id;$$('.ai-choice').forEach(x=>x.classList.remove('active'));b.classList.add('active');playCue('select')};E.aiRoster.appendChild(b)});
 if(!isUnlocked(aiById(selectedAi)))selectedAi='rei';
}
function renderChallenges(){E.challengeGrid.innerHTML=CHALLENGES.map(c=>`<article class="challenge-card-item ${progress.challenges[c.id]?'complete':''}"><small>${progress.challenges[c.id]?'✓ COMPLETE':'MISSION'}</small><h3>${c.title}</h3><p>${c.desc}</p><div class="challenge-meta">${c.meta}</div><button class="btn ${progress.challenges[c.id]?'ghost':'primary'}" data-challenge="${c.id}">${progress.challenges[c.id]?'もう一度':'挑戦する'}</button></article>`).join('');$$('[data-challenge]').forEach(b=>b.onclick=()=>startChallenge(b.dataset.challenge))}

function wsUrl(){return `${location.protocol==='https:'?'wss':'ws'}://${location.host}`}
function setConnection(kind){E.connectionBar.className=`connection-bar ${kind}`;E.connectionText.textContent={connected:'CONNECTED',connecting:'CONNECTING',reconnecting:'RECONNECTING',offline:'OFFLINE'}[kind]||kind.toUpperCase()}
function startHeartbeat(){clearInterval(heartbeatTimer);heartbeatTimer=setInterval(()=>send({type:'ping'}),20000)}
function connect(onOpen){
 if(ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState)){if(ws.readyState===WebSocket.OPEN)onOpen?.();else ws.addEventListener('open',()=>onOpen?.(),{once:true});return}
 setConnection(state?'reconnecting':'connecting');sessionReady=false;ws=new WebSocket(wsUrl());
 ws.addEventListener('open',()=>{clearTimeout(reconnectTimer);setConnection('connected');startHeartbeat();onOpen?.()});
 ws.addEventListener('message',onMessage);ws.addEventListener('close',()=>{sessionReady=false;clearInterval(heartbeatTimer);setConnection('offline');if(state&&state.phase!=='game_over'){setConnection('reconnecting');showToast('通信が切れました。再接続中…');reconnectTimer=setTimeout(resumeSession,1200)}});ws.addEventListener('error',()=>setConnection('offline'));
}
function send(payload){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(payload))}
function onMessage(e){let msg;try{msg=JSON.parse(e.data)}catch{return}if(msg.type==='session'){sessionReady=true;localStorage.setItem('ec_session',JSON.stringify({code:msg.roomCode,token:msg.playerToken}));refreshResumeButton()}if(msg.type==='state'){const prev=state;state=msg.state;selectedSeat=null;E.confirmOverlay.classList.add('hidden');showGame();render(prev)}if(msg.type==='error')showToast(msg.message);if(msg.type==='session_required'){sessionReady=false;resumeSession()}if(msg.type==='left')backToLobby()}
function getSession(){return loadJSON('ec_session',null)}function refreshResumeButton(){E.resume.classList.toggle('hidden',!getSession())}
function resumeSession(){const s=getSession();if(!s)return;connect(()=>send({type:'resume',code:s.code,token:s.token}))}
function createRoom(){currentChallenge=null;unlockAudio();connect(()=>send({type:'create_room',name:cleanAndSaveName(E.name)}))}
function joinRoom(){currentChallenge=null;unlockAudio();const code=E.code.value.replace(/\D/g,'');if(code.length!==6)return showToast('6桁のルームIDを入力してください');connect(()=>send({type:'join_room',name:cleanAndSaveName(E.name),code}))}
function createAiRoom(){currentChallenge=null;if(!isUnlocked(aiById(selectedAi)))return showToast('そのAIは未解放です');unlockAudio();connect(()=>send({type:'create_ai_room',name:cleanAndSaveName(E.soloName),aiId:selectedAi,difficulty,challengeId:null}))}
function startChallenge(id){const c=CHALLENGES.find(x=>x.id===id);if(!c)return;currentChallenge=c;selectedAi=c.ai;difficulty=c.difficulty;unlockAudio();const name=cleanAndSaveName(E.soloName);connect(()=>send({type:'create_ai_room',name,aiId:c.ai,difficulty:c.difficulty,challengeId:c.id}))}
function showGame(){E.lobby.classList.remove('active');E.game.classList.add('active');startAmbient()}
function backToLobby(){stopAmbient();sessionReady=false;state=null;selectedSeat=null;lastResultKey=null;lastGameOverKey=null;currentChallenge=null;resultTimers.forEach(clearTimeout);resultTimers=[];E.game.classList.remove('active');E.lobby.classList.add('active');E.resultOverlay.classList.add('hidden');E.gameOver.classList.add('hidden');E.confirmOverlay.classList.add('hidden');localStorage.removeItem('ec_session');refreshResumeButton();history.replaceState({},'',location.pathname);switchTab('home');renderProgressUI();renderAiRoster();renderChallenges()}

function render(previous){
 if(!state)return;E.roomCode.textContent=state.mode==='ai'?(state.ai?.difficulty||'AI').toUpperCase():state.code;E.roomLabel.textContent=state.mode==='ai'?'SOLO':'ROOM';E.share.classList.toggle('hidden',state.mode==='ai');E.turnNo.textContent=state.turnNumber||'-';E.gameNo.textContent=state.gameNumber||'-';
 if(state.gameNumber>0&&(!previous||previous.gameNumber!==state.gameNumber)){matchFlags={safe12:false};showStartIntro()}
 if(state.phase!=='result'){revealTrapSeat=null;revealSafeSeat=null}
 renderPlayers(previous);renderAiBanner();renderChallengeBanner();renderGameContext();renderArena();renderStatus();renderConnection();
 if(state.phase!=='result'){E.resultOverlay.classList.add('hidden');resultTimers.forEach(clearTimeout);resultTimers=[]}
 if(state.lastResult&&state.phase==='result'){const k=`${state.gameNumber}:${state.turnNumber}:${state.lastResult.playerIndex}:${state.lastResult.seat}`;if(k!==lastResultKey){lastResultKey=k;showResult(state.lastResult)}}
 if(state.phase==='game_over')renderGameOver();else E.gameOver.classList.add('hidden');
 if(previous&&previous.turnNumber!==state.turnNumber&&state.phase==='set_trap')playCue('turn');
}
function renderPlayers(previous){[0,1].forEach(i=>{const p=state.players[i];$(`#p${i}name`).textContent=p?.name||'WAITING';animateNumber($(`#p${i}score`),previous?.players?.[i]?.score??p?.score??0,p?.score||0);$(`#p${i}shock`).textContent=`⚡ ${p?.shocks||0} / ${state.rules?.shockLimit||3}`;$(`#p${i}wins`).textContent=`${p?.wins||0} WIN`;})}
function renderAiBanner(){if(state.mode!=='ai'||!state.ai){E.aiBanner.classList.add('hidden');return}const p=aiById(state.ai.id);E.aiBanner.classList.remove('hidden');E.aiAvatar.src=p.img;E.aiStyle.textContent=`${p.style} / ${state.ai.difficulty.toUpperCase()}`;E.aiName.textContent=p.name;E.aiQuote.textContent=aiQuote(p)}
function aiQuote(p){const idx=(state.turnNumber+(state.players[0]?.score||0)+(state.players[1]?.score||0))%p.quotes.length;let q=p.quotes[idx];if(state.phase==='choose_seat'&&state.sitterIndex===1)q='……ここだ。';if(state.phase==='set_trap'&&state.setterIndex===1)q='仕掛ける場所は決めた。';return q}
function renderChallengeBanner(){const id=state.challengeId||currentChallenge?.id;if(!id){E.challengeBanner.classList.add('hidden');return}const c=CHALLENGES.find(x=>x.id===id);E.challengeBanner.classList.remove('hidden');E.challengeBanner.textContent=`CHALLENGE：${c?.title||id} / ${challengeLiveText(id)}`}
function challengeLiveText(id){const me=state.players[state.you];if(id==='no_shock')return `感電 ${me?.shocks||0}回`;if(id==='six_turns')return `TURN ${state.turnNumber} / 6`;if(id==='high_risk')return '7〜12番・30PT・感電2回';if(id==='sudden')return '25PT・感電1回で敗北';return ''}

function renderGameContext(){
 const visibleAi=!E.aiBanner.classList.contains('hidden'),visibleChallenge=!E.challengeBanner.classList.contains('hidden');
 E.gameContext.classList.toggle('hidden',!(visibleAi||visibleChallenge));
}
function renderConnection(){if(state.mode==='ai'){E.opponentConnection.textContent=' / AI';return}const opp=state.players[1-state.you];E.opponentConnection.textContent=opp?(opp.connected?' / OPPONENT ONLINE':' / OPPONENT OFFLINE'):' / WAITING'}
function renderArena(){
 E.chairGrid.querySelectorAll('.chair-slot').forEach(x=>x.remove());
 for(let n=1;n<=12;n++){const b=document.createElement('button');const remaining=state.remainingSeats.includes(n);const theta=-90+(n%12)*30;const rad=theta*Math.PI/180;const radiusPct=41;const x=50+radiusPct*Math.cos(rad),y=50+radiusPct*Math.sin(rad);const rot=theta+90;b.className=`chair-slot ${remaining?'':(revealSafeSeat===n?'used-reveal':'removed')} ${selectedSeat===n?'selected':''} ${revealTrapSeat===n?'main-trap-hot':''} ${revealSafeSeat===n?'main-seat-safe':''}`;b.style.left=`${x}%`;b.style.top=`${y}%`;b.style.setProperty('--rot',`${rot}deg`);b.style.setProperty('--counter-rot',`${-rot}deg`);b.disabled=!remaining||!(state.canSetTrap||state.canChooseSeat);b.setAttribute('aria-label',`${n}番のイス`);b.innerHTML=`<span class="chair"><i class="chair-back"></i><i class="chair-seat"></i><b class="num">${n}</b></span>`;b.onclick=()=>selectSeat(n);E.chairGrid.appendChild(b)}
}
function renderStatus(){
 const me=state.you,waiting=state.mode==='human'&&!state.players[1];E.thinking.classList.add('hidden');
 if(waiting){E.statusTitle.textContent='対戦相手を待っています';E.statusSub.textContent='右上の共有ボタンから招待';E.selection.textContent='共有ボタンを押して招待リンクを送信';E.confirm.disabled=true;return}
 if(state.phase==='set_trap'){if(state.setterIndex===me){E.statusTitle.textContent='電気イスを仕掛ける';E.statusSub.textContent='相手に座らせたい1脚を選択';E.selection.textContent=selectedSeat?`${selectedSeat}番に電気を仕掛ける`:'仕掛けるイスを選択'}else{E.statusTitle.textContent=state.mode==='ai'?'AIが仕掛けています':'相手が仕掛けています';E.statusSub.textContent='位置情報はあなたには送信されません';E.thinking.classList.remove('hidden');E.selection.textContent='相手の決定を待っています…'}}
 else if(state.phase==='choose_seat'){if(state.sitterIndex===me){E.statusTitle.textContent='座るイスを選ぶ';E.statusSub.textContent='電気イスを読み切れ';E.selection.textContent=selectedSeat?`${selectedSeat}番に着席する`:'着席するイスを選択'}else{E.statusTitle.textContent=state.mode==='ai'?'AIが着席を考えています':'相手が着席を考えています';E.statusSub.textContent='選択結果を待っています';E.thinking.classList.remove('hidden');E.selection.textContent='相手の選択を待っています…'}}
 else if(state.phase==='result'){E.statusTitle.textContent='RESULT';E.statusSub.textContent='判定中';E.selection.textContent='結果演出中…'}else if(state.phase==='game_over'){E.statusTitle.textContent='GAME OVER';E.statusSub.textContent='勝敗決定';E.selection.textContent='対戦終了'}
 E.confirm.disabled=!sessionReady||!(selectedSeat&&(state.canSetTrap||state.canChooseSeat));
}
function selectSeat(n){selectedSeat=n;playCue('select');renderArena();renderStatus()}
function openConfirm(){if(!selectedSeat)return;E.confirmSeat.textContent=selectedSeat;if(state.canSetTrap){E.confirmTitle.textContent='このイスに仕掛ける？';E.confirmDetail.textContent='相手には番号は送られません';$('#confirmKicker').textContent='SET ELECTRIC CHAIR'}else{E.confirmTitle.textContent='このイスに座る？';E.confirmDetail.textContent='決定後は変更できません';$('#confirmKicker').textContent='TAKE A SEAT'}E.confirmOverlay.classList.remove('hidden');playCue('confirm')}
function finalChoice(){if(!selectedSeat)return;if(!sessionReady){showToast('接続を確認中です…');return}playCue('lock');send({type:state.canSetTrap?'set_trap':'choose_seat',seat:selectedSeat});E.confirmOverlay.classList.add('hidden')}

function showResult(r){
 resultTimers.forEach(clearTimeout);resultTimers=[];E.resultOverlay.className='overlay result-overlay';E.resultOverlay.classList.remove('reveal-phase');E.resultKicker.textContent='JUDGEMENT';E.resultSeat.textContent=r.seat;E.resultTitle.textContent='CHECK';E.resultDetail.textContent='判定中…';E.resultScore.textContent='';E.trapReveal.classList.add('hidden');E.trapRevealRing.innerHTML='';playCue('suspense');
 resultTimers.push(setTimeout(()=>{if(r.shocked){E.resultOverlay.classList.add('shock');E.resultKicker.textContent='HIGH VOLTAGE';E.resultTitle.textContent='ELECTRIC!';E.resultDetail.textContent=`${r.pointsBefore} PT → 0 PT`;E.resultScore.textContent='0 PT';playCue('shock');try{navigator.vibrate?.([90,40,180,35,280])}catch{}}else{E.resultOverlay.classList.add('safe');E.resultKicker.textContent='JUDGEMENT';E.resultSeat.textContent=r.seat;E.resultTitle.textContent='SAFE!';E.resultDetail.textContent=`${r.seat}番に着席`;E.resultScore.textContent=`+${r.gained} PT`;if(r.playerIndex===state.you&&r.seat===12){matchFlags.safe12=true;unlockAchievement('seat12');saveProgress()}playCue('safe');resultTimers.push(setTimeout(()=>showTrapReveal(r),1150))}},850));
}
function showTrapReveal(r){revealTrapSeat=r.trapSeat;revealSafeSeat=r.seat;renderArena();E.resultOverlay.classList.add('reveal-phase');E.resultKicker.textContent='TRAP REVEAL';E.resultSeat.textContent=r.trapSeat;E.resultTitle.textContent=`電気イスは ${r.trapSeat}番`;E.resultDetail.textContent=`${r.seat}番は SAFE / +${r.gained} PT`;E.resultScore.textContent='';E.trapReveal.classList.remove('hidden');E.trapRevealRing.innerHTML='';for(let n=1;n<=12;n++){const theta=-90+(n%12)*30,rad=theta*Math.PI/180,x=50+40*Math.cos(rad),y=50+40*Math.sin(rad);const el=document.createElement('span');el.className=`trap-mini-seat ${n===r.trapSeat?'hot':''} ${n===r.seat?'sat':''}`;el.style.left=`${x}%`;el.style.top=`${y}%`;el.textContent=n;E.trapRevealRing.appendChild(el)}playCue('reveal')}

function renderGameOver(){
 E.gameOver.classList.remove('hidden');const w=state.winnerIndex==null?null:state.players[state.winnerIndex];E.winnerTitle.textContent=w?`${w.name} WIN`:'DRAW';const reasons={forty_points:`${state.rules?.targetScore||40}ポイント到達`,three_shocks:`感電${state.rules?.shockLimit||3}回`,one_seat_left:'イスが残り1脚',opponent_left:'相手が退出',disconnect_timeout:'相手が再接続しませんでした'};E.winnerDetail.textContent=`${reasons[state.endReason]||'対戦終了'} / ${state.players[0].score} - ${state.players[1].score} PT`;E.seriesScore.textContent=`SERIES  ${state.players[0].wins} - ${state.players[1].wins}`;
 const key=`${state.code}:${state.gameNumber}`;if(lastGameOverKey!==key){lastGameOverKey=key;recordGame()}
 renderChallengeResult();
 if(state.mode==='ai'){E.restart.disabled=false;E.restart.textContent='同じ条件で再戦';E.rematchStatus.textContent=`${state.ai.name} / ${state.ai.difficulty.toUpperCase()}`;return}
 const mine=Boolean(state.rematchVotes?.[state.you]),theirs=Boolean(state.rematchVotes?.[1-state.you]);E.restart.disabled=mine;E.restart.textContent=mine?'再戦希望を送信済み':'再戦を希望する';E.rematchStatus.textContent=theirs?'相手が再戦を希望しています':mine?'相手の同意を待っています…':'両者の同意で再戦';
}
function recordGame(){
 const me=state.players[state.you],opp=state.players[1-state.you],win=state.winnerIndex===state.you;progress.totalWins+=win?1:0;if(win){progress.streak+=1;progress.bestStreak=Math.max(progress.bestStreak,progress.streak);unlockAchievement('first_win')}else progress.streak=0;
 if(state.mode==='ai'&&win)progress.soloWins+=1;if(state.mode==='human'&&win)progress.onlineWins+=1;if(win&&me.shocks===0)unlockAchievement('no_shock');if(progress.streak>=3)unlockAchievement('streak3');if(win&&state.mode==='ai'&&state.ai?.id==='rei'&&state.ai?.difficulty==='hard')unlockAchievement('rei_hard');
 progress.history.unshift({date:new Date().toLocaleDateString('ja-JP'),mode:state.mode,opponent:opp?.name||'---',difficulty:state.ai?.difficulty||'',win,score:me.score,oppScore:opp?.score||0});progress.history=progress.history.slice(0,10);
 const cid=state.challengeId||currentChallenge?.id;if(cid&&challengeSucceeded(cid,win)){progress.challenges[cid]=true;showToast(`CHALLENGE CLEAR：${CHALLENGES.find(c=>c.id===cid)?.title}`)}if(Object.values(progress.challenges).filter(Boolean).length>=2)unlockAchievement('challenge2');saveProgress();renderAiRoster();renderChallenges();
}
function challengeSucceeded(id,win){const me=state.players[state.you];if(!win)return false;if(id==='no_shock')return me.shocks===0;if(id==='six_turns')return state.turnNumber<=6;if(id==='high_risk'||id==='sudden')return true;return false}
function renderChallengeResult(){const id=state.challengeId||currentChallenge?.id;if(!id){E.challengeResult.classList.add('hidden');return}const clear=Boolean(progress.challenges[id]);E.challengeResult.classList.remove('hidden');E.challengeResult.textContent=clear?`CHALLENGE CLEAR：${CHALLENGES.find(c=>c.id===id)?.title}`:`CHALLENGE FAILED：${CHALLENGES.find(c=>c.id===id)?.title}`}
function animateNumber(el,from,to){if(from===to){el.textContent=to;return}const start=performance.now(),d=380;const tick=n=>{const t=Math.min(1,(n-start)/d);el.textContent=Math.round(from+(to-from)*(1-Math.pow(1-t,3)));if(t<1)requestAnimationFrame(tick)};requestAnimationFrame(tick)}

function inviteUrl(){const url=new URL(location.href);url.search='';url.searchParams.set('room',state.code);return url.toString()}
async function shareInvite(){if(!state||state.mode==='ai')return;const url=inviteUrl(),text=`電撃イスDUELで対戦しよう！ ROOM ${state.code}`;try{if(navigator.share){await navigator.share({title:'ELECTRIC CHAIR DUEL',text,url})}else{await navigator.clipboard.writeText(url);showToast('招待リンクをコピーしました')}}catch(e){if(e?.name!=='AbortError')showToast('共有できませんでした')}}

function unlockAudio(){try{audioCtx||=new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();startAmbient()}catch{}}
function renderSoundSettings(){E.bgmToggle.innerHTML=`BGM <b>${bgmEnabled?'ON':'OFF'}</b>`;E.seToggle.innerHTML=`SE <b>${seEnabled?'ON':'OFF'}</b>`;renderProgressUI()}
function startAmbient(){if(!bgmEnabled||!audioCtx||!E.game.classList.contains('active')||ambientNodes)return;try{const o1=audioCtx.createOscillator(),o2=audioCtx.createOscillator(),g=audioCtx.createGain();o1.type='sine';o2.type='triangle';o1.frequency.value=43;o2.frequency.value=57;g.gain.value=.008;o1.connect(g);o2.connect(g);g.connect(audioCtx.destination);o1.start();o2.start();ambientNodes=[o1,o2,g]}catch{}}
function stopAmbient(){if(!ambientNodes)return;try{ambientNodes[0].stop();ambientNodes[1].stop()}catch{}ambientNodes=null}
function toggleBgm(){bgmEnabled=!bgmEnabled;localStorage.setItem('ec_bgm',bgmEnabled?'on':'off');renderSoundSettings();if(bgmEnabled){unlockAudio();startAmbient()}else stopAmbient()}
function toggleSe(){seEnabled=!seEnabled;localStorage.setItem('ec_se',seEnabled?'on':'off');renderSoundSettings()}
function tone(freq,duration,type='square',gain=.03,delay=0){if(!audioCtx)return;const t=audioCtx.currentTime+delay,o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type=type;o.frequency.setValueAtTime(freq,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(gain,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+duration);o.connect(g).connect(audioCtx.destination);o.start(t);o.stop(t+duration+.03)}
function playCue(k){if(!audioCtx||!seEnabled)return;if(k==='select')tone(520,.07,'square',.025);if(k==='confirm'){tone(330,.08,'square',.025);tone(440,.09,'square',.025,.08)}if(k==='lock')tone(190,.16,'sawtooth',.035);if(k==='turn'){tone(260,.09,'square',.02);tone(390,.09,'square',.02,.12)}if(k==='suspense'){tone(110,.35,'sawtooth',.02);tone(105,.35,'sawtooth',.02,.45)}if(k==='safe'){tone(523,.12,'triangle',.04);tone(659,.13,'triangle',.04,.12);tone(784,.24,'triangle',.05,.25)}if(k==='reveal'){tone(220,.08,'sawtooth',.025);tone(440,.1,'square',.03,.08);tone(880,.18,'triangle',.04,.18)}if(k==='shock')[95,150,70,210,55].forEach((f,i)=>tone(f,.18,i%2?'square':'sawtooth',.065,i*.055));if(k==='start'){tone(110,.25,'sawtooth',.035);tone(220,.18,'square',.04,.28);tone(440,.2,'triangle',.05,.52)}}
function showStartIntro(){clearTimeout(startTimer);E.startP0.textContent=state.players[0]?.name||'PLAYER 1';E.startP1.textContent=state.players[1]?.name||'PLAYER 2';E.startMode.textContent=state.mode==='ai'?`${state.ai?.name||'AI'} / ${(state.ai?.difficulty||'').toUpperCase()}`:`ROOM ${state.code}`;E.startP0Img.classList.add('hidden');if(state.mode==='ai'){E.startP1Img.src=aiById(state.ai.id).img;E.startP1Img.classList.remove('hidden')}else E.startP1Img.classList.add('hidden');E.startOverlay.classList.remove('hidden');playCue('start');startTimer=setTimeout(()=>E.startOverlay.classList.add('hidden'),2200)}
function showToast(text){E.toast.textContent=text;E.toast.classList.remove('hidden');clearTimeout(showToast.t);showToast.t=setTimeout(()=>E.toast.classList.add('hidden'),2400)}

$$('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));E.goOnline.onclick=()=>switchTab('online');E.goSolo.onclick=()=>switchTab('solo');E.goChallenge.onclick=()=>switchTab('challenge');
E.rules.onclick=()=>E.rulesOverlay.classList.remove('hidden');E.achievements.onclick=()=>{renderProgressUI();E.achievementsOverlay.classList.remove('hidden')};E.history.onclick=()=>{renderProgressUI();E.historyOverlay.classList.remove('hidden')};E.sound.onclick=()=>E.soundOverlay.classList.remove('hidden');
$$('[data-close]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).classList.add('hidden'));
$$('.difficulty').forEach(b=>b.onclick=()=>{$$('.difficulty').forEach(x=>x.classList.remove('active'));b.classList.add('active');difficulty=b.dataset.difficulty;playCue('select')});
E.bgmToggle.onclick=toggleBgm;E.seToggle.onclick=toggleSe;E.create.onclick=createRoom;E.join.onclick=joinRoom;E.startAi.onclick=createAiRoom;E.resume.onclick=()=>{unlockAudio();resumeSession()};E.confirm.onclick=openConfirm;E.finalChoice.onclick=finalChoice;E.cancelChoice.onclick=()=>E.confirmOverlay.classList.add('hidden');E.code.addEventListener('input',()=>{E.code.value=E.code.value.replace(/\D/g,'').slice(0,6)});E.share.onclick=shareInvite;E.leave.onclick=()=>{if(!state||confirm('対戦を退出しますか？'))send({type:'leave'})};E.restart.onclick=()=>{unlockAudio();send({type:'rematch_vote'})};E.back.onclick=()=>{send({type:'leave'});setTimeout(backToLobby,100)};document.addEventListener('pointerdown',unlockAudio,{once:true});if(getSession())resumeSession();
})();
