// Тест обхода зон: транспилируем routing.ts esbuild'ом и гоняем сценарии
import { build } from 'esbuild';
const res = await build({ entryPoints:['src/utils/routing.ts'], bundle:true, format:'esm', write:false, external:['./googleMaps','./actionMode'] });
// проще: соберём без external (импорты локальные)
const res2 = await build({ entryPoints:['src/utils/routing.ts'], bundle:true, format:'esm', write:false });
const code = res2.outputFiles[0].text;
const mod = await import('data:text/javascript,' + encodeURIComponent(code));
const { planPathAroundZones, zonesCrossedBy } = mod;
let pass=0, fail=0;
function check(name, cond){ if(cond){pass++;console.log('PASS',name);} else {fail++;console.log('FAIL',name);} }
const mkCircle=(id,cx,cy,r)=>({id,name:id,type:'circle',points:[{x:cx,y:cy}],radius:r,active:true});
const mkRect=(id,x1,y1,x2,y2)=>({id,name:id,type:'rectangle',points:[{x:x1,y:y1},{x:x2,y:y2}],active:true});
const W=1280,H=1280;
function segsClean(path, zones){ return zonesCrossedBy(path.map(p=>({x:p.x,y:p.y})), zones).length===0; }

// 1. Круг прямо между старт/гоал — обязан обойти
{ const z=[mkCircle('c1',640,640,200)]; const p=planPathAroundZones({x:100,y:640},{x:1180,y:640},z,W,H);
  check('circle detour length>2', p.length>2); check('circle detour clean', segsClean(p,z)); }
// 2. Прямоугольник поперёк
{ const z=[mkRect('r1',400,300,900,950)]; const p=planPathAroundZones({x:100,y:620},{x:1150,y:620},z,W,H);
  check('rect detour clean', segsClean(p,z)); }
// 3. Зона в стороне — прямой путь сохраняется
{ const z=[mkCircle('c2',640,100,120)]; const p=planPathAroundZones({x:100,y:1100},{x:1100,y:1100},z,W,H);
  check('no-touch direct', p.length===2 && segsClean(p,z)); }
// 4. Два круга подряд (коридор между ними)
{ const z=[mkCircle('a',500,640,180),mkCircle('b',800,640,180)]; const p=planPathAroundZones({x:100,y:640},{x:1150,y:640},z,W,H);
  check('two circles clean', segsClean(p,z)); }
// 5. Круг перегораживает весь проход (стена) — цель за стеной, обход сверху/снизу
{ const z=[mkCircle('w',640,640,400)]; const p=planPathAroundZones({x:100,y:640},{x:1180,y:640},z,W,H);
  check('big wall clean', segsClean(p,z)); }
// 6. Непрямой маршрут (ломаная с ключевыми точками) — каждый сегмент чищ
{ const z=[mkCircle('c3',400,400,150)];
  const legs=[[{x:100,y:100},{x:700,y:100}],[{x:700,y:100},{x:700,y:700}],[{x:700,y:700},{x:100,y:700}]];
  let ok=true; for(const [a,b] of legs){ const p=planPathAroundZones(a,b,z,W,H); if(!segsClean(p,z)) ok=false; }
  check('polyline legs clean', ok); }
// 7. Прямоугольник вокруг старта (старт внутри зоны) — fallback допустим, но не падает
{ const z=[mkRect('r2',50,50,600,600)]; const p=planPathAroundZones({x:100,y:100},{x:1000,y:1000},z,W,H);
  check('start-inside returns path', Array.isArray(p) && p.length>=2); }
// 8. Пустые зоны
{ const p=planPathAroundZones({x:10,y:10},{x:500,y:500},[],W,H); check('empty zones direct', p.length===2); }
// 9. Неактивная зона игнорируется
{ const z=[{...mkCircle('off',640,640,200),active:false}]; const p=planPathAroundZones({x:100,y:640},{x:1180,y:640},z,W,H);
  check('inactive ignored', p.length===2); }
// 10. Круг у самой цели (цель рядом с границей зоны)
{ const z=[mkCircle('near',900,640,250)]; const p=planPathAroundZones({x:100,y:640},{x:1200,y:640},z,W,H);
  check('goal-near-circle clean or direct', segsClean(p,z)||p.length===2&&segsClean(p,z)); }
// 11. Три прямоугольника со смещением (зигзаг-коридор)
{ const z=[mkRect('q1',300,0,360,800),mkRect('q2',600,480,660,1280),mkRect('q3',900,0,960,800)];
  const p=planPathAroundZones({x:100,y:640},{x:1180,y:640},z,W,H);
  check('zigzag corridor clean', segsClean(p,z)); }
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail?1:0);
