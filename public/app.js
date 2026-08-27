import { createLocalAiSession } from './js/ai/local-session.js';
import { createOnlineSession, ROOM_PATTERN } from './js/firebase/online-session.js';
import { renderQr } from './js/vendor/qr.js';

(()=>{
'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const E={
 app:$('#app'),lobby:$('#lobby'),game:$('#game'),name:$('#nameInput'),soloName:$('#soloNameInput'),code:$('#codeInput'),create:$('#createBtn'),join:$('#joinBtn'),resume:$('#resumeBtn'),inviteHint:$('#inviteHint'),
 goOnline:$('#goOnlineBtn'),goSolo:$('#goSoloBtn'),goChallenge:$('#goChallengeBtn'),rules:$('#rulesBtn'),achievements:$('#achievementsBtn'),history:$('#historyBtn'),sound:$('#soundBtn'),achievementCount:$('#achievementCount'),soundState:$('#soundState'),
 startAi:$('#startAiBtn'),aiRoster:$('#aiRoster'),challengeGrid:$('#challengeGrid'),roomCode:$('#roomCode'),roomLabel:$('#roomLabel'),share:$('#shareBtn'),leave:$('#leaveBtn'),chairGrid:$('#chairGrid'),confirm:$('#confirmBtn'),selection:$('#selectionText'),statusTitle:$('#statusTitle'),statusSub:$('#statusSub'),thinking:$('#thinkingDots'),turnNo:$('#turnNo'),gameNo:$('#gameNo'),connectionBar:$('#connectionBar'),connectionText:$('#connectionText'),opponentConnection:$('#opponentConnection'),
 confirmOverlay:$('#confirmOverlay'),confirmSeat:$('#confirmSeat'),confirmTitle:$('#confirmTitle'),confirmDetail:$('#confirmDetail'),finalChoice:$('#finalChoiceBtn'),cancelChoice:$('#cancelChoiceBtn'),
 gameContext:$('#gameContext'),resultOverlay:$('#resultOverlay'),resultKicker:$('#resultKicker'),resultSeat:$('#resultSeat'),resultTitle:$('#resultTitle'),resultDetail:$('#resultDetail'),resultScore:$('#resultScore'),trapReveal:$('#trapReveal'),trapRevealRing:$('#trapRevealRing'),
 gameOver:$('#gameOverOverlay'),winnerTitle:$('#winnerTitle'),winnerDetail:$('#winnerDetail'),seriesScore:$('#seriesScore'),aiAnalysis:$('#aiAnalysis'),challengeResult:$('#challengeResult'),restart:$('#restartBtn'),rematchStatus:$('#rematchStatus'),replayShare:$('#replayShareBtn'),back:$('#backBtn'),toast:$('#toast'),
 rulesOverlay:$('#rulesOverlay'),achievementsOverlay:$('#achievementsOverlay'),historyOverlay:$('#historyOverlay'),soundOverlay:$('#soundOverlay'),achievementList:$('#achievementList'),historyList:$('#historyList'),bgmToggle:$('#bgmToggle'),seToggle:$('#seToggle'),
 startOverlay:$('#startOverlay'),startMode:$('#startMode'),startP0:$('#startP0'),startP1:$('#startP1'),startP0Img:$('#startP0Img'),startP1Img:$('#startP1Img'),aiBanner:$('#aiBanner'),aiAvatar:$('#aiAvatar'),aiStyle:$('#aiStyle'),aiName:$('#aiName'),aiQuote:$('#aiQuote'),challengeBanner:$('#challengeBanner'),
 inviteOverlay:$('#inviteOverlay'),inviteQr:$('#inviteQr'),fullRoomCode:$('#fullRoomCode'),copyCode:$('#copyCodeBtn'),copyLink:$('#copyLinkBtn'),nativeShare:$('#nativeShareBtn'),updateBanner:$('#updateBanner'),updateBtn:$('#updateBtn')
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
function normalizeProgress(value){const base=defaultProgress(),source=value&&typeof value==='object'?value:{};return{soloWins:Number.isFinite(source.soloWins)?Math.max(0,source.soloWins):0,onlineWins:Number.isFinite(source.onlineWins)?Math.max(0,source.onlineWins):0,totalWins:Number.isFinite(source.totalWins)?Math.max(0,source.totalWins):0,streak:Number.isFinite(source.streak)?Math.max(0,source.streak):0,bestStreak:Number.isFinite(source.bestStreak)?Math.max(0,source.bestStreak):0,achievements:source.achievements&&typeof source.achievements==='object'?source.achievements:base.achievements,challenges:source.challenges&&typeof source.challenges==='object'?source.challenges:base.challenges,history:Array.isArray(source.history)?source.history.slice(0,10):base.history}}
let progress=normalizeProgress(loadJSON('ec_progress',defaultProgress()));
let sessionController=null,state=null,selectedSeat=null,leaveFallbackTimer=null,statusRefreshTimer=null,lastResultKey=null,lastGameOverKey=null,audioCtx=null,ambientNodes=null,resultTimers=[],startTimer=null,sessionReady=false,activeDialog=null,dialogTrigger=null,lobbyBusy=false,choiceSubmitting=false;
let selectedAi='rei',difficulty='normal',currentChallenge=null,revealTrapSeat=null,revealSafeSeat=null,matchFlags={safe12:false};
function syncVisualViewport(){const vv=window.visualViewport;const h=Math.round(vv?.height||window.innerHeight);const o=Math.round(vv?.offsetTop||0);document.documentElement.style.setProperty('--vvh',`${h}px`);document.documentElement.style.setProperty('--vvo',`${o}px`);requestAnimationFrame(layoutArena)}
syncVisualViewport();window.addEventListener('resize',syncVisualViewport);window.visualViewport?.addEventListener('resize',syncVisualViewport);window.visualViewport?.addEventListener('scroll',syncVisualViewport);
let bgmEnabled=(()=>{try{return localStorage.getItem('ec_bgm')!=='off'}catch{return true}})(),seEnabled=(()=>{try{return localStorage.getItem('ec_se')!=='off'}catch{return true}})();

function loadJSON(k,fallback){try{return JSON.parse(localStorage.getItem(k)||'null')||fallback}catch{return fallback}}
function saveProgress(){try{localStorage.setItem('ec_progress',JSON.stringify(progress))}catch{showToast('端末への保存に失敗しました')}renderProgressUI()}
function aiById(id){return AI_PROFILES.find(x=>x.id===id)||AI_PROFILES[0]}
function isUnlocked(p){return progress.soloWins>=p.unlock}
const savedName=(()=>{try{return localStorage.getItem('ec_name')||''}catch{return''}})();E.name.value=savedName;E.soloName.value=savedName;
renderProgressUI();renderAiRoster();renderChallenges();renderSoundSettings();loadInviteCode();refreshResumeButton();

function switchTab(name){$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$$('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`${name}Tab`))}
function focusableIn(dialog){return $$('button:not([disabled]),input:not([disabled]),[href],[tabindex]:not([tabindex="-1"])').filter(el=>dialog.contains(el)&&!el.closest('.hidden'))}
function openDialog(dialog,trigger=document.activeElement){if(!dialog)return;if(activeDialog&&activeDialog!==dialog)closeDialog(activeDialog,false);activeDialog=dialog;dialogTrigger=trigger instanceof HTMLElement?trigger:null;dialog.classList.remove('hidden');dialog.setAttribute('aria-hidden','false');E.app.inert=true;requestAnimationFrame(()=>focusableIn(dialog)[0]?.focus())}
function closeDialog(dialog=activeDialog,restoreFocus=true){if(!dialog)return;dialog.classList.add('hidden');dialog.setAttribute('aria-hidden','true');if(activeDialog===dialog){activeDialog=null;E.app.inert=false;const trigger=dialogTrigger;dialogTrigger=null;if(restoreFocus&&trigger?.isConnected)trigger.focus()}}
function loadInviteCode(){const room=new URLSearchParams(location.search).get('room');if(ROOM_PATTERN.test(room||'')){E.code.value=room;E.inviteHint.classList.remove('hidden');switchTab('online');history.replaceState({},'',location.pathname)}}
function cleanAndSaveName(input){const name=[...(input.value.trim()||'PLAYER').normalize('NFKC').replace(/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'')].slice(0,16).join('');try{localStorage.setItem('ec_name',name)}catch{}E.name.value=name;E.soloName.value=name;return name}

function renderProgressUI(){
 const done=ACHIEVEMENTS.filter(a=>progress.achievements[a.id]).length;E.achievementCount.textContent=`${done}/${ACHIEVEMENTS.length}`;
 E.soundState.textContent=(bgmEnabled||seEnabled)?'SOUND ON':'SOUND OFF';
 E.achievementList.replaceChildren(...ACHIEVEMENTS.map(a=>{const item=document.createElement('div'),title=document.createElement('b'),desc=document.createElement('span'),unlocked=Boolean(progress.achievements[a.id]);item.className=`achievement-item ${unlocked?'':'locked'}`;title.textContent=`${unlocked?'✓ ':'○ '}${a.name}`;desc.textContent=a.desc;item.append(title,desc);return item}));
 const historyItems=progress.history.map(h=>{const item=document.createElement('div'),title=document.createElement('b'),detail=document.createElement('span');item.className='history-item';const opponent=h?.mode==='ai'?String(h?.opponent||'---'):'ONLINE',level=h?.difficulty?` (${String(h.difficulty).toUpperCase()})`:'';title.textContent=`${h?.win?'WIN':'LOSE'} / ${opponent}${level}`;detail.textContent=`${Number(h?.score)||0} - ${Number(h?.oppScore)||0} PT / ${String(h?.date||'')}`;item.append(title,detail);return item});
 if(!historyItems.length){const item=document.createElement('div'),text=document.createElement('span');item.className='history-item';text.textContent='まだ対戦履歴がありません。';item.append(text);historyItems.push(item)}E.historyList.replaceChildren(...historyItems);
}
function unlockAchievement(id){if(!progress.achievements[id]){progress.achievements[id]=true;showToast(`実績解除：${ACHIEVEMENTS.find(a=>a.id===id)?.name||id}`)}}
function renderAiRoster(){
 if(!isUnlocked(aiById(selectedAi)))selectedAi='rei';
 E.aiRoster.innerHTML='';
 AI_PROFILES.forEach(p=>{const unlocked=isUnlocked(p),active=selectedAi===p.id;const b=document.createElement('button');b.type='button';b.className=`ai-choice ${active?'active':''} ${unlocked?'':'locked'}`;b.dataset.ai=p.id;b.setAttribute('role','radio');b.setAttribute('aria-checked',String(active));b.setAttribute('aria-disabled',String(!unlocked));if(!unlocked)b.dataset.lock=`SOLO ${p.unlock}勝で解放`;b.innerHTML=`<img src="${p.img}" alt=""><span class="ai-info"><b>${p.name}</b><small>${p.style}</small></span>`;b.onclick=()=>{if(!unlocked){showToast(`${p.name}はSOLO ${p.unlock}勝で解放`);return}selectedAi=p.id;renderAiRoster();playCue('select')};E.aiRoster.appendChild(b)});
}
function renderChallenges(){E.challengeGrid.innerHTML=CHALLENGES.map(c=>`<article class="challenge-card-item ${progress.challenges[c.id]?'complete':''}"><small>${progress.challenges[c.id]?'✓ COMPLETE':'MISSION'}</small><h3>${c.title}</h3><p>${c.desc}</p><div class="challenge-meta">${c.meta}</div><button class="btn ${progress.challenges[c.id]?'ghost':'primary'}" data-challenge="${c.id}">${progress.challenges[c.id]?'もう一度':'挑戦する'}</button></article>`).join('');$$('[data-challenge]').forEach(b=>b.onclick=()=>startChallenge(b.dataset.challenge))}

function setConnection(kind){E.connectionBar.className=`connection-bar ${kind}`;E.connectionText.textContent={connected:'CONNECTED',connecting:'CONNECTING',reconnecting:'RECONNECTING',offline:'OFFLINE'}[kind]||kind.toUpperCase()}
function sessionCallbacks(){return{
 onConnection(kind){setConnection(kind);sessionReady=kind==='connected'},
 onSession(){sessionReady=true;refreshResumeButton()},
 onError(message){showToast(message||'通信エラーが発生しました')},
 onExpired(){backToLobby();showToast('ルームの有効期限が切れました')},
 onState(next){if(!next||!Array.isArray(next.players))return;const prev=state;state=next;selectedSeat=null;if(activeDialog===E.confirmOverlay)closeDialog(E.confirmOverlay,false);showGame();render(prev)}
}}
async function replaceSession(factory){try{await sessionController?.close?.();sessionController=null;sessionReady=false;setConnection('connecting');sessionController=await factory();return sessionController}catch(error){sessionController=null;sessionReady=false;setConnection('offline');showToast(error?.message||'接続できませんでした');throw error}}
function send(payload){if(!sessionController)return false;sessionController.action(payload).catch(error=>showToast(error?.message||'操作に失敗しました'));return true}
function getSession(){return loadJSON('ec_session',null)}function refreshResumeButton(){E.resume.classList.toggle('hidden',!getSession())}
function setLobbyBusy(value){lobbyBusy=value;[E.create,E.join,E.resume,E.startAi,...$$('[data-challenge]')].forEach(button=>{if(button)button.disabled=value})}
async function withLobbyLock(task){if(lobbyBusy){showToast('準備中です…');return null}setLobbyBusy(true);try{return await task()}finally{setLobbyBusy(false)}}
async function resumeSession(){return withLobbyLock(async()=>{const s=getSession();if(!s||!ROOM_PATTERN.test(String(s.roomId||''))){try{localStorage.removeItem('ec_session')}catch{}refreshResumeButton();return}unlockAudio();const controller=await replaceSession(()=>createOnlineSession(sessionCallbacks())).catch(()=>null);if(controller)await controller.resume(s.roomId).catch(error=>{showToast(error.message);try{localStorage.removeItem('ec_session')}catch{}refreshResumeButton()})})}
async function createRoom(){return withLobbyLock(async()=>{currentChallenge=null;unlockAudio();const controller=await replaceSession(()=>createOnlineSession(sessionCallbacks())).catch(()=>null);if(controller)await controller.createRoom(cleanAndSaveName(E.name)).catch(error=>showToast(error.message))})}
async function joinRoom(){return withLobbyLock(async()=>{currentChallenge=null;unlockAudio();const code=E.code.value.trim();if(!ROOM_PATTERN.test(code))return showToast('22文字の招待コードを入力してください');const controller=await replaceSession(()=>createOnlineSession(sessionCallbacks())).catch(()=>null);if(controller)await controller.joinRoom(code,cleanAndSaveName(E.name)).catch(error=>showToast(error.message))})}
async function createAiRoom(){return withLobbyLock(async()=>{currentChallenge=null;if(!isUnlocked(aiById(selectedAi)))return showToast('そのAIは未解放です');unlockAudio();await replaceSession(()=>createLocalAiSession({name:cleanAndSaveName(E.soloName),aiId:selectedAi,difficulty,challengeId:null,callbacks:sessionCallbacks()})).catch(()=>{})})}
async function startChallenge(id){return withLobbyLock(async()=>{const c=CHALLENGES.find(x=>x.id===id);if(!c)return;currentChallenge=c;selectedAi=c.ai;difficulty=c.difficulty;unlockAudio();await replaceSession(()=>createLocalAiSession({name:cleanAndSaveName(E.soloName),aiId:c.ai,difficulty:c.difficulty,challengeId:c.id,callbacks:sessionCallbacks()})).catch(()=>{})})}
function showGame(){E.lobby.classList.remove('active');E.game.classList.add('active');startAmbient();requestAnimationFrame(layoutArena)}
function backToLobby(){clearTimeout(leaveFallbackTimer);sessionController?.close?.();sessionController=null;stopAmbient();sessionReady=false;choiceSubmitting=false;state=null;selectedSeat=null;lastResultKey=null;lastGameOverKey=null;currentChallenge=null;resultTimers.forEach(clearTimeout);resultTimers=[];if(activeDialog)closeDialog(activeDialog,false);E.app.inert=false;E.game.classList.remove('active');E.lobby.classList.add('active');E.resultOverlay.classList.add('hidden');E.gameOver.classList.add('hidden');E.confirmOverlay.classList.add('hidden');try{localStorage.removeItem('ec_session')}catch{}refreshResumeButton();history.replaceState({},'',location.pathname);switchTab('home');renderProgressUI();renderAiRoster();renderChallenges()}
async function requestLeave(){const controller=sessionController;try{await controller?.action?.({type:'leave'})}catch{}if(sessionController===controller)backToLobby()}

function render(previous){
 if(!state)return;E.roomCode.textContent=state.mode==='ai'?(state.ai?.difficulty||'AI').toUpperCase():state.code;E.roomLabel.textContent=state.mode==='ai'?'SOLO':'ROOM';E.share.classList.toggle('hidden',state.mode==='ai');E.turnNo.textContent=state.turnNumber||'-';E.gameNo.textContent=state.gameNumber||'-';
 if(state.gameNumber>0&&(!previous||previous.gameNumber!==state.gameNumber)){matchFlags={safe12:false};showStartIntro()}
 if(state.phase!=='result'){revealTrapSeat=null;revealSafeSeat=null}
 renderPlayers(previous);renderAiBanner();renderChallengeBanner();renderGameContext();renderArena();renderStatus();renderConnection();requestAnimationFrame(layoutArena);
 if(state.phase!=='result'){E.resultOverlay.classList.add('hidden');resultTimers.forEach(clearTimeout);resultTimers=[]}
 if(state.lastResult&&state.phase==='result'){const k=`${state.gameNumber}:${state.turnNumber}:${state.lastResult.playerIndex}:${state.lastResult.seat}`;if(k!==lastResultKey){lastResultKey=k;showResult(state.lastResult)}}
 if(state.phase==='game_over')renderGameOver();else if(activeDialog===E.gameOver)closeDialog(E.gameOver,false);else E.gameOver.classList.add('hidden');
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
function renderConnection(){if(state.mode==='ai'){E.opponentConnection.textContent=' / AI';return}const opp=state.players[1-state.you];if(!opp){E.opponentConnection.textContent=' / WAITING';return}if(opp.connected){E.opponentConnection.textContent=' / OPPONENT ONLINE';return}if(state.disconnectDeadline&&state.phase!=='game_over'){const seconds=Math.max(0,Math.ceil((state.disconnectDeadline-(Date.now()+(state.clockOffset||0)))/1000));E.opponentConnection.textContent=` / RECONNECT ${seconds}s`;statusRefreshTimer=setTimeout(()=>{if(state)renderConnection()},1000);return}E.opponentConnection.textContent=' / OPPONENT OFFLINE'}

function layoutArena(){
 if(!E.game?.classList.contains('active')||!E.chairGrid)return;
 const wrap=E.chairGrid.parentElement;if(!wrap)return;
 const rect=wrap.getBoundingClientRect();
 const width=Math.max(0,rect.width-2),height=Math.max(0,rect.height-2);
 if(width<80||height<80)return;
 const size=Math.floor(Math.min(width,height,390));
 const chairW=Math.round(Math.max(34,Math.min(52,size*.135)));
 const chairH=Math.round(chairW*1.16);
 E.chairGrid.style.setProperty('--arena-size',`${size}px`);
 E.chairGrid.style.setProperty('--chair-w',`${chairW}px`);
 E.chairGrid.style.setProperty('--chair-h',`${chairH}px`);
}

function renderArena(){
 E.chairGrid.querySelectorAll('.chair-slot').forEach(x=>x.remove());
 for(let n=1;n<=12;n++){const b=document.createElement('button');const remaining=state.remainingSeats.includes(n);const theta=-90+(n%12)*30;const rad=theta*Math.PI/180;const radiusPct=41;const x=50+radiusPct*Math.cos(rad),y=50+radiusPct*Math.sin(rad);const rot=theta+90;b.className=`chair-slot ${remaining?'':(revealSafeSeat===n?'used-reveal':'removed')} ${selectedSeat===n?'selected':''} ${revealTrapSeat===n?'main-trap-hot':''} ${revealSafeSeat===n?'main-seat-safe':''}`;b.style.left=`${x}%`;b.style.top=`${y}%`;b.style.setProperty('--rot',`${rot}deg`);b.style.setProperty('--counter-rot',`${-rot}deg`);b.disabled=!remaining||!(state.canSetTrap||state.canChooseSeat);b.setAttribute('aria-label',`${n}番のイス`);b.innerHTML=`<span class="chair"><i class="chair-back"></i><i class="chair-seat"></i><b class="num">${n}</b></span>`;b.onclick=()=>selectSeat(n);E.chairGrid.appendChild(b)}
}
function renderStatus(){
 clearTimeout(statusRefreshTimer);
 const me=state.you,waiting=state.mode==='human'&&!state.players[1];E.thinking.classList.add('hidden');
 if(waiting){E.statusTitle.textContent='対戦相手を待っています';E.statusSub.textContent='右上の共有ボタンから招待';E.selection.textContent='共有ボタンを押して招待リンクを送信';E.confirm.disabled=true;return}
 if(state.phase==='set_trap'){if(state.setterIndex===me){E.statusTitle.textContent='電気イスを仕掛ける';E.statusSub.textContent='相手に座らせたい1脚を選択';E.selection.textContent=selectedSeat?`${selectedSeat}番に電気を仕掛ける`:'仕掛けるイスを選択'}else{E.statusTitle.textContent=state.mode==='ai'?'AIが仕掛けています':'相手が仕掛けています';E.statusSub.textContent='位置情報はあなたには送信されません';E.thinking.classList.remove('hidden');E.selection.textContent='相手の決定を待っています…'}}
 else if(state.phase==='choose_seat'){if(state.sitterIndex===me){E.statusTitle.textContent='座るイスを選ぶ';E.statusSub.textContent='電気イスを読み切れ';E.selection.textContent=selectedSeat?`${selectedSeat}番に着席する`:'着席するイスを選択'}else{E.statusTitle.textContent=state.mode==='ai'?'AIが着席を考えています':'相手が着席を考えています';E.statusSub.textContent='選択結果を待っています';E.thinking.classList.remove('hidden');E.selection.textContent='相手の選択を待っています…'}}
 else if(state.phase==='reveal_wait'){const seconds=Math.max(0,Math.ceil((state.revealDeadline-(Date.now()+(state.clockOffset||0)))/1000));E.statusTitle.textContent=state.setterIndex===me?'結果を公開しています':'相手の公開を待っています';E.statusSub.textContent=`残り ${seconds}秒`;E.selection.textContent='Commitを検証しています…';E.thinking.classList.remove('hidden');statusRefreshTimer=setTimeout(()=>{if(state?.phase==='reveal_wait')renderStatus()},1000)}
 else if(state.phase==='result'){E.statusTitle.textContent='RESULT';E.statusSub.textContent='判定中';E.selection.textContent='結果演出中…'}else if(state.phase==='game_over'){E.statusTitle.textContent=state.endReason==='protocol_violation'?'DATA ERROR':'GAME OVER';E.statusSub.textContent=state.endReason==='protocol_violation'?'対戦データに不整合を検出':'勝敗決定';E.selection.textContent='対戦終了'}
 E.confirm.disabled=!sessionReady||!(selectedSeat&&(state.canSetTrap||state.canChooseSeat));
}
function selectSeat(n){selectedSeat=n;playCue('select');renderArena();renderStatus()}
function openConfirm(){if(!selectedSeat)return;E.confirmSeat.textContent=selectedSeat;if(state.canSetTrap){E.confirmTitle.textContent='このイスに仕掛ける？';E.confirmDetail.textContent='相手には番号は送られません';$('#confirmKicker').textContent='SET ELECTRIC CHAIR'}else{E.confirmTitle.textContent='このイスに座る？';E.confirmDetail.textContent='決定後は変更できません';$('#confirmKicker').textContent='TAKE A SEAT'}openDialog(E.confirmOverlay,E.confirm);playCue('confirm')}
async function finalChoice(){if(!selectedSeat||choiceSubmitting)return;if(!sessionReady){showToast('接続を確認中です…');return}const controller=sessionController,payload={type:state.canSetTrap?'set_trap':'choose_seat',seat:selectedSeat};choiceSubmitting=true;E.finalChoice.disabled=true;playCue('lock');closeDialog(E.confirmOverlay,false);try{await controller?.action(payload)}catch(error){showToast(error?.message||'操作に失敗しました')}finally{choiceSubmitting=false;E.finalChoice.disabled=false}}

function showResult(r){
 resultTimers.forEach(clearTimeout);resultTimers=[];E.resultOverlay.className='overlay result-overlay';E.resultOverlay.classList.remove('reveal-phase');E.resultKicker.textContent='JUDGEMENT';E.resultSeat.textContent=r.seat;E.resultTitle.textContent='CHECK';E.resultDetail.textContent='判定中…';E.resultScore.textContent='';E.trapReveal.classList.add('hidden');E.trapRevealRing.innerHTML='';playCue('suspense');
 resultTimers.push(setTimeout(()=>{if(r.shocked){E.resultOverlay.classList.add('shock');E.resultKicker.textContent='HIGH VOLTAGE';E.resultTitle.textContent='ELECTRIC!';E.resultDetail.textContent=`${r.pointsBefore} PT → 0 PT`;E.resultScore.textContent='0 PT';playCue('shock');try{navigator.vibrate?.([90,40,180,35,280])}catch{}}else{E.resultOverlay.classList.add('safe');E.resultKicker.textContent='JUDGEMENT';E.resultSeat.textContent=r.seat;E.resultTitle.textContent='SAFE!';E.resultDetail.textContent=`${r.seat}番に着席`;E.resultScore.textContent=`+${r.gained} PT`;if(r.playerIndex===state.you&&r.seat===12){matchFlags.safe12=true;unlockAchievement('seat12');saveProgress()}playCue('safe');resultTimers.push(setTimeout(()=>showTrapReveal(r),1150))}},850));
}
function showTrapReveal(r){revealTrapSeat=r.trapSeat;revealSafeSeat=r.seat;renderArena();E.resultOverlay.classList.add('reveal-phase');E.resultKicker.textContent='TRAP REVEAL';E.resultSeat.textContent=r.trapSeat;E.resultTitle.textContent=`電気イスは ${r.trapSeat}番`;E.resultDetail.textContent=`${r.seat}番は SAFE / +${r.gained} PT`;E.resultScore.textContent='';E.trapReveal.classList.remove('hidden');E.trapRevealRing.innerHTML='';for(let n=1;n<=12;n++){const theta=-90+(n%12)*30,rad=theta*Math.PI/180,x=50+40*Math.cos(rad),y=50+40*Math.sin(rad);const el=document.createElement('span');el.className=`trap-mini-seat ${n===r.trapSeat?'hot':''} ${n===r.seat?'sat':''}`;el.style.left=`${x}%`;el.style.top=`${y}%`;el.textContent=n;E.trapRevealRing.appendChild(el)}playCue('reveal')}

function renderGameOver(){
 if(E.gameOver.classList.contains('hidden'))openDialog(E.gameOver,null);const w=state.winnerIndex==null?null:state.players[state.winnerIndex];E.winnerTitle.textContent=state.endReason==='protocol_violation'?'対戦無効':w?`${w.name} WIN`:'DRAW';const reasons={target_score:`${state.rules?.targetScore||40}ポイント到達`,forty_points:`${state.rules?.targetScore||40}ポイント到達`,shock_limit:`感電${state.rules?.shockLimit||3}回`,three_shocks:`感電${state.rules?.shockLimit||3}回`,one_seat_left:'イスが残り1脚',reveal_timeout:'相手が結果を公開しませんでした',protocol_violation:`対戦データに不整合を検出しました (${state.protocolError||'UNKNOWN'})`,opponent_left:'相手が退出',disconnect_timeout:'相手が再接続しませんでした',both_disconnected:'両者が再接続しませんでした'};E.winnerDetail.textContent=`${reasons[state.endReason]||'対戦終了'} / ${state.players[0].score} - ${state.players[1].score} PT`;E.seriesScore.textContent=`SERIES  ${state.players[0].wins} - ${state.players[1].wins}`;
 const key=`${state.code}:${state.gameNumber}`;if(lastGameOverKey!==key){lastGameOverKey=key;if(state.endReason!=='protocol_violation')recordGame()}
 renderChallengeResult();
 if(state.analysis){E.aiAnalysis.classList.remove('hidden');E.aiAnalysis.innerHTML=`<b>${escapeHtml(state.analysis.title)}</b><br>${escapeHtml(state.analysis.summary)}<br>${escapeHtml(state.analysis.tip)}`}else E.aiAnalysis.classList.add('hidden');
 if(state.mode==='ai'){E.restart.disabled=false;E.restart.textContent='同じ条件で再戦';E.rematchStatus.textContent=`${state.ai.name} / ${state.ai.difficulty.toUpperCase()}`;return}
 const voted=Boolean(state.rematchVotes?.[state.you]),opponentVoted=Boolean(state.rematchVotes?.[1-state.you]);E.restart.disabled=voted;E.restart.textContent=voted?'再戦希望を送信済み':'同じルームで再戦';E.rematchStatus.textContent=voted?(opponentVoted?'両者同意：次の試合を準備中…':'相手の返答を待っています'):(opponentVoted?'相手が再戦を希望しています':'両者が希望すると同じルームで続行します');
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

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function inviteUrl(){const url=new URL(location.href);url.search='';url.searchParams.set('room',state.roomId);return url.toString()}
async function openInvite(){if(!state||state.mode==='ai')return;E.fullRoomCode.value=state.roomId;openDialog(E.inviteOverlay,E.share);try{await renderQr(E.inviteQr,inviteUrl())}catch{showToast('QRコードを表示できませんでした')}}
async function copyText(value,label){try{await navigator.clipboard.writeText(value);showToast(`${label}をコピーしました`)}catch{showToast('コピーできませんでした')}}
async function nativeShareInvite(){const url=inviteUrl(),text=`電撃イスDUELで対戦しよう！ ROOM ${state.roomId}`;try{if(navigator.share)await navigator.share({title:'ELECTRIC CHAIR DUEL',text,url});else await copyText(url,'招待リンク')}catch(e){if(e?.name!=='AbortError')showToast('共有できませんでした')}}
async function shareReplay(){if(!state?.replay)return showToast('共有できるログがありません');const payload=JSON.stringify(state.replay,null,2);try{if(navigator.share&&typeof File==='function'){const file=new File([payload],`electric-chair-duel-game-${state.gameNumber}.json`,{type:'application/json'});if(navigator.canShare?.({files:[file]}))return await navigator.share({title:'電撃イスDUEL 検証ログ',files:[file]})}await copyText(payload,'検証ログ')}catch(e){if(e?.name!=='AbortError')showToast('検証ログを共有できませんでした')}}

function unlockAudio(){try{audioCtx||=new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume();startAmbient()}catch{}}
function renderSoundSettings(){E.bgmToggle.innerHTML=`BGM <b>${bgmEnabled?'ON':'OFF'}</b>`;E.seToggle.innerHTML=`SE <b>${seEnabled?'ON':'OFF'}</b>`;renderProgressUI()}
function startAmbient(){if(!bgmEnabled||!audioCtx||!E.game.classList.contains('active')||ambientNodes)return;try{const o1=audioCtx.createOscillator(),o2=audioCtx.createOscillator(),g=audioCtx.createGain();o1.type='sine';o2.type='triangle';o1.frequency.value=43;o2.frequency.value=57;g.gain.value=.008;o1.connect(g);o2.connect(g);g.connect(audioCtx.destination);o1.start();o2.start();ambientNodes=[o1,o2,g]}catch{}}
function stopAmbient(){if(!ambientNodes)return;try{ambientNodes[0].stop();ambientNodes[1].stop()}catch{}ambientNodes=null}
function toggleBgm(){bgmEnabled=!bgmEnabled;try{localStorage.setItem('ec_bgm',bgmEnabled?'on':'off')}catch{}renderSoundSettings();if(bgmEnabled){unlockAudio();startAmbient()}else stopAmbient()}
function toggleSe(){seEnabled=!seEnabled;try{localStorage.setItem('ec_se',seEnabled?'on':'off')}catch{}renderSoundSettings()}
function tone(freq,duration,type='square',gain=.03,delay=0){if(!audioCtx)return;const t=audioCtx.currentTime+delay,o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type=type;o.frequency.setValueAtTime(freq,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(gain,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+duration);o.connect(g).connect(audioCtx.destination);o.start(t);o.stop(t+duration+.03)}
function playCue(k){if(!audioCtx||!seEnabled)return;if(k==='select')tone(520,.07,'square',.025);if(k==='confirm'){tone(330,.08,'square',.025);tone(440,.09,'square',.025,.08)}if(k==='lock')tone(190,.16,'sawtooth',.035);if(k==='turn'){tone(260,.09,'square',.02);tone(390,.09,'square',.02,.12)}if(k==='suspense'){tone(110,.35,'sawtooth',.02);tone(105,.35,'sawtooth',.02,.45)}if(k==='safe'){tone(523,.12,'triangle',.04);tone(659,.13,'triangle',.04,.12);tone(784,.24,'triangle',.05,.25)}if(k==='reveal'){tone(220,.08,'sawtooth',.025);tone(440,.1,'square',.03,.08);tone(880,.18,'triangle',.04,.18)}if(k==='shock')[95,150,70,210,55].forEach((f,i)=>tone(f,.18,i%2?'square':'sawtooth',.065,i*.055));if(k==='start'){tone(110,.25,'sawtooth',.035);tone(220,.18,'square',.04,.28);tone(440,.2,'triangle',.05,.52)}}
function showStartIntro(){clearTimeout(startTimer);E.startP0.textContent=state.players[0]?.name||'PLAYER 1';E.startP1.textContent=state.players[1]?.name||'PLAYER 2';E.startMode.textContent=state.mode==='ai'?`${state.ai?.name||'AI'} / ${(state.ai?.difficulty||'').toUpperCase()}`:`ROOM ${state.code}`;E.startP0Img.classList.add('hidden');if(state.mode==='ai'){E.startP1Img.src=aiById(state.ai.id).img;E.startP1Img.classList.remove('hidden')}else E.startP1Img.classList.add('hidden');E.startOverlay.classList.remove('hidden');playCue('start');startTimer=setTimeout(()=>E.startOverlay.classList.add('hidden'),2200)}
function showToast(text){E.toast.textContent=text;E.toast.classList.remove('hidden');clearTimeout(showToast.t);showToast.t=setTimeout(()=>E.toast.classList.add('hidden'),2400)}

function offerUpdate(registration){if(!registration?.waiting)return;E.updateBanner.classList.remove('hidden');E.updateBtn.onclick=()=>registration.waiting?.postMessage({type:'SKIP_WAITING'})}
async function registerServiceWorker(){try{let hadController=Boolean(navigator.serviceWorker.controller);const registration=await navigator.serviceWorker.register('/service-worker.js');offerUpdate(registration);registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)offerUpdate(registration)})});let reloading=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!hadController){hadController=true;return}if(reloading)return;reloading=true;location.reload()})}catch{}}

$$('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));E.goOnline.onclick=()=>switchTab('online');E.goSolo.onclick=()=>switchTab('solo');E.goChallenge.onclick=()=>switchTab('challenge');
E.rules.onclick=()=>openDialog(E.rulesOverlay,E.rules);E.achievements.onclick=()=>{renderProgressUI();openDialog(E.achievementsOverlay,E.achievements)};E.history.onclick=()=>{renderProgressUI();openDialog(E.historyOverlay,E.history)};E.sound.onclick=()=>openDialog(E.soundOverlay,E.sound);
$$('[data-close]').forEach(b=>b.onclick=()=>closeDialog(document.getElementById(b.dataset.close)));
$$('.difficulty').forEach(b=>b.onclick=()=>{$$('.difficulty').forEach(x=>x.classList.remove('active'));b.classList.add('active');difficulty=b.dataset.difficulty;playCue('select')});
E.bgmToggle.onclick=toggleBgm;E.seToggle.onclick=toggleSe;E.create.onclick=createRoom;E.join.onclick=joinRoom;E.startAi.onclick=createAiRoom;E.resume.onclick=()=>{unlockAudio();resumeSession()};E.confirm.onclick=openConfirm;E.finalChoice.onclick=finalChoice;E.cancelChoice.onclick=()=>closeDialog(E.confirmOverlay);E.code.addEventListener('input',()=>{E.code.value=E.code.value.replace(/[^A-Za-z0-9_-]/g,'').slice(0,22)});E.share.onclick=openInvite;E.copyCode.onclick=()=>copyText(state?.roomId||'','ルームコード');E.copyLink.onclick=()=>copyText(inviteUrl(),'招待リンク');E.nativeShare.onclick=nativeShareInvite;E.replayShare.onclick=shareReplay;E.leave.onclick=()=>{if(!state||confirm('対戦を退出しますか？'))requestLeave()};E.restart.onclick=()=>{unlockAudio();send({type:'rematch_vote'})};E.back.onclick=requestLeave;document.addEventListener('keydown',event=>{if(!activeDialog)return;if(event.key==='Escape'){event.preventDefault();closeDialog(activeDialog);return}if(event.key!=='Tab')return;const items=focusableIn(activeDialog);if(!items.length){event.preventDefault();return}const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}});document.addEventListener('pointerdown',unlockAudio,{once:true});if('serviceWorker'in navigator)window.addEventListener('load',registerServiceWorker);if(getSession())resumeSession();
})();
