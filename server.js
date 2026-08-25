const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('./mini-ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 180 * 1000;
const MAX_NAME = 16;
const RESULT_DELAY_MS = 5000;
const STANDARD_SEATS = Array.from({length:12},(_,i)=>i+1);

const AI_PROFILES = {
  rei:{id:'rei',name:'レイ',style:'冷徹分析型'},
  gou:{id:'gou',name:'ゴウ',style:'豪胆ギャンブラー'},
  mika:{id:'mika',name:'ミカ',style:'読心トリックスター'},
  nagi:{id:'nagi',name:'ナギ',style:'慎重堅実型'}
};
const DIFFICULTIES = new Set(['easy','normal','hard']);
const CHALLENGE_RULES = {
  no_shock:{targetScore:40,shockLimit:3,seats:STANDARD_SEATS},
  six_turns:{targetScore:40,shockLimit:3,seats:STANDARD_SEATS},
  high_risk:{targetScore:30,shockLimit:2,seats:[7,8,9,10,11,12]},
  sudden:{targetScore:25,shockLimit:1,seats:STANDARD_SEATS}
};
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon'};
const rooms=new Map();
const SNAPSHOT_FILE=path.join(__dirname,'.room-snapshots.json');

function persistRooms(){try{const data=[...rooms.entries()].map(([code,room])=>[code,{...room,players:room.players.map(p=>p?{...p,ws:null}:null)}]);fs.writeFileSync(SNAPSHOT_FILE,JSON.stringify(data))}catch(err){console.warn('snapshot write failed',err.message)}}
function restoreRooms(){try{if(!fs.existsSync(SNAPSHOT_FILE))return;const data=JSON.parse(fs.readFileSync(SNAPSHOT_FILE,'utf8')),now=Date.now();for(const[code,room]of data){if(now-(room.updatedAt||0)>ROOM_TTL_MS)continue;room.players=(room.players||[]).map(p=>p?{...p,ws:null,connected:Boolean(p.isAI),disconnectedAt:p.isAI?null:now}:null);room.rules ||= {targetScore:40,shockLimit:3,seats:STANDARD_SEATS};room.history ||= {traps:[[],[]],sits:[[],[]],outcomes:[[],[]]};rooms.set(code,room)}console.log(`Restored ${rooms.size} room(s)`)}catch(err){console.warn('snapshot restore failed',err.message)}}

const server=http.createServer((req,res)=>{
  const urlPath=decodeURIComponent((req.url||'/').split('?')[0]);
  if(urlPath==='/health'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,rooms:rooms.size,version:'3.2.0',ts:Date.now()}))}
  const requested=urlPath==='/'?'/index.html':urlPath;
  const resolved=path.resolve(PUBLIC_DIR,'.'+requested),root=path.resolve(PUBLIC_DIR)+path.sep;
  if(resolved!==path.resolve(PUBLIC_DIR,'index.html')&&!resolved.startsWith(root)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(resolved,(err,data)=>{if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not Found')}res.writeHead(200,{'Content-Type':MIME[path.extname(resolved)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)})
});
const wss=new WebSocketServer({server});

function cleanName(v){const s=String(v||'').trim().replace(/[<>]/g,'');return(s||'PLAYER').slice(0,MAX_NAME)}
function makeCode(){for(let i=0;i<1000;i++){const c=String(crypto.randomInt(100000,1000000));if(!rooms.has(c))return c}throw new Error('Room code exhaustion')}
function newPlayer(name,extra={}){return{id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),name:cleanName(name),score:0,shocks:0,wins:0,ws:null,connected:false,disconnectedAt:null,isAI:false,...extra}}
function rulesFor(challengeId){const r=CHALLENGE_RULES[challengeId];return r?{targetScore:r.targetScore,shockLimit:r.shockLimit,seats:[...r.seats]}:{targetScore:40,shockLimit:3,seats:[...STANDARD_SEATS]}}
function newRoom(hostName,mode='human',challengeId=null){const code=makeCode(),host=newPlayer(hostName),rules=rulesFor(challengeId);const room={code,mode,challengeId:challengeId||null,rules,players:[host,null],phase:'waiting',setterIndex:null,sitterIndex:null,trapSeat:null,remainingSeats:[...rules.seats],turnNumber:0,lastResult:null,winnerIndex:null,endReason:null,pendingEnd:null,rematchVotes:[false,false],gameNumber:0,createdAt:Date.now(),updatedAt:Date.now(),aiProfile:null,aiDifficulty:null,history:{traps:[[],[]],sits:[[],[]],outcomes:[[],[]]}};rooms.set(code,room);return{room,player:host,index:0}}
function publicPlayer(p){return p?{name:p.name,score:p.score,shocks:p.shocks,wins:p.wins,connected:p.connected,isAI:Boolean(p.isAI)}:null}
function publicAI(room){if(!room.aiProfile)return null;return{...AI_PROFILES[room.aiProfile],difficulty:room.aiDifficulty}}
function viewFor(room,viewerIndex){return{code:room.code,you:viewerIndex,mode:room.mode,challengeId:room.challengeId,rules:{targetScore:room.rules.targetScore,shockLimit:room.rules.shockLimit,seats:room.rules.seats},phase:room.phase,players:room.players.map(publicPlayer),setterIndex:room.setterIndex,sitterIndex:room.sitterIndex,remainingSeats:room.remainingSeats,turnNumber:room.turnNumber,gameNumber:room.gameNumber,lastResult:room.lastResult,winnerIndex:room.winnerIndex,endReason:room.endReason,rematchVotes:room.rematchVotes,ai:publicAI(room),canSetTrap:room.phase==='set_trap'&&viewerIndex===room.setterIndex,canChooseSeat:room.phase==='choose_seat'&&viewerIndex===room.sitterIndex}}
function send(ws,payload){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(payload))}
function broadcastState(room){room.updatedAt=Date.now();room.players.forEach((p,i)=>{if(p?.ws)send(p.ws,{type:'state',state:viewFor(room,i)})});persistRooms()}
function fail(ws,m){send(ws,{type:'error',message:m})}
function startGame(room){room.players.forEach(p=>{if(p){p.score=0;p.shocks=0}});room.remainingSeats=[...room.rules.seats];room.turnNumber=1;room.gameNumber+=1;room.trapSeat=null;room.lastResult=null;room.winnerIndex=null;room.endReason=null;room.pendingEnd=null;room.rematchVotes=[false,false];room.history={traps:[[],[]],sits:[[],[]],outcomes:[[],[]]};room.setterIndex=crypto.randomInt(0,2);room.sitterIndex=1-room.setterIndex;room.phase='set_trap';broadcastState(room);scheduleAI(room)}
function endGame(room,winnerIndex,reason){if(room.phase==='game_over')return;room.phase='game_over';room.winnerIndex=winnerIndex;room.endReason=reason;room.trapSeat=null;room.rematchVotes=[false,false];if(winnerIndex!=null&&room.players[winnerIndex])room.players[winnerIndex].wins+=1;broadcastState(room)}
function getEndOutcome(room,actorIndex){const actor=room.players[actorIndex],opp=1-actorIndex;if(actor.shocks>=room.rules.shockLimit)return{winnerIndex:opp,reason:'three_shocks'};if(actor.score>=room.rules.targetScore)return{winnerIndex:actorIndex,reason:'forty_points'};if(room.remainingSeats.length<=1){const[a,b]=room.players;return{winnerIndex:a.score===b.score?null:(a.score>b.score?0:1),reason:'one_seat_left'}}return null}
function nextTurn(room){const old=room.setterIndex;room.setterIndex=room.sitterIndex;room.sitterIndex=old;room.trapSeat=null;room.phase='set_trap';room.turnNumber+=1;broadcastState(room);scheduleAI(room)}
function findByToken(room,token){const index=room.players.findIndex(p=>p&&p.token===token);return index>=0?{player:room.players[index],index}:null}
function attach(ws,room,player,index){if(player.ws&&player.ws!==ws&&player.ws.readyState===WebSocket.OPEN)player.ws.close(4001,'Signed in elsewhere');player.ws=ws;player.connected=true;player.disconnectedAt=null;ws.session={roomCode:room.code,playerToken:player.token,playerIndex:index};send(ws,{type:'session',roomCode:room.code,playerToken:player.token,playerIndex:index});broadcastState(room);scheduleAI(room)}

function weightedPick(items,scoreFn){const scores=items.map(x=>Math.max(.001,scoreFn(x))),total=scores.reduce((a,b)=>a+b,0);let r=Math.random()*total;for(let i=0;i<items.length;i++){r-=scores[i];if(r<=0)return items[i]}return items[items.length-1]}
function freq(arr,n){return arr.filter(x=>x===n).length}
function recency(arr,n){let s=0;arr.slice(-6).forEach((x,i)=>{if(x===n)s+=i+1});return s}
function humanSeatTendency(room,n){const sits=room.history.sits[0],human=room.players[0];let t=freq(sits,n)*1.05+recency(sits,n)*.34+n*.05;if(human.score>=Math.max(18,room.rules.targetScore-15)&&human.score+n>=room.rules.targetScore)t+=2.5;if(human.shocks>=room.rules.shockLimit-1&&n<=6)t+=1.25;if(sits.length>=2&&sits.at(-1)>8&&n>8)t+=.45;return t}
function aiTrapChoice(room){const seats=room.remainingSeats,profile=room.aiProfile,diff=room.aiDifficulty,humanSits=room.history.sits[0];if(diff==='easy')return seats[crypto.randomInt(0,seats.length)];return weightedPick(seats,n=>{let s=1+n*.18,obs=freq(humanSits,n)+(diff==='hard'?recency(humanSits,n)*.55:0);s+=obs*(diff==='hard'?2.2:1.05);if(diff==='hard')s+=humanSeatTendency(room,n)*1.45;if(profile==='gou')s+=n>=9?3.5:n*.08;if(profile==='nagi')s+=n>=7&&n<=10?1.7:n>=11?.7:0;if(profile==='mika')s+=((n+room.turnNumber)%3===0?1.5:0)+Math.random()*2.2;if(profile==='rei')s+=n*.16+obs*1.2;return s})}
function estimatedHumanTrapProb(room,n){const traps=room.history.traps[0],human=room.players[0];let base=.42+n*.052,repeat=freq(traps,n)*.82,recent=recency(traps,n)*.26;if(human.score>=Math.max(18,room.rules.targetScore-16)&&n>=9)base+=.55;if(human.shocks>=room.rules.shockLimit-1&&n<=6)base+=.18;return base+repeat+recent}
function aiSeatChoice(room){const seats=room.remainingSeats,profile=room.aiProfile,diff=room.aiDifficulty,ai=room.players[1];if(diff==='easy')return seats[crypto.randomInt(0,seats.length)];return weightedPick(seats,n=>{const risk=estimatedHumanTrapProb(room,n);let s=1;if(profile==='gou')s=Math.pow(n,1.55)/(1+risk*(diff==='hard'?.35:.18));else if(profile==='nagi')s=(n*.9+4)/(1+risk*(diff==='hard'?2.3:1.4)+(ai.score>room.rules.targetScore/2?1.2:0));else if(profile==='mika')s=(n*1.15+Math.random()*8)/(1+risk*(diff==='hard'?1.25:.7));else s=(n*1.35+2)/(1+risk*(diff==='hard'?1.8:.9));if(ai.shocks>=room.rules.shockLimit-1)s/=1+risk*1.8;if(ai.score+n>=room.rules.targetScore)s*=1.75;return Math.max(.01,s)})}
function applySeatChoice(room,idx,seat){const shocked=seat===room.trapSeat,sitter=room.players[idx],before=sitter.score;room.history.sits[idx].push(seat);if(shocked){sitter.score=0;sitter.shocks+=1}else{sitter.score+=seat;room.remainingSeats=room.remainingSeats.filter(n=>n!==seat)}room.history.outcomes[idx].push({seat,shocked,scoreBefore:before,scoreAfter:sitter.score});room.lastResult={seat,trapSeat:room.trapSeat,shocked,playerIndex:idx,pointsBefore:before,pointsAfter:sitter.score,gained:shocked?0:seat};room.trapSeat=null;room.phase='result';room.pendingEnd=getEndOutcome(room,idx);broadcastState(room);setTimeout(()=>{if(rooms.get(room.code)!==room||room.phase!=='result')return;const pending=room.pendingEnd;room.pendingEnd=null;if(pending)endGame(room,pending.winnerIndex,pending.reason);else nextTurn(room)},RESULT_DELAY_MS)}
function scheduleAI(room){if(room.mode!=='ai'||room.phase==='game_over')return;const delay=room.aiDifficulty==='hard'?650:room.aiDifficulty==='normal'?900:1150;if(room.phase==='set_trap'&&room.setterIndex===1)setTimeout(()=>{if(rooms.get(room.code)!==room||room.phase!=='set_trap'||room.setterIndex!==1)return;const seat=aiTrapChoice(room);room.trapSeat=seat;room.history.traps[1].push(seat);room.phase='choose_seat';room.lastResult=null;broadcastState(room);scheduleAI(room)},delay+crypto.randomInt(150,650));if(room.phase==='choose_seat'&&room.sitterIndex===1)setTimeout(()=>{if(rooms.get(room.code)!==room||room.phase!=='choose_seat'||room.sitterIndex!==1)return;applySeatChoice(room,1,aiSeatChoice(room))},delay+crypto.randomInt(250,900))}

wss.on('connection',ws=>{
  send(ws,{type:'hello',serverTime:Date.now(),version:'3.2.0'});
  ws.on('message',raw=>{let msg;try{msg=JSON.parse(raw.toString())}catch{return fail(ws,'不正なデータです')}try{
    if(msg.type==='ping'){send(ws,{type:'pong',ts:Date.now()});return}
    if(msg.type==='create_room'){const{room,player,index}=newRoom(msg.name,'human');attach(ws,room,player,index);return}
    if(msg.type==='create_ai_room'){const profile=AI_PROFILES[msg.aiId]||AI_PROFILES.rei,difficulty=DIFFICULTIES.has(msg.difficulty)?msg.difficulty:'normal',challengeId=Object.hasOwn(CHALLENGE_RULES,msg.challengeId)?msg.challengeId:null;const{room,player,index}=newRoom(msg.name,'ai',challengeId);room.aiProfile=profile.id;room.aiDifficulty=difficulty;room.players[1]=newPlayer(profile.name,{isAI:true,connected:true});attach(ws,room,player,index);startGame(room);return}
    if(msg.type==='join_room'){const code=String(msg.code||'').replace(/\D/g,'').slice(0,6),room=rooms.get(code);if(!room)return fail(ws,'ルームが見つかりません');if(room.mode==='ai')return fail(ws,'このルームはAI対戦です');if(room.players[1])return fail(ws,'このルームは満員です');const player=newPlayer(msg.name);room.players[1]=player;attach(ws,room,player,1);startGame(room);return}
    if(msg.type==='resume'){const room=rooms.get(String(msg.code||''));if(!room)return fail(ws,'再接続するルームがありません');const found=findByToken(room,String(msg.token||''));if(!found)return fail(ws,'再接続情報が一致しません');attach(ws,room,found.player,found.index);return}
    const s=ws.session;if(!s)return fail(ws,'先にルームへ参加してください');const room=rooms.get(s.roomCode);if(!room)return fail(ws,'ルームが終了しています');const found=findByToken(room,s.playerToken);if(!found)return fail(ws,'セッションが無効です');const idx=found.index;
    if(msg.type==='set_trap'){if(room.phase!=='set_trap'||idx!==room.setterIndex)return fail(ws,'今は電気イスを設定できません');const seat=Number(msg.seat);if(!room.remainingSeats.includes(seat))return fail(ws,'そのイスは選べません');room.trapSeat=seat;room.history.traps[idx].push(seat);room.phase='choose_seat';room.lastResult=null;broadcastState(room);scheduleAI(room);return}
    if(msg.type==='choose_seat'){if(room.phase!=='choose_seat'||idx!==room.sitterIndex)return fail(ws,'今は着席できません');const seat=Number(msg.seat);if(!room.remainingSeats.includes(seat))return fail(ws,'そのイスは選べません');applySeatChoice(room,idx,seat);return}
    if(msg.type==='rematch_vote'){if(room.phase!=='game_over')return fail(ws,'ゲーム終了後に使えます');if(room.mode==='ai'){room.rematchVotes=[true,true];startGame(room);return}room.rematchVotes[idx]=true;if(room.rematchVotes[0]&&room.rematchVotes[1])startGame(room);else broadcastState(room);return}
    if(msg.type==='leave'){const opp=1-idx;if(room.mode==='human'&&room.phase!=='waiting'&&room.phase!=='game_over'&&room.players[opp])endGame(room,opp,'opponent_left');found.player.connected=false;found.player.ws=null;ws.session=null;send(ws,{type:'left'});if(room.mode==='ai')rooms.delete(room.code);return}
  }catch(err){console.error(err);fail(ws,'サーバー内部でエラーが発生しました')}});
  ws.on('close',()=>{const s=ws.session;if(!s)return;const room=rooms.get(s.roomCode);if(!room)return;const found=findByToken(room,s.playerToken);if(!found||found.player.ws!==ws)return;found.player.ws=null;found.player.connected=false;found.player.disconnectedAt=Date.now();broadcastState(room)})
});
setInterval(()=>{const now=Date.now();for(const[code,room]of rooms){if(room.mode==='human'&&!['waiting','game_over'].includes(room.phase)){room.players.forEach((p,idx)=>{if(p&&!p.isAI&&!p.connected&&p.disconnectedAt&&now-p.disconnectedAt>RECONNECT_GRACE_MS&&room.phase!=='game_over'){const opp=room.players[1-idx];if(opp)endGame(room,1-idx,'disconnect_timeout')}})}if(now-room.updatedAt>ROOM_TTL_MS){rooms.delete(code);persistRooms()}}},5000);
restoreRooms();for(const room of rooms.values())if(room.phase==='result')setTimeout(()=>{if(room.phase!=='result')return;const pending=room.pendingEnd;room.pendingEnd=null;if(pending)endGame(room,pending.winnerIndex,pending.reason);else nextTurn(room)},RESULT_DELAY_MS);
server.listen(PORT,'0.0.0.0',()=>console.log(`Electric Chair Duel v3.2 listening on http://localhost:${PORT}`));
