"""OV9281 网页相机：串口与 Icepi Zero 通信，在浏览器里显示拍到的帧。

用法:
  python3 server.py --port /dev/cu.usbserial-实际编号 [--baud 2000000] [--http 8000]
然后打开 http://127.0.0.1:8000

只依赖 Python 标准库和 pyserial；两档曝光合成另需 numpy。
"""
import argparse, json, math, os, queue, re, struct, subprocess, threading, time, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---------------------------------------------------------------- 寄存器表
# 数据取自 Linux 内核 drivers/media/i2c/ov9282.c（GPL-2.0，支持 ovti,ov9281）的寄存器表。
COMMON = [
    (0x0302, 0x32), (0x030e, 0x02), (0x3001, 0x00), (0x3004, 0x00), (0x3005, 0x00), (0x3006, 0x04),
    (0x3011, 0x0a), (0x3013, 0x18), (0x301c, 0xf0), (0x3022, 0x01), (0x3030, 0x10), (0x3039, 0x32),
    (0x303a, 0x00), (0x3503, 0x08), (0x3505, 0x8c), (0x3507, 0x03), (0x3508, 0x00), (0x3610, 0x80),
    (0x3611, 0xa0), (0x3620, 0x6e), (0x3632, 0x56), (0x3633, 0x78), (0x3666, 0x00), (0x366f, 0x5a),
    (0x3680, 0x84), (0x3712, 0x80), (0x372d, 0x22), (0x3731, 0x80), (0x3732, 0x30), (0x377d, 0x22),
    (0x3788, 0x02), (0x3789, 0xa4), (0x378a, 0x00), (0x378b, 0x4a), (0x3799, 0x20), (0x3881, 0x42),
    (0x38a8, 0x02), (0x38a9, 0x80), (0x38b1, 0x00), (0x38c4, 0x00), (0x38c5, 0xc0), (0x38c6, 0x04),
    (0x38c7, 0x80), (0x3920, 0xff), (0x4010, 0x40), (0x4043, 0x40), (0x4307, 0x30), (0x4317, 0x00),
    (0x4501, 0x00), (0x450a, 0x08), (0x4601, 0x04), (0x470f, 0x00), (0x4f07, 0x00), (0x5000, 0x9f),
    (0x5001, 0x00), (0x5e00, 0x00), (0x5d00, 0x07), (0x5d01, 0x00), (0x0101, 0x01), (0x1000, 0x03),
    (0x5a08, 0x84),
]
# 位深：内核 ov9282.c 的 bitdepth_regs（PLL_CTRL_0D、ANA_CORE_2）。内核默认就是 RAW10。
BITDEPTH = {10: [(0x030d, 0x50), (0x3662, 0x05)], 8: [(0x030d, 0x60), (0x3662, 0x07)]}
RAW10_WC = {1600: 1280, 800: 640}             # RAW10 行字节数 -> 像素数（4 像素打包成 5 字节）
MODES = {
    '1280x800': dict(w=1280, h=800, hblank=176, regs=[
        (0x3778, 0x00), (0x3800, 0x00), (0x3801, 0x00), (0x3802, 0x00), (0x3803, 0x00), (0x3804, 0x05),
        (0x3805, 0x0f), (0x3806, 0x03), (0x3807, 0x2f), (0x3808, 0x05), (0x3809, 0x00), (0x380a, 0x03),
        (0x380b, 0x20), (0x3810, 0x00), (0x3811, 0x08), (0x3812, 0x00), (0x3813, 0x08), (0x3814, 0x11),
        (0x3815, 0x11), (0x3820, 0x40), (0x3821, 0x00), (0x4003, 0x40), (0x4008, 0x04), (0x4009, 0x0b),
        (0x400c, 0x00), (0x400d, 0x07), (0x4507, 0x00), (0x4509, 0x00)]),
    '640x400': dict(w=640, h=400, hblank=176, regs=[
        (0x3778, 0x10), (0x3800, 0x00), (0x3801, 0x00), (0x3802, 0x00), (0x3803, 0x00), (0x3804, 0x05),
        (0x3805, 0x0f), (0x3806, 0x03), (0x3807, 0x2f), (0x3808, 0x02), (0x3809, 0x80), (0x380a, 0x01),
        (0x380b, 0x90), (0x3810, 0x00), (0x3811, 0x04), (0x3812, 0x00), (0x3813, 0x04), (0x3814, 0x31),
        (0x3815, 0x22), (0x3820, 0x60), (0x3821, 0x01), (0x4008, 0x02), (0x4009, 0x05), (0x400c, 0x00),
        (0x400d, 0x03), (0x4507, 0x03), (0x4509, 0x80)]),
}
# 数据通道输入延时（DELAYF 级数，每级约 25 ps），按 0x0302 选。2026-11-23 本板实测：扫 0..127 级，
# 取每条通道 CRC 零错误窗口的中心（不加片上终端）。0 级离"采样太晚"的边只有约 4 级，会出位错。
# 默认行长 HTS：320 Mbps 下一行数据要发完（RAW10 每通道 800 字节约 21 us，RAW8 640 字节约 17 us），留约 2 us 余量。
# 实测每个 HTS 单位：RAW10 12.4 ns，RAW8 10.3 ns。HTS 太短传感器会丢行。
HTS_DEFAULT = {10: 1900, 8: 1800}
# 时序上限（内核 ov9282.c）：OV9282_TIMING_HTS_MAX = 0x7fff；1280x800 的 vblank_max = 51540，即 VTS 最大 800 + 51540。
# 曝光不超过 VTS - 25（内核同样的限制）。RAW10、HTS 32767 时一行约 406 us，最长曝光约 21 秒。
HTS_MAX, VTS_MAX = 0x7FFF, 800 + 51540
DELAYS = {0x14: (15, 20), 0x19: (15, 20), 0x1E: (7, 13)}   # 0x14：320 Mbps，延时 0～30 级抽测均 0 错
CHIP_ID = 0x9281
I2C_CANDIDATES = [0x60, 0x70, 0x10, 0x20, 0x36, 0x30]


def png_gray(w, h, data, bits=8, sbit=10):
    """灰度 PNG。bits=8：每像素 1 字节。bits=16：每像素 2 字节（大端），sbit 不为 None 时写 sBIT 表示有效位数。"""
    bpr = w * (2 if bits == 16 else 1)
    raw = b''.join(b'\x00' + data[y * bpr:(y + 1) * bpr] for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, bits, 0, 0, 0, 0)) +
            (chunk(b'sBIT', bytes([sbit])) if bits == 16 and sbit else b'') +
            chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


# RAW10 打包（CSI-2）：每 5 字节 = 4 个像素的高 8 位 + 1 字节低 2 位（像素 k 在 bit 2k+1:2k）。
# 解成 16 位大端：值左移 6 位（10 位值放在高位，低 6 位为 0，可无损还原：>>6）。
_LSB = [bytes(((x >> (2 * k)) & 3) << 6 for x in range(256)) for k in range(4)]
def unpack_raw10(row):
    n = len(row) // 5
    out = bytearray(n * 8)
    lsb = row[4::5]
    for k in range(4):
        out[2 * k::8] = row[k::5]
        out[2 * k + 1::8] = lsb.translate(_LSB[k])
    return out


_CRC_T = []
for _b in range(256):
    _c = _b
    for _ in range(8):
        _c = (_c >> 1) ^ 0x8408 if _c & 1 else _c >> 1
    _CRC_T.append(_c)
def crc16(data):
    """CSI-2 长包 CRC：多项式 0x8408（反射），初值 0xFFFF，字节低位先算。"""
    c = 0xFFFF
    for x in data:
        c = (c >> 8) ^ _CRC_T[(c ^ x) & 0xFF]
    return c


def tiff_f32(fn, w, h, data):
    """写单通道 32 位浮点 TIFF（小端、不压缩、一条带）：文件头 8 字节 + IFD + 像素。"""
    tags = [(256, 4, w), (257, 4, h), (258, 3, 32), (259, 3, 1), (262, 3, 1), (273, 4, 0), (277, 3, 1),
            (278, 4, h), (279, 4, w * h * 4), (339, 3, 3)]
    off = 8 + 2 + 12 * len(tags) + 4
    ifd = struct.pack('<H', len(tags)) + b''.join(
        struct.pack('<HHI', t, ty, 1) + (struct.pack('<I', off if t == 273 else v) if ty == 4 else struct.pack('<HH', v, 0))
        for t, ty, v in tags) + struct.pack('<I', 0)
    with open(fn, 'wb') as f:
        f.write(b'II*\x00' + struct.pack('<I', 8) + ifd + data)


def tiff_f32_read(fn):
    """读 tiff_f32 写的文件，返回 (宽, 高, 小端 float32 像素字节)。"""
    d = open(fn, 'rb').read()
    n = struct.unpack('<H', d[8:10])[0]; tag = {}
    for i in range(n):
        t, ty, _, v = struct.unpack('<HHII', d[10 + 12 * i:22 + 12 * i])
        tag[t] = v & 0xFFFF if ty == 3 else v
    w, h, off = tag[256], tag[257], tag[273]
    return w, h, d[off:off + w * h * 4]


def png_samples(fn):
    """读本程序写的 PNG（每行滤波 0），返回 (宽, 高, 位深, 原始采样字节)。"""
    d = open(fn, 'rb').read(); i = 8; idat = b''
    while i < len(d):
        n = struct.unpack('>I', d[i:i + 4])[0]; t = d[i + 4:i + 8]
        if t == b'IHDR': w, h, bits = struct.unpack('>IIB', d[i + 8:i + 17])
        if t == b'IDAT': idat += d[i + 8:i + 8 + n]
        i += 12 + n
    r = zlib.decompress(idat); bpr = w * bits // 8
    return w, h, bits, b''.join(r[y * (bpr + 1) + 1:(y + 1) * (bpr + 1)] for y in range(h))


class Board:
    """与 FPGA 的串口协议：主机发 A5 cmd a b c；FPGA 回 5A type len[3] payload chk。"""

    def __init__(self, port, baud):
        self.port, self.baud = port, baud
        self.ser = None
        self.lock = threading.Lock()
        self.resp = queue.Queue()
        self.state = dict(connected=False, frame_id=0, shots=[], status=None, chip=None,
                          i2c_addr=None, events=[], log=[], busy=False, mode='1280x800')
        self.frame_png = b''
        self.shot = None              # 正在接收的这一次拍摄
        self.pending = None           # 已触发、还没收到帧头的拍摄：(来源, 帧数, 触发时刻)
        self.rsel = 5                 # SDRAM 读出采样点（opts 位 7:5），自检后更新
        self.stop = False
        self.reader = None
        self.saveq = queue.Queue()    # PNG 压缩和存盘放在单独线程，串口接收线程不能停（否则驱动缓冲溢出丢字节）
        threading.Thread(target=self._save_loop, daemon=True).start()

    def log(self, msg):
        line = time.strftime('%H:%M:%S ') + msg
        print(line, flush=True)
        self.state['log'] = (self.state['log'] + [line])[-200:]

    # ------------------------------------------------ 串口
    def open(self):
        import serial
        self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
        self.ser.reset_input_buffer()
        self.stop = False
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()
        self.state['connected'] = True
        self.log(f'已打开 {self.port} @ {self.baud}')

    def close(self):
        self.stop = True
        if self.reader:
            self.reader.join(timeout=1)
        if self.ser:
            self.ser.close()
        self.ser = None
        self.state['connected'] = False

    def _read_loop(self):
        buf = bytearray()
        while not self.stop:
            try:
                d = self.ser.read(65536)
            except Exception as e:
                self.log(f'串口读错误：{e}')
                self.state['connected'] = False
                return
            if d:
                buf += d
            while True:
                i = buf.find(b'\x5a')
                if i < 0:
                    buf.clear(); break
                if i:
                    del buf[:i]
                if len(buf) < 5:
                    break
                ty = chr(buf[1]); n = (buf[2] << 16) | (buf[3] << 8) | buf[4]
                if n > 70000:
                    del buf[:1]; continue
                if len(buf) < 6 + n:
                    break
                payload = bytes(buf[5:5 + n]); chk = buf[5 + n]
                del buf[:6 + n]
                x = 0
                for b in payload:
                    x ^= b
                if x != chk:
                    self.log(f'包 {ty} 校验错，丢弃'); continue
                self._dispatch(ty, payload)

    # 一次拍摄的包序列：G {帧数, 宽, 溢出, 采集总用时 us} -> 每帧 F {序号, 行数, 开始 us, 写完 us}
    #   -> 每行 L {帧序号, 行号, 像素}。时间都相对 FPGA 收到触发的时刻。
    def _dispatch(self, ty, p):
        if ty == 'G':
            src, n_req, t_trig = self.pending or ('网页', p[0], time.time())
            self.pending = None
            sid = self.state['shots'][-1]['id'] + 1 if self.state['shots'] else 1
            hd, self.hdr_req = getattr(self, 'hdr_req', None), None
            ex, self.exp_req = getattr(self, 'exp_req', None), None
            self.shot = dict(id=sid, src=src, n=p[0], w=(p[1] << 8) | p[2], ovf=bool(p[3]),
                             cap_us=int.from_bytes(p[4:8], 'big'), t_trig=t_trig, t_hdr=time.time(),
                             time=time.strftime('%Y-%m-%d %H:%M:%S'), frames=[], bufs=[], cur=0, t_last=time.time(), hdr=hd, exp=ex)
            self.state['progress'] = [0, 0]
            self.log(f'第 {sid} 次拍摄（{src}）：FPGA 已把 {p[0]} 帧存进 SDRAM，采集用时 {self.shot["cap_us"] / 1000:.1f} ms'
                     + ('，SDRAM 写溢出（有像素丢失）' if p[3] else '') + '，开始逐行传回')
            if p[0] == 0 or self.shot['w'] == 0:
                self.state['busy'] = False; self.shot = None
        elif ty == 'F':
            s = self.shot
            if s is None:
                return
            h = (p[1] << 8) | p[2]
            s['frames'].append(dict(i=p[0], h=h, ts_us=int.from_bytes(p[3:7], 'big'), te_us=int.from_bytes(p[7:11], 'big'),
                                    xfer_s=None, missing=None, file=None))
            s['bufs'].append((bytearray(s['w'] * h), set(), [None] * h))
            self.state['progress'] = [0, sum(f['h'] for f in s['frames'])]
            self._publish()
        elif ty == 'L':
            s = self.shot
            if s is None:
                return
            fi, ln, row = p[0], (p[1] << 8) | p[2], p[3:]
            while s['cur'] < fi and s['cur'] < len(s['frames']):       # 上一帧的末行丢了：到这里收尾
                self._finish_frame()
            if fi >= len(s['frames']):
                return
            f = s['frames'][fi]; buf, got, crcs = s['bufs'][fi]
            if ln < f['h'] and len(row) == s['w'] + 2:          # 像素 + FPGA 收到的 2 字节 CRC（低字节在前）
                buf[ln * s['w']:(ln + 1) * s['w']] = row[:-2]
                crcs[ln] = row[-2] | (row[-1] << 8)
                if ln not in got:
                    got.add(ln); self.state['progress'][0] += 1
            if ln == f['h'] - 1:
                self._finish_frame()
        elif ty == 'b':
            self.state['busy'] = True
            self.pending = (f'按键 {p[0]}（{"单拍" if p[0] == 0 else "连拍"}）', p[1], time.time())
            self.log(f'板上按键 {p[0]}：开始{"单拍 1 帧" if p[1] == 1 else f"连拍 {p[1]} 帧"}')
        elif ty == 'E':
            self.state['busy'] = False; self.pending = None
            self.log('拍摄超时：25 秒内没抓到完整帧（先看状态里的 MIPI 时钟和 FS/FE 计数）')
        else:
            self.resp.put((ty, p))

    def _publish(self, s=None):
        """把一次拍摄放进 state['shots']（只放可 JSON 化的部分）。"""
        s = s or self.shot
        pub = {k: v for k, v in s.items() if k not in ('bufs', 't_last', '_raw')}
        shots = self.state['shots']
        k = next((j for j, x in enumerate(shots) if x['id'] == s['id']), None)
        if k is not None:
            shots[k] = pub
        else:
            self.state['shots'] = (shots + [pub])[-30:]

    def _save_loop(self):
        while True:
            s, i, buf, crcs = self.saveq.get()
            f = s['frames'][i]
            # 逐行重算 CSI-2 CRC，和相机发来的比：覆盖 MIPI、FPGA、SDRAM、串口全程
            bad = [(y, c, k) for y in range(f['h']) if (c := crcs[y]) is not None
                   and c != (k := crc16(buf[y * s['w']:(y + 1) * s['w']]))]
            f['crc_bad'] = len(bad); f['crc_bad_lines'] = bad[:50]
            pw = RAW10_WC.get(s['w'])
            if pw:                                      # RAW10：解包成 16 位
                bpr = s['w']
                data = b''.join(unpack_raw10(buf[y * bpr:(y + 1) * bpr]) for y in range(f['h']))
                self.frame_png = png_gray(pw, f['h'], data, 16); fmt = 'RAW10'
                if s.get('hdr'): s.setdefault('_raw', {})[i] = (pw, f['h'], data)
            else:
                pw = s['w']; self.frame_png = png_gray(pw, f['h'], bytes(buf)); fmt = 'RAW8'
            os.makedirs(os.path.join(ROOT, 'captures'), exist_ok=True)
            name = time.strftime('%Y%m%d_%H%M%S') + f'_s{s["id"]}_f{i:02d}_{pw}x{f["h"]}_{fmt}.png'
            with open(os.path.join(ROOT, 'captures', name), 'wb') as fp:
                fp.write(self.frame_png)
            f['file'] = 'captures/' + name
            self.state['frame_id'] += 1
            self.log(f'第 {s["id"]} 次第 {i} 帧：{pw}×{f["h"]} 原始 {fmt}，传回 {f["xfer_s"]:.2f} 秒'
                     + (f'，缺 {f["missing"]} 行（补 0）' if f['missing'] else '，完整')
                     + (f'，CRC 不符 {len(bad)} 行：{[y for y, _, _ in bad[:10]]}' if bad else '，每行 CRC 都对')
                     + f'，已保存 {f["file"]}')
            if s.get('hdr') and len(s.get('_raw', {})) == 2:
                try:
                    self._merge_hdr(s)
                except Exception as e:
                    self.log(f'两档曝光合成失败：{e}')
            if f is s['frames'][-1] and s.get('total_s') is not None:
                self.state['busy'] = False
            self._publish(s)

    def _merge_hdr(self, s):
        """两档曝光合成。帧 0 = 长曝光 L，帧 1 = 短曝光 S（都是 10 位原始值）。
        1. 曝光比 a、黑电平 b：用两帧都可靠的像素（L 在 200..850 且 S 明显高于暗处）拟合 S = L / a + c，
           b = c / (1 - 1/a)。S 对 L 回归：L 噪声相对小。拟合像素少于 2000、名义比大于 81（短曝光在 L 的 200..850 段
           变化不足 8 级）、或拟合值与名义比相差超过 20% 时，改用寄存器算出的名义比，黑电平取 L < 300 处 S 的中位数。
        2. 线性值：L 未接近饱和处用 L - b；L ≥ 950 处用 (S - b) * a；800..950 之间按 L 线性过渡。
        3. 存 32 位浮点 TIFF（_HDR.tif），不缩放，暗部精度不丢。"""
        import numpy as np
        (w, h, dl), (_, _, ds) = s['_raw'][0], s['_raw'][1]
        L = (np.frombuffer(dl, '>u2').reshape(h, w) >> 6).astype(np.float64)
        S = (np.frombuffer(ds, '>u2').reshape(h, w) >> 6).astype(np.float64)
        hd = s['hdr']; nominal = hd['nominal']
        dark = S[L < 300]
        b_dark = float(np.median(dark)) if dark.size >= 1000 else 64.0
        m = (L >= 200) & (L <= 850)                         # 只按 L 选：按 S 选会把噪声截断，斜率偏
        n = int(m.sum()); a = None
        if n >= 2000 and 650 / nominal >= 8:               # 短曝光在这段里至少要有 8 级变化，斜率才测得准
            k, c = np.polyfit(L[m], S[m], 1)
            if k > 0 and abs(1 / k / nominal - 1) < 0.2:
                a = 1 / k; b = c / (1 - k)
                resid = float(np.std(S[m] - (k * L[m] + c)))
                how = f'拟合 {n} 个像素：曝光比 {a:.1f}（寄存器算出 {nominal:.1f}），黑电平 {b:.1f}，残差 {resid:.2f}'
        if a is None:
            a, b = nominal, b_dark
            how = (f'可用于拟合的像素 {n} 个，拟合不可靠，曝光比用寄存器算出的 {nominal:.1f}，'
                   f'黑电平取长曝光暗处对应的短曝光中位数 {b:.1f}')
        wgt = np.clip((L - 800) / 150, 0, 1)
        lin = np.clip((1 - wgt) * (L - b) + wgt * (S - b) * a, 0, None).astype('<f4')
        name = os.path.basename(s['frames'][0]['file']).replace('_f00_', '_hdr_').replace('_RAW10.png', '_HDR.tif')
        tiff_f32(os.path.join(ROOT, 'captures', name), w, h, lin.tobytes())
        sat_l = int((L >= 1023).sum()); sat_s = int((S >= 1023).sum())
        s['merged'] = dict(file='captures/' + name, ratio=round(float(a), 2), nominal=round(nominal, 2), black=round(float(b), 1),
                           max=round(float(lin.max()), 1), sat_long=sat_l, sat_short=sat_s)
        self.log(f'第 {s["id"]} 次两档曝光合成：{how}；长曝光饱和 {sat_l} 像素，短曝光饱和 {sat_s} 像素；'
                 f'合成值 0～{float(lin.max()):.0f}（32 位浮点），已保存 captures/{name}')
        self.state['frame_id'] += 1                       # 让网页知道有新图

    def _finish_frame(self):
        s = self.shot
        i = s['cur']; f = s['frames'][i]; buf, got, crcs = s['bufs'][i]
        now = time.time()
        f['xfer_s'] = round(now - s['t_last'], 3); s['t_last'] = now
        f['missing'] = f['h'] - len(got)
        s['bufs'][i] = None
        s['cur'] += 1
        if s['cur'] == len(s['frames']):
            s['xfer_s'] = round(now - s['t_hdr'], 3)
            s['total_s'] = round(now - s['t_trig'], 3)
            self.log(f'第 {s["id"]} 次拍摄完成：{len(s["frames"])} 帧，采集 {s["cap_us"] / 1000:.1f} ms，'
                     f'传回 {s["xfer_s"]:.1f} 秒，从触发到收完共 {s["total_s"]:.1f} 秒')
        self.saveq.put((s, i, buf, crcs))          # 统计先算完再交给存盘线程
        self._publish(s)
        if s['cur'] == len(s['frames']):
            self.shot = None

    def cmd(self, c, a=0, b=0, cc=0, expect=None, timeout=1.0):
        with self.lock:
            while not self.resp.empty():
                self.resp.get_nowait()
            self.ser.write(bytes([0xA5, ord(c), a & 0xff, b & 0xff, cc & 0xff]))
            t0 = time.time()
            while time.time() - t0 < timeout:
                try:
                    ty, p = self.resp.get(timeout=0.05)
                except queue.Empty:
                    continue
                if expect is None or ty == expect:
                    return ty, p
            raise TimeoutError(f'命令 {c} 超时')

    # ------------------------------------------------ 高层操作
    def ping(self):
        ty, p = self.cmd('V', expect='v')
        return p.decode('ascii', 'replace')

    def i2c_w(self, reg, val):
        ty, p = self.cmd('W', reg >> 8, reg, val, expect='w')
        return p[0] == 0x0F

    def i2c_r(self, reg):
        ty, p = self.cmd('R', reg >> 8, reg, 0, expect='r')
        return p[0] == 0x0F, p[1]

    def set_addr(self, a):
        self.cmd('D', a, expect='d')
        self.state['i2c_addr'] = a

    def status(self):
        ty, p = self.cmd('S', expect='s')
        v = struct.unpack('>14I', p)
        flags = v[7]
        st = dict(sclk_khz=v[0], mipi_mbps_per_lane=round(v[0] * 4 / 1000, 1), fs=v[1], fe=v[2], ls=v[3],
                  ecc_err=v[4], last_dt_other=(v[5] >> 16) & 0xff, last_wc=v[5] & 0xffff, last_lines=v[6] & 0xffff,
                  opts=(flags >> 24) & 0xff, lane0_locked=bool(flags & 0x10000), lane1_locked=bool(flags & 0x20000),
                  fifo_overflow=bool(flags & 0x40000), armed=bool(flags & 0x80000), sdram_overflow=bool(flags & 0x200000),
                  i2c_addr=(flags >> 8) & 0xff, io0=bool(flags & 1), io1=bool(flags & 2),
                  hsum=v[8], magic=f'{v[9]:08X}', frames=v[10], last_hdr=f'{v[11]:08X}',
                  crc_err=v[12], delay0=v[13] >> 24, delay1=(v[13] >> 16) & 0xff)
        self.state['status'] = st
        return st

    def set_delay(self, d0, d1):
        """两条数据通道的输入延时级数（0..127，ECP5 DELAYF）。"""
        ty, p = self.cmd('Y', d0, d1, expect='y')
        return dict(delay0=p[0], delay1=p[1])

    def power(self, io0, io1=0):
        self.cmd('P', (1 if io0 else 0) | (2 if io1 else 0), expect='p')

    def set_opts(self, v):
        """低 5 位是 MIPI 解码选项；高 3 位固定用当前的 SDRAM 采样点。"""
        self.cmd('O', (v & 0x1F) | (self.rsel << 5), expect='o')

    # 采样点按时间排序（单位：读命令后的时钟拍数）
    RSEL_TIME = {4: 3.5, 0: 4, 5: 4.5, 1: 5, 6: 5.5, 2: 6, 7: 6.5, 3: 7}

    def sdram_test(self):
        """写 512 个字再读回，8 种采样点各数一遍错误；选全对区间的正中间。"""
        ty, p = self.cmd('T', expect='t', timeout=2.0)
        errs = [(p[2 * k] << 8) | p[2 * k + 1] for k in range(8)]
        good = sorted((t, k) for k, t in self.RSEL_TIME.items() if errs[k] == 0)
        txt = '，'.join(f'{self.RSEL_TIME[k]} 拍:{errs[k]}' for k in sorted(self.RSEL_TIME, key=self.RSEL_TIME.get))
        if good:
            self.rsel = good[len(good) // 2][1]
            st = self.status()
            self.set_opts(st['opts'])
            self.log(f'SDRAM 自检（每个采样点读 512 字的错误数）：{txt}；选用 {self.RSEL_TIME[self.rsel]} 拍')
        else:
            self.log(f'SDRAM 自检失败，所有采样点都有错：{txt}')
        self.state['sdram'] = dict(errs=errs, rsel=self.rsel if good else None)
        return self.state['sdram']

    def find_camera(self):
        for a in I2C_CANDIDATES:
            self.set_addr(a)
            ok1, hi = self.i2c_r(0x300A)
            ok2, lo = self.i2c_r(0x300B)
            if ok1 and ok2:
                cid = (hi << 8) | lo
                self.log(f'I2C 地址 0x{a:02X} 有应答，芯片 ID = 0x{cid:04X}')
                if cid == CHIP_ID:
                    self.state['chip'] = f'OV9281 (0x{cid:04X})'
                    return a
        self.state['chip'] = None
        return None

    def write_list(self, regs, name):
        bad = [r for r, v in regs if not self.i2c_w(r, v)]
        self.log(f'{name}：写 {len(regs)} 个寄存器，失败 {len(bad)} 个' + (f'：{[hex(r) for r in bad[:8]]}' if bad else ''))
        return not bad

    def init_camera(self, mode='1280x800', exposure=0x282, gain=0x10, hts=None, pll=0x14, bits=10):
        """pll：0x0302（MIPI PLL 倍频）。内核默认 0x32 对应每通道 800 Mbps；
        这里默认减半为 0x19，目标约 400 Mbps（按比例推断，未查到数据手册核实）。
        hts：行长寄存器 0x380C/D；MIPI 变慢后需加长，默认 1600（内核约 728）。"""
        m = MODES[mode]
        self.state['mode'] = mode; self.state['bits'] = bits
        self.power(1); time.sleep(0.05)
        a = self.find_camera()
        if a is None:
            self.log('没找到 OV9281：检查 3.3V/GND、SDA(排针16)/SCL(排针13) 接线、IO0(排针15) 供电使能，'
                     '以及 I2C 上拉（板上没有，FPGA 只有内部弱上拉）')
            return False
        self.i2c_w(0x0103, 0x01); time.sleep(0.02)            # 软复位
        self.i2c_w(0x0100, 0x00)                               # 待机
        self.i2c_w(0x4800, 0x00)                               # 连续 MIPI 时钟（接收端需要）
        ok = self.write_list([(r, pll if r == 0x0302 else v) for r, v in COMMON], f'通用寄存器（0x0302=0x{pll:02X}）')
        ok &= self.write_list(BITDEPTH[bits], f'RAW{bits} 输出')
        ok &= self.write_list(m['regs'], f'{mode} 模式')
        hts = hts or HTS_DEFAULT[bits]
        lpfr = 1022 + m['h'] if mode == '1280x800' else 1022 + 400
        e = exposure << 4
        ok &= self.write_list([(0x380c, hts >> 8), (0x380d, hts & 0xff), (0x380e, lpfr >> 8), (0x380f, lpfr & 0xff),
                               (0x3500, (e >> 16) & 0xff), (0x3501, (e >> 8) & 0xff), (0x3502, e & 0xff),
                               (0x3509, gain & 0xff)], f'HTS={hts} LPFR={lpfr} 曝光={exposure} 增益={gain}')
        d0, d1 = DELAYS.get(pll, DELAYS[0x19])
        self.set_delay(d0, d1)
        self.log(f'数据通道输入延时：D0 {d0} 级，D1 {d1} 级（0x0302=0x{pll:02X} 的实测窗口中心）')
        self.i2c_w(0x0100, 0x01)                               # 开始输出
        time.sleep(0.2)
        st = self.status()
        self.log(f'相机已启动：MIPI 时钟 {st["sclk_khz"] * 2 / 1000:.1f} MHz（每通道 {st["mipi_mbps_per_lane"]} Mbps），'
                 f'FS={st["fs"]} FE={st["fe"]} 行包={st["ls"]} ECC 错={st["ecc_err"]} CRC 错={st["crc_err"]}')
        return ok

    def set_exposure(self, exposure, gain):
        e = exposure << 4
        return self.write_list([(0x3500, (e >> 16) & 0xff), (0x3501, (e >> 8) & 0xff), (0x3502, e & 0xff),
                                (0x3509, gain & 0xff)], f'曝光={exposure} 增益={gain}')

    def capture(self, n=1):
        if self.state.get('sdram') is None:
            self.sdram_test()
        self.state['busy'] = True
        n = max(1, min(20, n))
        self.pending = ('网页' + ('单拍' if n == 1 else '连拍'), n, time.time())   # 帧头可能比应答先被处理，先记下
        self.log(f'网页触发：{"单拍 1 帧" if n == 1 else f"连拍 {n} 帧"}（全分辨率原始数据）')
        ty, p = self.cmd('G', n, expect='g')

    def line_time(self):
        """实测一行的时间（秒）：1 秒内的帧数 × VTS。"""
        a = self.status(); time.sleep(1.0); b = self.status()
        fps = (b['fs'] - a['fs']) / 1.0
        ok1, hi = self.i2c_r(0x380E); ok2, lo = self.i2c_r(0x380F)
        if fps <= 0 or not (ok1 and ok2):
            raise RuntimeError('测不出行时间：相机没有在输出帧')
        return 1 / (fps * ((hi << 8) | lo)), (hi << 8) | lo

    def _timing(self):
        """读当前 HTS、VTS、曝光行数、增益。"""
        r = {a: self.i2c_r(a)[1] for a in (0x380C, 0x380D, 0x380E, 0x380F, 0x3500, 0x3501, 0x3502, 0x3509)}
        return ((r[0x380C] << 8) | r[0x380D], (r[0x380E] << 8) | r[0x380F],
                ((r[0x3500] << 16) | (r[0x3501] << 8) | r[0x3502]) >> 4, r[0x3509])

    def _set_timing(self, hts, vts, e, gain, name):
        e <<= 4
        return self.write_list([(0x380c, hts >> 8), (0x380d, hts & 0xff), (0x380e, vts >> 8), (0x380f, vts & 0xff),
                                (0x3500, (e >> 16) & 0xff), (0x3501, (e >> 8) & 0xff), (0x3502, e & 0xff),
                                (0x3509, gain & 0xff)], name)

    def _wait_frames(self, n, timeout):
        """等相机再输出 n 帧（看 FPGA 的帧开始计数），确保新设置已经生效。"""
        a = self.status()['fs']; t = time.time()
        while time.time() - t < timeout:
            time.sleep(0.1)
            if self.status()['fs'] - a >= n:
                return
        raise RuntimeError(f'{timeout:.0f} 秒内没等到 {n} 帧，相机可能停止输出')

    @staticmethod
    def _exp_timing(ms, tline, hts0, vts0):
        """曝光 ms 毫秒所需的时序：先加大 VTS（帧长），VTS 到上限还不够再加大 HTS（行长）。
        返回 (HTS, VTS, 曝光行数, 一行的时间 秒)。曝光至少 1 行。"""
        unit = tline / hts0                                # 每个 HTS 单位的时间（秒）
        T = ms / 1000
        hts = max(hts0, math.ceil(T / unit / (VTS_MAX - 25)))
        if hts > HTS_MAX:
            raise ValueError(f'曝光 {ms} ms 超出传感器能力（HTS、VTS 都到上限）')
        tl = unit * hts
        e = max(1, round(T / tl))
        return hts, max(vts0, e + 25), e, tl

    def shot_ms(self, ms, tag):
        """按指定曝光（毫秒）抓 1 帧存进槽 0 再传回；时序按需自动调整（同两档曝光的长曝光），抓完恢复。"""
        ms = min(max(ms, 0.0), 10000.0)
        if self.state.get('sdram') is None:
            self.sdram_test()
        hts0, vts0, e0, gain = self._timing()
        c = getattr(self, '_tl_cache', None)              # 一行的时间：同一 HTS/VTS 下 10 分钟内复用（实测要 1 秒；连续拍多帧时各帧换算一致）
        if c and c[0] == (hts0, vts0) and time.time() - c[2] < 600:
            tline = c[1]
        else:
            tline, _ = self.line_time(); self._tl_cache = ((hts0, vts0), tline, time.time())
        hts, vts, e, tl = self._exp_timing(ms, tline, hts0, vts0)
        f_n, f_0 = vts * tl, vts0 * tline
        real = e * tl * 1e3
        self.log(f'{tag}：曝光 {ms:g} ms → HTS {hts}，VTS {vts}，{e} 行（实际 {real:.4f} ms）')
        self.state['busy'] = True
        t0 = time.time()
        try:
            self._set_timing(hts, vts, e, gain, f'{tag} 时序')
            self._wait_frames(2, f_0 + 2 * f_n + 3)
            self.cmd('G', 1, 1, 0, expect='h', timeout=2 * f_n + 5)
        except Exception:
            self.state['busy'] = False
            raise
        finally:
            self._set_timing(hts0, vts0, e0, gain, '恢复原时序和曝光')
        self.exp_req = dict(ms=round(real, 4), req_ms=ms, lines=e, hts=hts, vts=vts, tag=tag)
        self.pending = (tag, 1, t0)
        with self.lock:
            self.ser.write(bytes([0xA5, ord('X'), 0, 1, 0]))
        return dict(ms=real, lines=e)

    def hdr(self, long_ms, short_ms):
        """两档曝光：长曝光帧存进槽 0、短曝光帧存进槽 1（只抓不传），再一起传回，收完后合成。
        长曝光超过当前帧长允许的值时，先加大 VTS（帧长），VTS 到上限还不够再加大 HTS（行长），
        改完等 2 帧让新设置生效再抓；短曝光帧用原来的时序；最后恢复原来的 HTS、VTS、曝光。"""
        long_ms = min(max(long_ms, 0.05), 10000.0)
        if self.state.get('sdram') is None:
            self.sdram_test()
        tline, _ = self.line_time()
        hts0, vts0, e0, gain = self._timing()
        hts_l, vts_l, el, tl_l = self._exp_timing(long_ms, tline, hts0, vts0)
        es = max(1, min(vts0 - 25, round(short_ms / 1000 / tline)))
        f_l, f_0 = vts_l * tl_l, vts0 * tline              # 长曝光帧、正常帧的帧周期
        self.log(f'两档曝光准备：长 {long_ms} ms → HTS {hts0}→{hts_l}，VTS {vts0}→{vts_l}，曝光 {el} 行（{el * tl_l * 1e3:.2f} ms），'
                 f'帧周期 {f_l:.2f} 秒；短 {es} 行（{es * tline * 1e3:.3f} ms）')
        self.state['busy'] = True
        t0 = time.time()
        try:
            self._set_timing(hts_l, vts_l, el, gain, '长曝光时序')
            self._wait_frames(2, f_0 + 2 * f_l + 3)
            self.cmd('G', 1, 1, 0, expect='h', timeout=2 * f_l + 5)
            t1 = time.time()
            self._set_timing(hts0, vts0, es, gain, '短曝光时序')
            self._wait_frames(2, f_l + 2 * f_0 + 3)
            self.cmd('G', 1, 1, 1, expect='h', timeout=2 * f_0 + 5)
            gap = time.time() - t1
        except Exception:
            self.state['busy'] = False
            raise
        finally:
            self._set_timing(hts0, vts0, e0, gain, '恢复原时序和曝光')
        nominal = (el * tl_l) / (es * tline)
        self.log(f'两档曝光：两帧都已存进 SDRAM（共 {time.time() - t0:.1f} 秒，长短两帧相隔约 {gap:.1f} 秒），开始传回')
        self.hdr_req = dict(long=el, short=es, long_ms=round(el * tl_l * 1e3, 3), short_ms=round(es * tline * 1e3, 3),
                            nominal=nominal, hts=hts_l, vts=vts_l)
        self.pending = ('两档曝光', 2, t0)
        with self.lock:
            self.ser.write(bytes([0xA5, ord('X'), 0, 2, 0]))

    def program(self, bit):
        self.close()
        self.log(f'烧录 SRAM：{os.path.relpath(bit, ROOT)}')
        r = subprocess.run(['openFPGALoader', '-b', 'icepi-zero', bit], capture_output=True, text=True,
                           env=dict(os.environ, PATH=os.path.expanduser('~/oss-cad-suite/bin') + ':' + os.environ['PATH']))
        self.log('烧录' + ('成功' if r.returncode == 0 else f'失败：{r.stderr[-300:]}'))
        self.state['sdram'] = None; self.rsel = 5       # 新比特流要重新自检
        time.sleep(0.5)
        self.open()
        return r.returncode == 0


def make_handler(board):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body, ctype):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/' or self.path.startswith('/index.html'):
                with open(os.path.join(HERE, 'index.html'), 'rb') as f:
                    self.send(200, f.read(), 'text/html; charset=utf-8')
            elif self.path.startswith('/api/state'):
                self.send(200, json.dumps(board.state, ensure_ascii=False).encode(), 'application/json')
            elif re.match(r'/api/(hd|chdr)\b', self.path):    # 会话：/api/<种类> 列表（新的在前），/api/<种类>/<编号> 内容
                m = re.fullmatch(r'/api/(hd|chdr)(?:/(\d{8}_\d{6}))?', self.path.split('?')[0].rstrip('/'))
                d = os.path.join(ROOT, 'captures')
                if not m:
                    self.send(404, b'not found', 'text/plain')
                elif m[2]:
                    fn = os.path.join(d, f'{m[1]}_{m[2]}.json')
                    if os.path.isfile(fn):
                        with open(fn, 'rb') as f:
                            self.send(200, f.read(), 'application/json')
                    else:
                        self.send(404, b'not found', 'text/plain')
                else:
                    ls = []
                    for n in sorted((n for n in os.listdir(d) if re.fullmatch(m[1] + r'_\d{8}_\d{6}\.json', n)), reverse=True) if os.path.isdir(d) else []:
                        with open(os.path.join(d, n), encoding='utf-8') as f:
                            x = json.load(f)
                        ls.append(dict(id=x['id'], nbk=len(x.get('bk', [])), nf=len(x.get('frames', [])), bbb=x.get('bbb', 0),
                                       done=x.get('done', False), dr=(x.get('stats') or {}).get('dr')))
                    self.send(200, json.dumps(ls, ensure_ascii=False).encode(), 'application/json')
            elif self.path.startswith('/api/captures'):     # 历史图像列表：captures/ 里的 png、tif，新的在前
                d = os.path.join(ROOT, 'captures')
                fs = [dict(name=n, size=os.path.getsize(os.path.join(d, n)), mtime=os.path.getmtime(os.path.join(d, n)))
                      for n in (os.listdir(d) if os.path.isdir(d) else []) if n.endswith(('.png', '.tif'))]
                fs.sort(key=lambda f: f['mtime'], reverse=True)
                self.send(200, json.dumps(fs, ensure_ascii=False).encode(), 'application/json')
            elif self.path.startswith('/frame.png'):
                self.send(200 if board.frame_png else 404, board.frame_png or b'', 'image/png')
            elif self.path.startswith('/raw/'):              # 原始采样值（网页按 10 位精度显示用）
                name = os.path.basename(self.path.split('?')[0]); fn = os.path.join(ROOT, 'captures', name)
                if name.endswith(('.png', '.tif')) and os.path.isfile(fn):
                    if name.endswith('.tif'):
                        (w, h, data), bits, kind = tiff_f32_read(fn), 32, 'hdr'   # 合成图：小端 float32
                    else:
                        (w, h, bits, data), kind = png_samples(fn), 'raw'
                    self.send_response(200)
                    for k, v in (('Content-Type', 'application/octet-stream'), ('X-W', w), ('X-H', h), ('X-Bits', bits), ('X-Kind', kind),
                                 ('Content-Length', len(data)), ('Cache-Control', 'no-store')):
                        self.send_header(k, str(v))
                    self.end_headers(); self.wfile.write(data)
                else:
                    self.send(404, b'not found', 'text/plain')
            elif self.path.startswith('/captures/'):
                name = os.path.basename(self.path.split('?')[0])          # 只取文件名，防止跳出目录
                fn = os.path.join(ROOT, 'captures', name)
                if name.endswith(('.png', '.tif')) and os.path.isfile(fn):
                    with open(fn, 'rb') as f:
                        self.send(200, f.read(), 'image/tiff' if name.endswith('.tif') else 'image/png')
                else:
                    self.send(404, b'not found', 'text/plain')
            else:
                self.send(404, b'not found', 'text/plain')

        def do_POST(self):
            n = int(self.headers.get('Content-Length', 0))
            if self.path.startswith('/api/upload?name='):    # 存网页算出的图：正文是像素（.tif = 小端 float32，.png = 8 位灰度）
                name, body = self.path.split('=', 1)[1], self.rfile.read(n)
                m = re.fullmatch(r'\d{8}_\d{6}_chdr_(\d+)x(\d+)(_HDR\.tif|\.png)', name)
                w, h = (int(m[1]), int(m[2])) if m else (0, 0)
                if not m or len(body) != w * h * (4 if m[3].endswith('tif') else 1):
                    self.send(400, json.dumps(dict(ok=False, error='文件名或大小不对')).encode(), 'application/json'); return
                fn = os.path.join(ROOT, 'captures', name)
                if m[3].endswith('tif'):
                    tiff_f32(fn, w, h, body)
                else:
                    with open(fn, 'wb') as f:
                        f.write(png_gray(w, h, body))
                board.log(f'已保存 captures/{name}')
                self.send(200, json.dumps(dict(ok=True, result='captures/' + name)).encode(), 'application/json'); return
            req = json.loads(self.rfile.read(n) or b'{}')
            act = req.get('action')
            try:
                if act == 'ping':
                    r = board.ping(); board.log(f'FPGA 应答：{r}')
                elif act == 'status':
                    r = board.status()
                elif act == 'init':
                    r = board.init_camera(req.get('mode', '1280x800'), int(req.get('exposure', 0x282)),
                                          int(req.get('gain', 0x10)), int(req['hts']) if req.get('hts') else None,
                                          int(str(req.get('pll', '14')), 16), int(req.get('bits', 10)))
                elif act == 'hdr':
                    r = board.hdr(float(req['long_ms']), float(req['short_ms']))
                elif act == 'sess_save':                    # 存会话（参数和帧文件名）：种类 hd = 高动态，chdr = Claude 高动态
                    sid, kind = str(req['id']), req.get('kind', 'hd')
                    if not re.fullmatch(r'\d{8}_\d{6}', sid) or kind not in ('hd', 'chdr'):
                        raise ValueError('会话编号或种类不对')
                    os.makedirs(os.path.join(ROOT, 'captures'), exist_ok=True)
                    with open(os.path.join(ROOT, 'captures', f'{kind}_{sid}.json'), 'w', encoding='utf-8') as f:
                        json.dump(req['data'], f, ensure_ascii=False)
                    r = True
                elif act == 'shot_ms':
                    r = board.shot_ms(float(req['ms']), str(req.get('tag', '指定曝光')))
                elif act == 'capture':
                    r = board.capture(int(req.get('n', 1)))
                elif act == 'exposure':
                    r = board.set_exposure(int(req['exposure']), int(req['gain']))
                elif act == 'opts':
                    r = board.set_opts(int(req['value'])); board.log(f'MIPI 选项 = 0x{int(req["value"]):02X}')
                elif act == 'power':
                    r = board.power(int(req['io0']), int(req.get('io1', 0))); board.log(f'IO0={req["io0"]}')
                elif act == 'i2c_write':
                    r = board.i2c_w(int(req['reg'], 16), int(req['val'], 16))
                    board.log(f'写 0x{int(req["reg"], 16):04X} = 0x{int(req["val"], 16):02X}：{"ACK" if r else "无应答"}')
                elif act == 'i2c_read':
                    ok, v = board.i2c_r(int(req['reg'], 16)); r = dict(ok=ok, val=v)
                    board.log(f'读 0x{int(req["reg"], 16):04X} = 0x{v:02X}：{"ACK" if ok else "无应答"}')
                elif act == 'rsel':                             # 手动指定 SDRAM 读出采样点（0..7）
                    board.rsel = int(req['value']) & 7; board.set_opts(board.status()['opts'])
                    r = board.rsel; board.log(f'SDRAM 采样点手动设为 {board.RSEL_TIME[r]} 拍')
                elif act == 'align':                            # CLKDIVF ALIGNWD 脉冲：sclk 相对 eclk 滑一个周期
                    board.cmd('Z', expect='z'); r = True; board.log('MIPI 分频时钟滑动一个 eclk 周期（ALIGNWD）')
                elif act == 'delay':
                    r = board.set_delay(int(req['d0']), int(req['d1'])); board.log(f'数据通道输入延时：D0 {r["delay0"]} 级，D1 {r["delay1"]} 级')
                elif act == 'sdram_test':
                    r = board.sdram_test()
                elif act == 'regs':
                    r = {}
                    for x in req['regs']:
                        ok, v = board.i2c_r(int(x, 16))
                        r[x.upper()] = v if ok else None
                elif act == 'reconnect':
                    board.close(); board.open(); r = board.ping()
                elif act == 'program':
                    r = board.program(os.path.join(ROOT, 'build', os.path.basename(req.get('bit', 'cam.bit'))))
                else:
                    raise ValueError(f'未知操作 {act}')
                self.send(200, json.dumps(dict(ok=True, result=r), ensure_ascii=False, default=str).encode(),
                          'application/json')
            except Exception as e:
                board.log(f'{act} 失败：{e}')
                self.send(200, json.dumps(dict(ok=False, error=str(e)), ensure_ascii=False).encode(), 'application/json')
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', required=True, help='USB serial device connected to the FPGA')
    ap.add_argument('--baud', type=int, default=2_000_000)
    ap.add_argument('--http', type=int, default=8000)
    a = ap.parse_args()
    board = Board(a.port, a.baud)
    board.open()
    srv = ThreadingHTTPServer(('127.0.0.1', a.http), make_handler(board))
    print(f'打开 http://127.0.0.1:{a.http}', flush=True)
    try:
        srv.serve_forever()
    finally:
        board.close()


if __name__ == '__main__':
    main()
