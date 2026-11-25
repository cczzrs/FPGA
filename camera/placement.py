"""穷举 FPC-15P 转接板插到 Icepi Zero 40 针排针上的所有位置并评分。"""
import json, re, sys, collections, os

R = os.environ.get('ICEPI_ZERO_DIR', '../icepi-zero')
lpf = open(f'{R}/gateware/v1.3/icepi-zero-v1_3.lpf').read()
iodb = json.load(open(os.path.expanduser('~/oss-cad-suite/share/trellis/database/ECP5/LFE5U-25F/iodb.json')))
meta = {(p['row'], p['col'], p['pio']): p for p in iodb['pio_metadata']}
pkg = iodb['packages']['CABGA256']

# 排针物理脚 -> (gpio 名, 球位, PIO 名, bank, 功能)
hdr = {}
for g, site, phys in re.findall(r'LOCATE COMP "(gpio\[\d+\])" SITE "(\w+)"; # (\d+)', lpf):
    v = pkg[site]; m = meta[(v['row'], v['col'], v['pio'])]
    side = 'PL' if v['col'] == 0 else 'PR' if v['col'] > 60 else 'PT' if v['row'] == 0 else 'PB'
    pio = f"{side}{v['row'] if side in ('PL','PR') else v['col']}{v['pio']}"
    hdr[int(phys)] = dict(gpio=g, site=site, pio=pio, bank=m['bank'], fn=m.get('function', ''))
POWER = {1: '3V3', 17: '3V3', 2: '5V', 4: '5V', 6: 'GND', 9: 'GND', 14: 'GND', 20: 'GND',
         25: 'GND', 30: 'GND', 34: 'GND', 39: 'GND'}

# 转接板（照片视角）：列 A 从上到下 None,1,3,...,13；列 B 从上到下 2,4,...,14,15
COLA = [None, 1, 3, 5, 7, 9, 11, 13]
COLB = [2, 4, 6, 8, 10, 12, 14, 15]
SIG = {1: 'GND', 2: 'D0_N', 3: 'D0_P', 4: 'GND', 5: 'D1_N', 6: 'D1_P', 7: 'GND', 8: 'CK_N',
       9: 'CK_P', 10: 'GND', 11: 'IO0', 12: 'IO1', 13: 'SCL', 14: 'SDA', 15: '3V3'}

def pair_ok(p, n):
    """P、N 是否落在同一 PIO 对上，且极性正确（P 在 A/C，N 在 B/D）。"""
    if p not in hdr or n not in hdr: return 'P/N 落在电源脚'
    a, b = hdr[p], hdr[n]
    base_a, base_b = a['pio'][:-1], b['pio'][:-1]
    la, lb = a['pio'][-1], b['pio'][-1]
    if base_a != base_b or {la, lb} not in ({'A', 'B'}, {'C', 'D'}):
        return f"不成对 {a['pio']}/{b['pio']}"
    if la in 'BD':
        return f"极性反 {a['pio']}/{b['pio']}"
    return 'OK'

results = []
for flip_r in (False, True):
    for a_odd in (True, False):
        for r0 in range(1, 14):
            m = {}       # FPC 脚 -> 排针脚
            for i in range(8):
                hrow = r0 + (7 - i if flip_r else i)
                odd, even = 2 * hrow - 1, 2 * hrow
                pa, pb = (odd, even) if a_odd else (even, odd)
                if COLA[i]: m[COLA[i]] = pa
                m[COLB[i]] = pb
                if COLA[i] is None: m[0] = pa    # 空孔
            issues, score = [], 0
            fivev = [k for k, h in m.items() if POWER.get(h) == '5V']
            if fivev: issues.append(f'有脚落在 5V：FPC {fivev}'); score -= 1000
            if POWER.get(m[15]) == '3V3': score += 50
            else: issues.append(f"3V3 落在排针 {m[15]}（{POWER.get(m[15], hdr.get(m[15], {}).get('gpio'))}）")
            gnd_ok = [k for k in (1, 4, 7, 10) if POWER.get(m[k]) == 'GND']
            score += 10 * len(gnd_ok)
            bad_pwr = [k for k in (1, 4, 7, 10) if POWER.get(m[k]) == '3V3']
            if bad_pwr: issues.append(f'GND 落在 3V3：FPC {bad_pwr}'); score -= 1000
            sig_on_pwr = [k for k in (2, 3, 5, 6, 8, 9, 11, 12, 13, 14) if m[k] in POWER]
            if sig_on_pwr: issues.append(f'信号落在电源脚：FPC {sig_on_pwr}'); score -= 300
            pr = {nm: pair_ok(m[p], m[n]) for nm, p, n in (('CK', 9, 8), ('D0', 3, 2), ('D1', 6, 5))}
            score += 100 * sum(v == 'OK' for v in pr.values())
            results.append((score, flip_r, a_odd, r0, m, issues, pr, gnd_ok))

results.sort(key=lambda x: -x[0])
for sc, fr, ao, r0, m, iss, pr, g in results[:8]:
    print(f'分数 {sc:5d} 行 {r0}-{r0+7} 列A={"奇" if ao else "偶"}列 {"倒置" if fr else "正向"} 差分 {pr} GND脚 {g} 问题 {iss}')
print('最佳插法的逐脚映射:')
sc, fr, ao, r0, m, iss, pr, g = results[0]
for k in range(0, 16):
    if k in m:
        h = m[k]
        print(f'  FPC {k:2d} {SIG.get(k, "(空孔)"):5s} -> 排针 {h:2d} ', POWER.get(h) or f"{hdr[h]['gpio']:9s} {hdr[h]['site']:4s} {hdr[h]['pio']:6s} bank{hdr[h]['bank']} {hdr[h]['fn']}")
print('差分对可满足的上限（任何插法）:', max(sum(v == 'OK' for v in r[6].values()) for r in results))
