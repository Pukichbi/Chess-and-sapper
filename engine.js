'use strict';
/*
 * Серверный движок игры «Шахмат и сапёр».
 * Код правил (шахматы, мины, расстановка, взрывы, мат/пат/ничьи) перенесён из index.html
 * ДОСЛОВНО, чтобы сервер и офлайн-режимы играли по одним и тем же правилам.
 * Отличия только в обвязке: состояние G хранится в модуле и подставляется через setG(),
 * а эффекты хода (fx) отдаются через getFx().
 */
let G=null,fx=null;
const FILES='abcdefgh';
const GL={k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};
const PN={k:['король','m'],q:['ферзь','m'],r:['ладья','f'],b:['слон','m'],n:['конь','m'],p:['пешка','f']};
const desc=p=>{const [n,g]=PN[p.t];return (p.c==='w'?(g==='f'?'Белая':'Белый'):(g==='f'?'Чёрная':'Чёрный'))+' '+n;};
const sq=(r,c)=>FILES[c]+(8-r);
const grid=v=>Array.from({length:8},()=>Array(8).fill(v));
const inB=(r,c)=>r>=0&&r<8&&c>=0&&c<8;
const other=c=>c==='w'?'b':'w';
const sideName=c=>c==='w'?'белые':'чёрные';
const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
function nbrs(r,c){const o=[];for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){if(!a&&!b)continue;if(inB(r+a,c+b))o.push([r+a,c+b]);}return o;}
/* ---------- chess core ---------- */
function initBoard(){
  const B=grid(null);const back='rnbqkbnr';
  for(let c=0;c<8;c++){
    B[0][c]={t:back[c],c:'b',m:false};B[1][c]={t:'p',c:'b',m:false};
    B[6][c]={t:'p',c:'w',m:false};B[7][c]={t:back[c],c:'w',m:false};
  }
  return B;
}
const KN=[[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
const DG=[[1,1],[1,-1],[-1,1],[-1,-1]];
const OR=[[1,0],[-1,0],[0,1],[0,-1]];
function attacked(B,r,c,by){
  const dir=by==='w'?1:-1;
  for(const dc of[-1,1]){const rr=r+dir,cc=c+dc;if(inB(rr,cc)){const p=B[rr][cc];if(p&&p.c===by&&p.t==='p')return true;}}
  for(const[a,b]of KN){const rr=r+a,cc=c+b;if(inB(rr,cc)){const p=B[rr][cc];if(p&&p.c===by&&p.t==='n')return true;}}
  for(const[a,b]of nbrs(r,c)){const p=B[a][b];if(p&&p.c===by&&p.t==='k')return true;}
  for(const[a,b]of DG){let rr=r+a,cc=c+b;while(inB(rr,cc)){const p=B[rr][cc];if(p){if(p.c===by&&(p.t==='b'||p.t==='q'))return true;break;}rr+=a;cc+=b;}}
  for(const[a,b]of OR){let rr=r+a,cc=c+b;while(inB(rr,cc)){const p=B[rr][cc];if(p){if(p.c===by&&(p.t==='r'||p.t==='q'))return true;break;}rr+=a;cc+=b;}}
  return false;
}
function findKing(B,color){for(let r=0;r<8;r++)for(let c=0;c<8;c++){const p=B[r][c];if(p&&p.t==='k'&&p.c===color)return{r,c};}return null;}
function pseudo(B,color,ep,noCastle){
  const out=[],opp=other(color);
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){
    const p=B[r][c];if(!p||p.c!==color)continue;
    if(p.t==='p'){
      const dir=color==='w'?-1:1,start=color==='w'?6:1,last=color==='w'?0:7,r1=r+dir;
      if(inB(r1,c)&&!B[r1][c]){
        out.push({fr:r,fc:c,tr:r1,tc:c,promo:r1===last});
        if(r===start&&!B[r+2*dir][c])out.push({fr:r,fc:c,tr:r+2*dir,tc:c,dbl:true});
      }
      for(const dc of[-1,1]){
        const cc=c+dc;if(!inB(r1,cc))continue;
        const t=B[r1][cc];
        if(t&&t.c!==color)out.push({fr:r,fc:c,tr:r1,tc:cc,promo:r1===last});
        else if(!t&&ep&&ep.r===r1&&ep.c===cc){const v=B[r][cc];if(v&&v.t==='p'&&v.c===opp)out.push({fr:r,fc:c,tr:r1,tc:cc,ep:true});}
      }
    }else if(p.t==='n'){
      for(const[a,b]of KN){const rr=r+a,cc=c+b;if(inB(rr,cc)){const t=B[rr][cc];if(!t||t.c!==color)out.push({fr:r,fc:c,tr:rr,tc:cc});}}
    }else if(p.t==='k'){
      for(const[rr,cc]of nbrs(r,c)){const t=B[rr][cc];if(!t||t.c!==color)out.push({fr:r,fc:c,tr:rr,tc:cc});}
      const hr=color==='w'?7:0;
      if(!noCastle&&!p.m&&r===hr&&c===4&&!attacked(B,r,4,opp)){
        const rk=B[hr][7];
        if(rk&&rk.t==='r'&&rk.c===color&&!rk.m&&!B[hr][5]&&!B[hr][6]&&!attacked(B,hr,5,opp)&&!attacked(B,hr,6,opp))
          out.push({fr:r,fc:c,tr:hr,tc:6,castle:'k'});
        const rq=B[hr][0];
        if(rq&&rq.t==='r'&&rq.c===color&&!rq.m&&!B[hr][1]&&!B[hr][2]&&!B[hr][3]&&!attacked(B,hr,3,opp)&&!attacked(B,hr,2,opp))
          out.push({fr:r,fc:c,tr:hr,tc:2,castle:'q'});
      }
    }else{
      const dirs=p.t==='b'?DG:p.t==='r'?OR:DG.concat(OR);
      for(const[a,b]of dirs){let rr=r+a,cc=c+b;while(inB(rr,cc)){const t=B[rr][cc];if(!t)out.push({fr:r,fc:c,tr:rr,tc:cc});else{if(t.c!==color)out.push({fr:r,fc:c,tr:rr,tc:cc});break;}rr+=a;cc+=b;}}
    }
  }
  return out;
}
function sim(B,m){
  const S2=B.map(row=>row.slice());
  const p=S2[m.fr][m.fc];S2[m.fr][m.fc]=null;
  if(m.ep)S2[m.fr][m.tc]=null;
  S2[m.tr][m.tc]=p;
  if(m.castle==='k'){S2[m.fr][5]=S2[m.fr][7];S2[m.fr][7]=null;}
  if(m.castle==='q'){S2[m.fr][3]=S2[m.fr][0];S2[m.fr][0]=null;}
  return S2;
}
function legal(B,color,ep,noCastle){
  const opp=other(color);
  return pseudo(B,color,ep,noCastle).filter(m=>{
    const t=B[m.tr][m.tc];
    if(t&&t.t==='k')return true;
    const S2=sim(B,m),k=findKing(S2,color);
    return !k||!attacked(S2,k.r,k.c,opp);
  });
}
function insufficient(B){
  const rest=[];
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){const p=B[r][c];if(p&&p.t!=='k')rest.push(Object.assign({},p,{r:r,c2:c}));}
  if(!rest.length)return true;
  if(rest.some(p=>p.t==='p'||p.t==='r'||p.t==='q'))return false;
  if(rest.length===1)return true;
  if(rest.every(p=>p.t==='b')){const col=(rest[0].r+rest[0].c2)%2;return rest.every(p=>(p.r+p.c2)%2===col);}
  return false;
}
function hasMatingMaterial(B,color){
  let minors=0;
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){const p=B[r][c];if(!p||p.c!==color)continue;
    if(p.t==='p'||p.t==='r'||p.t==='q')return true;
    if(p.t==='b'||p.t==='n')minors++;}
  return minors>=2;
}
function posKey(){
  let s='';
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){const p=G.board[r][c];s+=p?(p.c+p.t+((p.t==='k'||p.t==='r')&&!p.m?'u':'')):'.';}
  return s+G.turn+(G.ep?G.ep.r+''+G.ep.c:'-');
}

/* ---------- mines ---------- */
function computeNumbers(){
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){
    let n=0;for(const[a,b]of nbrs(r,c))if(G.mine[a][b])n++;
    G.num[r][c]=n;
  }
}
/* Расстановка мин «вразброс»: из нескольких случайных кандидатов берём клетку, которая закрывает больше
   клеток без мин рядом (пустых). Так пустых полей получается чуть меньше. Цифры по-прежнему считаются
   по реально стоящим минам, поэтому они всегда совпадают с ними. SPREAD_TRIES больше = пустых меньше. */
const SPREAD_TRIES=3;
function spreadPick(avail,M,count){
  const cover=grid(0);
  for(let r=0;r<8;r++)for(let c=0;c<8;c++)if(M[r][c])for(const[a,b]of nbrs(r,c))cover[a][b]++;
  const pool=shuffle(avail.slice());
  for(let i=0;i<count&&pool.length;i++){
    let bi=0,bs=-1;
    const tries=Math.min(SPREAD_TRIES,pool.length);
    for(let t=0;t<tries;t++){
      const q=pool[t];let sc=0;
      for(const[a,b]of nbrs(q>>3,q&7))if(cover[a][b]===0&&!M[a][b])sc++;
      if(sc>bs){bs=sc;bi=t;}
    }
    const q=pool.splice(bi,1)[0];
    M[q>>3][q&7]=true;
    for(const[a,b]of nbrs(q>>3,q&7))cover[a][b]++;
  }
}
function setupWhiteZone(r,c){
  const cand=shuffle(nbrs(r,c).filter(([a,b])=>!G.board[a][b]));
  const k=2+(Math.random()<.5?1:0);
  const zone=[[r,c],...cand.slice(0,k)];
  const zs=new Set(zone.map(([a,b])=>a*8+b));
  const cells=[];for(let i=0;i<64;i++)if(!zs.has(i))cells.push(i);
  G.mine=grid(false);
  spreadPick(cells,G.mine,G.N);
  computeNumbers();
  zone.forEach(([a,b])=>{G.revealed[a][b]=true;});
  G.placed=true;
}
function solveLayout(zone){
  const safe=new Set(zone.map(([a,b])=>a*8+b));
  const fIdx=new Map(),F=[],cons=[];
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){
    if(!G.revealed[r][c])continue;
    const vars=[];
    for(const[a,b]of nbrs(r,c)){
      if(G.revealed[a][b])continue;
      const key=a*8+b;
      if(!fIdx.has(key)){fIdx.set(key,F.length);F.push(key);}
      vars.push(fIdx.get(key));
    }
    cons.push({n:G.num[r][c],vars,sum:0,rem:vars.length});
  }
  const nF=F.length,val=new Array(nF).fill(-1);
  const varCons=Array.from({length:nF},()=>[]);
  cons.forEach((cn,i)=>cn.vars.forEach(v=>varCons[v].push(i)));
  const I=[];
  for(let i=0;i<64;i++){if(fIdx.has(i)||safe.has(i)||G.revealed[i>>3][i&7])continue;I.push(i);}
  const order=shuffle([...Array(nF).keys()]);
  let nodes=0;
  function dfs(i){
    if(++nodes>300000)return false;
    if(i===nF){let m=0;for(let v=0;v<nF;v++)m+=val[v];const need=G.N-m;return need>=0&&need<=I.length;}
    const v=order[i],key=F[v],cur=G.mine[key>>3][key&7]?1:0;
    const opts=safe.has(key)?[0]:(Math.random()<.85?[cur,1-cur]:[1-cur,cur]);
    for(const x of opts){
      let ok=true;
      for(const ci of varCons[v]){const cn=cons[ci];cn.sum+=x;cn.rem--;}
      for(const ci of varCons[v]){const cn=cons[ci];if(cn.sum>cn.n||cn.sum+cn.rem<cn.n){ok=false;break;}}
      if(ok){val[v]=x;if(dfs(i+1))return true;}
      for(const ci of varCons[v]){const cn=cons[ci];cn.sum-=x;cn.rem++;}
    }
    val[v]=-1;return false;
  }
  if(!dfs(0))return null;
  const M=grid(false);let m=0;
  F.forEach((key,v)=>{if(val[v]===1){M[key>>3][key&7]=true;m++;}});
  const need=G.N-m;
  let curI=I.filter(k=>G.mine[k>>3][k&7]);
  shuffle(curI);
  if(curI.length>need)curI.length=need;
  curI.forEach(k=>{M[k>>3][k&7]=true;});
  if(curI.length<need){
    spreadPick(I.filter(k=>!M[k>>3][k&7]),M,need-curI.length);
  }
  return M;
}
function setupBlackZone(r,c){
  const cand=nbrs(r,c).filter(([a,b])=>!G.board[a][b]&&!G.revealed[a][b]);
  const k0=2+(Math.random()<.5?1:0);
  for(let k=Math.min(k0,cand.length);k>=0;k--){
    for(let t=0;t<(k===0?1:25);t++){
      const ordered=shuffle(cand.slice());
      if(t===0)ordered.sort((x,y)=>(G.mine[x[0]][x[1]]?1:0)-(G.mine[y[0]][y[1]]?1:0));
      const nb=ordered.slice(0,k);
      const zone=[[r,c],...nb];
      const clean=zone.every(([a,b])=>!G.mine[a][b]);
      if(clean){nb.forEach(([a,b])=>{G.revealed[a][b]=true;});return;}
      const sol=solveLayout(zone);
      if(sol){G.mine=sol;computeNumbers();nb.forEach(([a,b])=>{G.revealed[a][b]=true;});return;}
    }
  }
}
function openCell(r,c){
  if(G.mine[r][c]){
    G.revealed[r][c]=true;
    G.mine[r][c]=false;
    G.crater[r][c]=true;
    G.board[r][c]=null;
    return true;
  }
  G.revealed[r][c]=true;
  return false;
}

/* Автоматическое раскрытие безопасной области, как в «Сапёре».
   Раскрываем соседние безопасные пустые клетки и клетки с числами.
   Клетки с фигурами не открываем автоматически: фигура должна сама
   попасть на такую клетку, чтобы проверить её на мину. */
function revealSafeArea(r,c){
  if(!G||G.mine[r][c]||G.crater[r][c])return;
  const queue=[[r,c]],seen=new Set();
  while(queue.length){
    const [a,b]=queue.shift(),key=a*8+b;
    if(seen.has(key)||!inB(a,b))continue;
    seen.add(key);
    if(G.mine[a][b]||G.crater[a][b])continue;
    if((a!==r||b!==c)&&G.board[a][b])continue;
    G.revealed[a][b]=true;
    if(G.num[a][b]===0){
      for(const [nr,nc] of nbrs(a,b)){
        const nk=nr*8+nc;
        if(!seen.has(nk)&&!G.mine[nr][nc]&&!G.crater[nr][nc]&&!G.board[nr][nc]){
          queue.push([nr,nc]);
        }else if(!seen.has(nk)&&!G.mine[nr][nc]&&!G.crater[nr][nc]&&G.num[nr][nc]>0&&!G.board[nr][nc]){
          queue.push([nr,nc]);
        }
      }
    }
  }
}

/* ---------- game state ---------- */
function newState(mines,minutes){
  const ms=minutes*60000;
  G={board:initBoard(),turn:'w',N:mines,revealed:grid(false),crater:grid(false),mine:grid(false),num:grid(0),
     placed:false,bFirst:false,ep:null,half:0,reps:{},last:null,
     clock:{w:ms,b:ms},over:null,boom:null,msg:'Первый ход определит безопасную зону.',turnAt:Date.now(),legal:[],
     mode:'local',human:'w',bot:'b',level:'medium'};
  G.reps[posKey()]=1;
  return G;
}
function refreshLegal(){G.legal=legal(G.board,G.turn,G.ep);}
function remain(s){return G.clock[s]-((G.turn===s&&!G.over)?Date.now()-G.turnAt:0);}
function fmt(ms){const s=Math.max(0,Math.ceil(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function setOver(res){G.over=res;}
function applyMove(m,promoT){
  if(G.over)return false;
  const B=G.board,color=G.turn;
  const left=remain(color);
  if(left<=0)return false;
  G.clock[color]=left;G.turnAt=Date.now();
  const p=B[m.fr][m.fc];
  const wasPawn=p.t==='p';
  const name=desc(p);
  let captured=B[m.tr][m.tc];
  if(m.ep){captured=B[m.fr][m.tc];B[m.fr][m.tc]=null;}
  B[m.fr][m.fc]=null;B[m.tr][m.tc]=p;p.m=true;
  let opener=null;
  let openName=name,openVerb=PN[p.t][1]==='f'?'подорвалась':'подорвался';
  if(p.t!=='k')opener={r:m.tr,c:m.tc};
  if(m.castle){
    const rr=m.fr;let rook;
    if(m.castle==='k'){rook=B[rr][7];B[rr][7]=null;B[rr][5]=rook;opener={r:rr,c:5};}
    else{rook=B[rr][0];B[rr][0]=null;B[rr][3]=rook;opener={r:rr,c:3};}
    rook.m=true;openName=desc(rook);openVerb='подорвалась';
  }
  if(m.promo&&promoT)p.t=promoT;
  let exploded=false;
  if(opener){
    if(!G.placed)setupWhiteZone(opener.r,opener.c);
    else if(color==='b'&&!G.bFirst)setupBlackZone(opener.r,opener.c);
    if(color==='b')G.bFirst=true;
    exploded=openCell(opener.r,opener.c);
    if(exploded)G.boom={r:opener.r,c:opener.c,t:Date.now()};
    else revealSafeArea(opener.r,opener.c);
  }
  fx={boom:exploded,cap:!!captured,check:false};
  let text;
  if(m.castle)text=(m.castle==='k'?'Короткая':'Длинная')+' рокировка.';
  else text=`${name} ${sq(m.fr,m.fc)}→${sq(m.tr,m.tc)}`+(captured&&!exploded?`, берёт: ${desc(captured).toLowerCase()}.`:'.');
  if(exploded){
    text+=` 💥 ${openName} ${openVerb} на мине (${sq(opener.r,opener.c)})!`;
    if(captured)text+=` Взятая фигура (${desc(captured).toLowerCase()}) тоже потеряна.`;
  }
  if(m.promo&&promoT&&!exploded)text+=` Превращение: ${PN[promoT][0]}.`;
  G.ep=(m.dbl&&B[m.tr][m.tc]===p)?{r:(m.fr+m.tr)/2,c:m.fc}:null;
  G.last={fr:m.fr,fc:m.fc,tr:m.tr,tc:m.tc};
  if(wasPawn||captured||exploded)G.half=0;else G.half++;
  if(captured&&captured.t==='k'){G.msg=text;setOver({winner:color,reason:'король захвачен'});return true;}
  G.turn=other(color);
  const key=posKey();G.reps[key]=(G.reps[key]||0)+1;
  const mv=legal(B,G.turn,G.ep);
  const kOpp=findKing(B,G.turn),kMe=findKing(B,color);
  const meAtt=kMe&&attacked(B,kMe.r,kMe.c,G.turn);
  const oppInCheck=kOpp&&attacked(B,kOpp.r,kOpp.c,color);
  fx.check=!!(oppInCheck||meAtt);
  if(!meAtt&&mv.length===0){
    G.msg=text;
    if(oppInCheck)setOver({winner:color,reason:'мат'});else setOver({draw:true,reason:'пат'});
    return true;
  }
  if(insufficient(B)){G.msg=text;setOver({draw:true,reason:'недостаточно материала'});return true;}
  if(G.half>=100){G.msg=text;setOver({draw:true,reason:'правило 50 ходов'});return true;}
  if(G.reps[key]>=3){G.msg=text;setOver({draw:true,reason:'троекратное повторение'});return true;}
  if(meAtt)text+=` ⚠️ Король ${color==='w'?'белых':'чёрных'} под боем: ${sideName(G.turn)} могут взять его!`;
  else if(oppInCheck)text+=' Шах!';
  G.msg=text;
  return true;
}
/* ---------- обвязка для сервера ---------- */
module.exports={
  setG(g){G=g;},getG(){return G;},getFx(){return fx;},
  newState,refreshLegal,remain,fmt,setOver,applyMove,legal,attacked,findKing,hasMatingMaterial,
  other,sideName,grid,
};
