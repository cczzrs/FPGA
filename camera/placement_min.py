"""在 placement.py 的基础上：允许剪针 + 飞线，找飞线最少的直插方案（差分极性可在逻辑里反转）。"""
import itertools
exec(open('placement.py').read().split('results = []')[0])
PAIRS = {6: [(18,19),(10,15),(8,7),(12,13),(5,3)], 7: [(21,22),(26,24),(32,28),(38,23),(27,36),(40,29),(33,31)]}
CLK = {6:(18,19), 7:(21,22)}
GPIO = set(hdr)
out=[]
for orient in 'AB':
  for r0 in range(1,14):
    m={}
    for i in range(8):
      r = r0+7-i if orient=='A' else r0+i
      ev, od = 2*r, 2*r-1
      if orient=='A': m[COLB[i]]=ev; m[0 if COLA[i] is None else COLA[i]]=od
      else: m[COLB[i]]=od; m[0 if COLA[i] is None else COLA[i]]=ev
    foot=set(m.values())
    best=None
    for bank in (6,7):
      others=[p for p in PAIRS[bank] if p!=CLK[bank]]
      for d0t,d1t in itertools.permutations(others,2):
        tg={'CK':CLK[bank],'D0':d0t,'D1':d1t}
        cost=0; jumped=set(); used=set()
        for nm,(p,n) in (('CK',(9,8)),('D0',(3,2)),('D1',(6,5))):
          a,b=tg[nm]; used|={a,b}
          # 极性可任选
          c1=(m[p]!=a)+(m[n]!=b); c2=(m[p]!=b)+(m[n]!=a)
          if c1<=c2: asg={p:a,n:b}
          else: asg={p:b,n:a}
          for k,h in asg.items():
            if m[k]!=h: cost+=1; jumped.add(k)
        # 目标脚若被别的转接板脚占着，该脚必须掰开
        occ={h:k for k,h in m.items()}
        pins_needed={}
        bent=set(jumped)
        for h in used:
          if h in occ and occ[h] not in (2,3,5,6,8,9): bent.add(occ[h])
          elif h in occ and occ[h] in (2,3,5,6,8,9):
            pass
        # 差分脚落在不属于自己的目标上已算进 jumped
        # SDA/SCL/IO0：需落在未被占用的 GPIO
        for k in (13,14,11):
          if k in bent or m[k] not in GPIO or m[k] in used: cost+=1; bent.add(k)
        # 3V3
        if POWER.get(m[15])!='3V3': cost+=1; bent.add(15)
        # 掰开 5V/错电源 上的脚（不计成本，但记录）
        gnd=[k for k in (1,4,7,10) if POWER.get(m[k])=='GND' and k not in bent]
        if not gnd: cost+=1
        for k,h in m.items():
          if POWER.get(h)=='5V': bent.add(k)
          if k in (1,4,7,10) and POWER.get(h)=='3V3': bent.add(k)
          if k==12 and (h not in GPIO or h in used): bent.add(k)
        # 被掰开的转接板脚留下的孔 + 足迹外的孔 足够做飞线目标？（粗查）
        sol=(cost,bank,tg,sorted(bent),gnd)
        if best is None or sol[0]<best[0]: best=sol
    out.append((best[0],orient,r0,best,m))
out.sort(key=lambda x:x[0])
for c,o,r0,b,m in out[:8]:
  print(c,o,'rows',r0,r0+7,'bank',b[1],b[2],'bent',b[3],'gnd',b[4])
