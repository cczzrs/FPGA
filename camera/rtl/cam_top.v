// OV9281 单帧拍照（Icepi Zero v1.3）
// - MIPI CSI-2：时钟 PL23A/B（排针 21/22），D0 PL20C/D（排针 32/28），D1 PL20A/B（排针 26/24，极性反）
// - I2C：SDA 排针 16，SCL 排针 13；IO0 排针 15，IO1 排针 18
// - 串口：FT231X，BAUD 由 BAUDDIV 决定（50 MHz / 25 = 2 Mbaud）
// - 按键 0 / 命令 G n=1：抓 1 帧；按键 1 / 命令 G n=20：连拍 20 帧（相机连续输出的相邻帧）
//   原始 RAW8 存进 SDRAM，再逐行原样传回主机（不缩放、不改动像素）
//   每帧记录相对按键时刻的开始（FS）和写完时间，单位微秒
`default_nettype none
module cam_top #(
  parameter integer BAUDDIV = 25,
  parameter integer I2CDIV  = 250,       // I2C 四分之一位周期（50 MHz / 1000 = 50 kHz）
  parameter integer TIMEOUT = 1250000000, // 每帧抓帧超时 25 s（长曝光最长约 21 s 一帧）
  parameter integer MS      = 50000
) (
  input  wire       clk,
  input  wire [1:0] button,
  output reg  [4:0] led = 5'd0,
  output wire       usb_tx,
  input  wire       usb_rx,
  input  wire       mipi_ck,
  input  wire       mipi_d0,
  input  wire       mipi_d1,
  inout  wire       cam_sda,
  inout  wire       cam_scl,
  output wire       cam_io0,         // 上电高阻，主机发 P 命令后才驱动
  output wire       cam_io1,
  // SDRAM（W9825G6KH）
  output wire        sdram_clk,
  output wire        sdram_cke,
  output wire        sdram_csn, sdram_rasn, sdram_casn, sdram_wen,
  output wire [1:0]  sdram_ba,
  output wire [12:0] sdram_a,
  output wire [1:0]  sdram_dqm,
  inout  wire [15:0] sdram_dq
`ifdef SIM
  , input wire      clk100_sim
`endif
);
  // ================================================================ 时钟
  wire clk100;
`ifdef SIM
  assign clk100 = clk100_sim;
`else
  pll100 p100 (.clkin(clk), .clkout0(clk100), .locked());
`endif
  wire eclk, sclk;
  reg       dl_loadn = 1'b1;
  reg       dv_align = 1'b0;        // 命令 Z：给 CLKDIVF 一个 ALIGNWD 脉冲
  reg [1:0] dl_move = 2'b00;
  wire [3:0] q0, q1;
`ifdef SIM
  sim_eclk  u_ec (.i(mipi_ck), .o(eclk));
  sim_div2  u_dv (.i(eclk), .o(sclk));
  sim_iddr  u_d0 (.d(mipi_d0), .eclk(eclk), .sclk(sclk), .q(q0));
  sim_iddr  u_d1 (.d(mipi_d1), .eclk(eclk), .sclk(sclk), .q(q1));
  wire dl_cf0 = 1'b0, dl_cf1 = 1'b0;
`else
  // 数据通道输入延时（DELAYF）：命令 Y 设置，0 = 最小延时；延时越大，相对时钟越晚到，等于采样点前移
  wire d0_dl, d1_dl, dl_cf0, dl_cf1;
  DELAYF #(.DEL_MODE("USER_DEFINED"), .DEL_VALUE(0)) u_dl0 (.A(mipi_d0), .LOADN(dl_loadn), .MOVE(dl_move[0]), .DIRECTION(1'b0), .Z(d0_dl), .CFLAG(dl_cf0));
  DELAYF #(.DEL_MODE("USER_DEFINED"), .DEL_VALUE(0)) u_dl1 (.A(mipi_d1), .LOADN(dl_loadn), .MOVE(dl_move[1]), .DIRECTION(1'b0), .Z(d1_dl), .CFLAG(dl_cf1));
  ECLKSYNCB u_ec (.ECLKI(mipi_ck), .STOP(1'b0), .ECLKO(eclk));
  CLKDIVF #(.DIV("2.0")) u_dv (.CLKI(eclk), .RST(1'b0), .ALIGNWD(dv_align), .CDIVX(sclk));   // ALIGNWD：sclk 滑一个 eclk 周期
  IDDRX2F u_d0 (.D(d0_dl), .ECLK(eclk), .SCLK(sclk), .RST(1'b0), .ALIGNWD(1'b0),
                .Q0(q0[0]), .Q1(q0[1]), .Q2(q0[2]), .Q3(q0[3]));
  IDDRX2F u_d1 (.D(d1_dl), .ECLK(eclk), .SCLK(sclk), .RST(1'b0), .ALIGNWD(1'b0),
                .Q0(q1[0]), .Q1(q1[1]), .Q2(q1[2]), .Q3(q1[3]));
`endif

  // ================================================================ sclk 域：MIPI 接收
  reg [7:0] opts = 8'hA8;      // bit0 反转位序 bit1 交换通道 bit2 D0 取反 bit3 D1 取反 bit4 忽略 ECC，bit7:5 SDRAM 读出采样点
  reg [7:0] opt_s1 = 0, opt_s2 = 0;
  always @(posedge sclk) begin opt_s1 <= opts; opt_s2 <= opt_s1; end
  wire unlock;
  wire [7:0] lb0, lb1;
  wire lv0, lv1, lk0, lk1;
  mipi_lane l0 (.clk(sclk), .unlock(unlock), .nib(q0), .rev(opt_s2[0]), .inv(opt_s2[2]), .dout(lb0), .dval(lv0), .locked(lk0));
  mipi_lane l1 (.clk(sclk), .unlock(unlock), .nib(q1), .rev(opt_s2[0]), .inv(opt_s2[3]), .dout(lb1), .dval(lv1), .locked(lk1));
  wire        tv;
  wire [18:0] tok;
  wire [31:0] last_hdr;
  wire        rtv;
  wire [17:0] rtok;
  mipi_csi csi (.clk(sclk),
                .b0(opt_s2[1] ? lb1 : lb0), .v0(opt_s2[1] ? lv1 : lv0),
                .b1(opt_s2[1] ? lb0 : lb1), .v1(opt_s2[1] ? lv0 : lv1),
                .ignore_ecc(opt_s2[4]), .lk0(opt_s2[1] ? lk1 : lk0), .lk1(opt_s2[1] ? lk0 : lk1), .unlock(unlock), .tv(tv), .tok(tok), .last_hdr(last_hdr),
                .rtv(rtv), .rtok(rtok));
  // sclk 计数（格雷码），用于在 50 MHz 域测 MIPI 时钟频率
  reg [19:0] sc_bin = 0, sc_gray = 0;
  always @(posedge sclk) begin sc_bin <= sc_bin + 20'd1; sc_gray <= sc_bin ^ (sc_bin >> 1); end

  wire        ovf, fv;
  wire [18:0] ft;
  wire        fre;
  tok_fifo fifo (.wclk(sclk), .we(tv), .wd(tok), .ovf(ovf), .rclk(clk100), .rv(fv), .rd(ft), .re(fre));
  wire        rovf, rfv, rfre;
  wire [17:0] rft;
  tok_fifo #(.W(18)) rfifo (.wclk(sclk), .we(rtv), .wd(rtok), .ovf(rovf), .rclk(clk100), .rv(rfv), .rd(rft), .re(rfre));

  // ================================================================ clk100 域：全分辨率帧缓存（SDRAM）
  reg garm = 1'b0, g_rd_t = 1'b0, g_tst_t = 1'b0;   // clk50 发出
  reg [4:0]  gn = 5'd1;                             // 本次帧数
  reg [4:0]  gs0 = 5'd0;                            // 起始帧槽（0..19）
  reg [13:0] gb0 = 14'd0;                           // 起始帧槽的首个全局行 = gs0 * 800
  reg        ghold = 1'b0;                          // 1：只抓帧存进 SDRAM，不传回（之后用命令 X 传）
  reg [13:0] g_line = 14'd0;
  reg [1:0] garm_s = 0;
  reg [2:0] rsel_s1 = 0, rsel_s2 = 0;
  always @(posedge clk100) begin garm_s <= {garm_s[0], garm}; rsel_s1 <= opts[7:5]; rsel_s2 <= rsel_s1; end
  wire        g_fs_t, g_done_t, g_rd_done_t, g_tst_done_t, g_ovf;
  wire [15:0] g_wc, g_lines;
  wire [79:0] g_err;
  wire        lb_we;
  wire [9:0]  lb_a;
  wire [15:0] lb_d;
  sdfb fbs (.clk(clk100), .rv(rfv), .rt(rft), .rre(rfre),
            .arm(garm_s[1]), .nfr(gn), .gb0(gb0), .fs_t(g_fs_t), .done_t(g_done_t), .cap_wc(g_wc), .cap_lines(g_lines), .ovf(g_ovf),
            .rd_t(g_rd_t), .rd_line(g_line), .rd_done_t(g_rd_done_t),
            .tst_t(g_tst_t), .tst_done_t(g_tst_done_t), .tst_err(g_err), .rsel(rsel_s2),
            .lb_we(lb_we), .lb_a(lb_a), .lb_d(lb_d),
            .sd_clk(sdram_clk), .sd_cke(sdram_cke), .sd_csn(sdram_csn), .sd_rasn(sdram_rasn), .sd_casn(sdram_casn),
            .sd_wen(sdram_wen), .sd_ba(sdram_ba), .sd_a(sdram_a), .sd_dqm(sdram_dqm), .sd_dq(sdram_dq));
  // 行缓冲：clk100 写，clk50 按字节读
  reg [15:0] lbuf [0:1023];
  always @(posedge clk100) if (lb_we) lbuf[lb_a] <= lb_d;

  // ================================================================ clk100 域：取帧
  wire        done_t, capturing, fs_t, err_t;
  wire [7:0]  rows, last_dt;
  wire [15:0] src_wc, src_lines, last_wc, last_lines;
  wire [31:0] c_fs, c_fe, c_ls, c_err, c_hs, c_crc;
  wire        fwe;
  wire [15:0] fwa;
  wire [7:0]  fwd;
  // frame_build 只用它的统计计数；arm 固定为 0，不再缩图
  frame_build fb (.clk(clk100), .tv(fv), .tok(ft), .tre(fre), .arm(1'b0),
                  .done_t(done_t), .rows(rows), .src_wc(src_wc), .src_lines(src_lines), .capturing(capturing),
                  .fwe(fwe), .fwa(fwa), .fwd(fwd),
                  .c_fs(c_fs), .c_fe(c_fe), .c_ls(c_ls), .c_err(c_err), .c_hs(c_hs), .c_crc(c_crc),
                  .last_wc(last_wc), .last_lines(last_lines), .last_dt(last_dt), .fs_t(fs_t), .err_t(err_t));

  // 行缓冲读口（clk50）
  reg [15:0] fra = 0;
  reg [15:0] lbw = 0;
  always @(posedge clk) lbw <= lbuf[fra[10:1]];

  // 统计快照（clk50 请求，clk100 复制）
  reg snap_req = 1'b0, snap_ack = 1'b0;
  reg [2:0] sr_s = 0;
  reg [31:0] sh_fs = 0, sh_fe = 0, sh_ls = 0, sh_err = 0, sh_hs = 0, sh_crc = 0;
  reg [15:0] sh_wc = 0, sh_lines = 0;
  reg [7:0]  sh_dt = 0;
  always @(posedge clk100) begin
    sr_s <= {sr_s[1:0], snap_req};
    if (sr_s[2] != sr_s[1]) begin
      sh_fs <= c_fs; sh_fe <= c_fe; sh_ls <= c_ls; sh_err <= c_err; sh_hs <= c_hs; sh_crc <= c_crc;
      sh_wc <= last_wc; sh_lines <= last_lines; sh_dt <= last_dt;
      snap_ack <= sr_s[1];
    end
  end

  // ================================================================ clk50 域
  // 同步
  reg [2:0] ack_s = 0, fs_s = 0, err_s = 0, gd_s = 0, grd_s = 0, gt_s = 0, gfs_s = 0;
  reg [1:0] govf_s = 0;
  reg [1:0] lk_s0 = 0, lk_s1 = 0, ovf_s = 0, cap_s = 0;
  reg [19:0] g1 = 0, g2 = 0;
  always @(posedge clk) begin
    ack_s <= {ack_s[1:0], snap_ack};
    gd_s <= {gd_s[1:0], g_done_t}; gfs_s <= {gfs_s[1:0], g_fs_t}; grd_s <= {grd_s[1:0], g_rd_done_t}; gt_s <= {gt_s[1:0], g_tst_done_t};
    govf_s <= {govf_s[0], g_ovf};
    fs_s <= {fs_s[1:0], fs_t}; err_s <= {err_s[1:0], err_t};
    lk_s0 <= {lk_s0[0], lk0}; lk_s1 <= {lk_s1[0], lk1}; ovf_s <= {ovf_s[0], ovf}; cap_s <= {cap_s[0], capturing};
    g1 <= sc_gray; g2 <= g1;
  end
  function [19:0] g2b(input [19:0] g);
    integer i;
    begin g2b[19] = g[19]; for (i = 18; i >= 0; i = i - 1) g2b[i] = g2b[i+1] ^ g[i]; end
  endfunction
  // 微秒计数（拍摄计时）
  reg [5:0]  usd = 0;
  reg [31:0] us = 0;
  always @(posedge clk) if (usd == 6'd49) begin usd <= 0; us <= us + 32'd1; end else usd <= usd + 6'd1;
  reg [31:0] mscnt = 0;
  reg [19:0] sc_prev = 0, sclk_khz = 0;
  always @(posedge clk) begin
    if (mscnt == MS - 1) begin mscnt <= 0; sclk_khz <= g2b(g2) - sc_prev; sc_prev <= g2b(g2); end
    else mscnt <= mscnt + 1;
  end

  // ---------------------------------------------------------------- UART
  reg [1:0] rxs = 2'b11;
  always @(posedge clk) rxs <= {rxs[0], usb_rx};
  reg [15:0] rdiv = 0;
  reg [3:0]  rbit = 0;
  reg [7:0]  rsh = 0;
  reg        rbusy = 1'b0, rdone = 1'b0;
  reg [7:0]  rbyte = 0;
  always @(posedge clk) begin
    rdone <= 1'b0;
    if (!rbusy) begin
      if (!rxs[1]) begin rbusy <= 1'b1; rdiv <= BAUDDIV / 2; rbit <= 0; end
    end else if (rdiv == BAUDDIV - 1) begin
      rdiv <= 0; rbit <= rbit + 4'd1;
      if (rbit == 4'd0) begin if (rxs[1]) rbusy <= 1'b0; end          // 起始位无效
      else if (rbit <= 4'd8) rsh <= {rxs[1], rsh[7:1]};
      else begin rbusy <= 1'b0; if (rxs[1]) begin rdone <= 1'b1; rbyte <= rsh; end end
    end else rdiv <= rdiv + 16'd1;
  end
  // 命令帧：A5 cmd a b c
  reg [7:0]  cb [0:4];
  reg [2:0]  ci = 0;
  reg [31:0] cgap = 0;
  reg        cmd_rdy = 1'b0;
  reg [7:0]  c_cmd = 0, c_a = 0, c_b = 0, c_c = 0;
  reg        cmd_take = 1'b0;
  always @(posedge clk) begin
    if (cmd_take) cmd_rdy <= 1'b0;
    if (rdone) begin
      cgap <= 0;
      if (ci == 0 && rbyte != 8'hA5) ci <= 0;
      else begin
        cb[ci] <= rbyte;
        if (ci == 3'd4) begin
          ci <= 0; cmd_rdy <= 1'b1;
          c_cmd <= cb[1]; c_a <= cb[2]; c_b <= cb[3]; c_c <= rbyte;
        end else ci <= ci + 3'd1;
      end
    end else if (ci != 0) begin
      cgap <= cgap + 1;
      if (cgap == MS) ci <= 0;           // 字节间隔超过 1 ms 视为丢弃
    end
  end

  reg [15:0] tdiv = 0;
  reg [3:0]  tbit = 0;
  reg [9:0]  tsh = 10'h3FF;
  reg        tbusy = 1'b0;
  reg        tgo = 1'b0;
  reg [7:0]  tbyte = 0;
  assign usb_tx = tsh[0];
  always @(posedge clk) begin
    if (tbusy) begin
      if (tdiv == BAUDDIV - 1) begin
        tdiv <= 0; tsh <= {1'b1, tsh[9:1]}; tbit <= tbit + 4'd1;
        if (tbit == 4'd9) tbusy <= 1'b0;
      end else tdiv <= tdiv + 16'd1;
    end else if (tgo) begin
      tsh <= {1'b1, tbyte, 1'b0}; tbusy <= 1'b1; tdiv <= 0; tbit <= 0;
    end
  end

  // ---------------------------------------------------------------- 发包引擎：5A type len[3] payload chk
  reg [7:0]  rbuf [0:63];
  reg [7:0]  p_type = 0;
  reg [6:0]  p_hdr = 0;          // payload 中来自 rbuf 的字节数
  reg [16:0] p_ram = 0;          // payload 中来自帧缓冲的字节数
  reg        p_start = 1'b0, p_busy = 1'b0;
  reg [3:0]  ps = 0;
  reg [23:0] p_len = 0, p_i = 0;
  reg [7:0]  p_chk = 0;
  wire [7:0] pbyte = (p_i < {17'd0, p_hdr}) ? rbuf[p_i[5:0]] : (fra[0] ? lbw[15:8] : lbw[7:0]);
  always @(posedge clk) begin
    tgo <= 1'b0;
    case (ps)
      0: if (p_start) begin p_busy <= 1'b1; p_len <= {7'd0, p_ram} + {17'd0, p_hdr}; p_i <= 0; p_chk <= 0; ps <= 1; end
      1: if (!tbusy && !tgo) begin tbyte <= 8'h5A; tgo <= 1'b1; ps <= 2; end
      2: if (!tbusy && !tgo) begin tbyte <= p_type; tgo <= 1'b1; ps <= 3; end
      3: if (!tbusy && !tgo) begin tbyte <= p_len[23:16]; tgo <= 1'b1; ps <= 4; end
      4: if (!tbusy && !tgo) begin tbyte <= p_len[15:8]; tgo <= 1'b1; ps <= 5; end
      5: if (!tbusy && !tgo) begin tbyte <= p_len[7:0]; tgo <= 1'b1; ps <= 6; end
      6: if (!tbusy && !tgo) begin                // 准备下一个 payload 字节
           if (p_i == p_len) ps <= 9;
           else begin fra <= p_i[15:0] - {9'd0, p_hdr}; ps <= 7; end
         end
      7: ps <= 8;                                 // 等帧缓冲读出
      8: begin
           tbyte <= pbyte; p_chk <= p_chk ^ pbyte;
           tgo <= 1'b1; p_i <= p_i + 24'd1; ps <= 6;
         end
      9: if (!tbusy && !tgo) begin tbyte <= p_chk; tgo <= 1'b1; ps <= 10; end
      10: if (!tbusy && !tgo) begin p_busy <= 1'b0; ps <= 0; end
      default: ps <= 0;
    endcase
  end

  // ---------------------------------------------------------------- I2C 主机（开漏，50 kHz）
  reg sda_oe = 1'b0, scl_oe = 1'b0;
  assign cam_sda = sda_oe ? 1'b0 : 1'bz;
  assign cam_scl = scl_oe ? 1'b0 : 1'bz;
  reg [1:0] sda_s = 2'b11;
  always @(posedge clk) sda_s <= {sda_s[0], cam_sda};
  reg [15:0] idv = 0;
  wire itick = (idv == I2CDIV - 1);
  always @(posedge clk) idv <= itick ? 16'd0 : idv + 16'd1;
  // 操作序列：每项 {op[1:0], byte[7:0]}，op 0 START 1 STOP 2 WRITE 3 READ(NACK)
  reg [9:0]  iseq [0:9];
  reg [3:0]  in = 0, ii = 0;
  reg        istart = 1'b0, ibusy = 1'b0;
  reg [1:0]  iph = 0;
  reg [3:0]  ib = 0;
  reg [7:0]  ish = 0, irx = 0;
  reg [3:0]  iack = 0;            // 每个写字节的 ACK（1 = 收到 ACK）
  reg [2:0]  iw = 0;
  always @(posedge clk) begin
    if (istart && !ibusy) begin ibusy <= 1'b1; ii <= 0; iph <= 0; ib <= 0; iack <= 0; iw <= 0; end
    else if (ibusy && itick) begin
      case (iseq[ii][9:8])
        2'd0: begin                                  // START：SDA 高、SCL 高 -> SDA 低 -> SCL 低
          case (iph)
            0: begin sda_oe <= 1'b0; scl_oe <= 1'b0; end
            1: sda_oe <= 1'b1;
            2: scl_oe <= 1'b1;
            3: ;
          endcase
          iph <= iph + 2'd1;
          if (iph == 2'd3) ii <= ii + 4'd1;
        end
        2'd1: begin                                  // STOP：SDA 低 -> SCL 高 -> SDA 高
          case (iph)
            0: begin sda_oe <= 1'b1; scl_oe <= 1'b1; end
            1: scl_oe <= 1'b0;
            2: sda_oe <= 1'b0;
            3: ;
          endcase
          iph <= iph + 2'd1;
          if (iph == 2'd3) begin
            if (ii == in - 4'd1) ibusy <= 1'b0; else ii <= ii + 4'd1;
          end
        end
        default: begin                               // 9 位：8 数据 + ACK
          case (iph)
            0: begin
                 scl_oe <= 1'b1;
                 if (ib < 4'd8) sda_oe <= (iseq[ii][9:8] == 2'd2) ? ~iseq[ii][7 - ib] : 1'b0;
                 else sda_oe <= 1'b0;                // 第 9 位：写时释放听 ACK，读时发 NACK
               end
            1: scl_oe <= 1'b0;
            2: begin
                 if (ib < 4'd8) irx <= {irx[6:0], sda_s[1]};
                 else if (iseq[ii][9:8] == 2'd2) begin iack[iw] <= ~sda_s[1]; iw <= iw + 3'd1; end
               end
            3: scl_oe <= 1'b1;
          endcase
          iph <= iph + 2'd1;
          if (iph == 2'd3) begin
            if (ib == 4'd8) begin ib <= 0; ii <= ii + 4'd1; end else ib <= ib + 4'd1;
          end
        end
      endcase
    end
  end

  // ---------------------------------------------------------------- 按键
`ifdef SIM
  reg sim_press = 1'b0;
`endif
  reg [15:0] bms = 0;
  wire btick = (bms == 16'd49999);
  always @(posedge clk) bms <= btick ? 16'd0 : bms + 16'd1;
  reg [1:0] bs0 = 2'b11, bs1 = 2'b11;
  always @(posedge clk) begin bs0 <= {bs0[0], button[0]}; bs1 <= {bs1[0], button[1]}; end
  reg [3:0] bc0 = 0, bc1 = 0;
  reg st0 = 1'b1, st1 = 1'b1;
  reg [1:0] press = 2'b00;                   // [0] 单拍键，[1] 连拍键
  always @(posedge clk) begin
    press <= 2'b00;
    if (btick) begin
      if (bs0[1] == st0) bc0 <= 0; else if (bc0 == 4'd15) begin st0 <= bs0[1]; bc0 <= 0; if (!bs0[1]) press[0] <= 1'b1; end else bc0 <= bc0 + 4'd1;
      if (bs1[1] == st1) bc1 <= 0; else if (bc1 == 4'd15) begin st1 <= bs1[1]; bc1 <= 0; if (!bs1[1]) press[1] <= 1'b1; end else bc1 <= bc1 + 4'd1;
    end
`ifdef SIM
    if (sim_press) press[0] <= 1'b1;
`endif
  end

  // ---------------------------------------------------------------- 主状态机
  reg [7:0] i2c_addr = 8'h60;
  reg io0_v = 1'b0, io1_v = 1'b0, io_oe = 1'b0;
  assign cam_io0 = io_oe ? io0_v : 1'bz;
  assign cam_io1 = io_oe ? io1_v : 1'bz;
  reg [31:0] frames = 0;
  reg [1:0]  press_p = 2'b00;
  localparam M_IDLE = 0, M_I2C = 1, M_I2CW = 2, M_SNAP = 3, M_DLY = 4, M_SENDW = 5, M_GFR = 6, M_GFRN = 7,
             M_GARM = 10, M_GCAPW = 11, M_GLINE = 12, M_GRDW = 13, M_GNEXT = 14, M_TSTW = 15;
  localparam [4:0] NBURST = 5'd20;
  // G / X 命令参数：起始槽限制在 0..19，帧数限制在 1..(20 - 起始槽)
  wire [4:0] g_s = (c_c > 8'd19) ? 5'd19 : c_c[4:0];
  wire [4:0] g_n = (c_a == 8'd0) ? 5'd1 : (c_a > {3'd0, NBURST - g_s}) ? NBURST - g_s : c_a[4:0];
  wire [4:0] x_s = (c_a > 8'd19) ? 5'd19 : c_a[4:0];
  wire [4:0] x_n = (c_b == 8'd0) ? 5'd1 : (c_b > {3'd0, NBURST - x_s}) ? NBURST - x_s : c_b[4:0];
  reg [7:0]  dl0 = 0, dl1 = 0;       // 两条数据通道的延时级数（0..127）
  reg [6:0]  dl_n0 = 0, dl_n1 = 0;   // 还要走的级数
  reg [15:0] gl = 0;                 // 帧内行号
  reg [4:0]  gf = 0;                 // 帧序号（抓帧时 = 已写完的帧数）
  reg [13:0] gb = 0;                 // gf 帧的首个全局行
  reg [31:0] t0 = 0;
  reg [31:0] ts [0:19];              // 每帧开始（FS）时刻，相对按键，微秒
  reg [31:0] te [0:19];              // 每帧写完时刻
  reg [15:0] fln [0:19];             // 每帧行数
  reg [3:0]  m = M_IDLE, m_ret = M_IDLE;
  reg [31:0] mt = 0;
  reg        is_read = 1'b0, cap_after = 1'b0;
  integer k;

  task send(input [7:0] ty, input [6:0] hl, input [16:0] rl, input [3:0] ret);
    begin p_type <= ty; p_hdr <= hl; p_ram <= rl; p_start <= 1'b1; m_ret <= ret; m <= M_SENDW; end
  endtask
  task put32(input [5:0] at, input [31:0] v);
    begin rbuf[at] <= v[31:24]; rbuf[at+1] <= v[23:16]; rbuf[at+2] <= v[15:8]; rbuf[at+3] <= v[7:0]; end
  endtask

  always @(posedge clk) begin
    cmd_take <= 1'b0;
    istart <= 1'b0;
    dv_align <= 1'b0;
    if (p_busy) p_start <= 1'b0;
    if (m != M_IDLE) press_p <= press_p | press;  // 忙时按键先锁存
    case (m)
      M_IDLE: begin
        if (press != 2'b00) press_p <= press_p | press;
        if (press_p != 2'b00) begin gs0 <= 5'd0; gb0 <= 14'd0; ghold <= 1'b0; end
        if (press_p[0]) begin press_p[0] <= 1'b0; gn <= 5'd1; rbuf[0] <= 8'd0; rbuf[1] <= 8'd1; send("b", 7'd2, 17'd0, M_GARM); end
        else if (press_p[1]) begin press_p[1] <= 1'b0; gn <= NBURST; rbuf[0] <= 8'd1; rbuf[1] <= {3'd0, NBURST}; send("b", 7'd2, 17'd0, M_GARM); end
        else if (cmd_rdy) begin
          cmd_take <= 1'b1;
          case (c_cmd)
            "V": begin rbuf[0] <= "C"; rbuf[1] <= "A"; rbuf[2] <= "M"; rbuf[3] <= "1"; send("v", 7'd4, 17'd0, M_IDLE); end
            "D": begin i2c_addr <= c_a; rbuf[0] <= c_a; send("d", 7'd1, 17'd0, M_IDLE); end
            "P": begin io0_v <= c_a[0]; io1_v <= c_a[1]; io_oe <= ~c_a[7]; rbuf[0] <= c_a; send("p", 7'd1, 17'd0, M_IDLE); end
            "O": begin opts <= c_a; rbuf[0] <= c_a; send("o", 7'd1, 17'd0, M_IDLE); end
            "W": begin
                   iseq[0] <= {2'd0, 8'd0}; iseq[1] <= {2'd2, i2c_addr[6:0], 1'b0};
                   iseq[2] <= {2'd2, c_a}; iseq[3] <= {2'd2, c_b}; iseq[4] <= {2'd2, c_c};
                   iseq[5] <= {2'd1, 8'd0}; in <= 4'd6; is_read <= 1'b0; m <= M_I2C;
                 end
            "R": begin
                   iseq[0] <= {2'd0, 8'd0}; iseq[1] <= {2'd2, i2c_addr[6:0], 1'b0};
                   iseq[2] <= {2'd2, c_a}; iseq[3] <= {2'd2, c_b}; iseq[4] <= {2'd1, 8'd0};
                   iseq[5] <= {2'd0, 8'd0}; iseq[6] <= {2'd2, i2c_addr[6:0], 1'b1};
                   iseq[7] <= {2'd3, 8'd0}; iseq[8] <= {2'd1, 8'd0}; in <= 4'd9; is_read <= 1'b1; m <= M_I2C;
                 end
            "S": begin snap_req <= ~snap_req; mt <= 0; m <= M_SNAP; end
            "G": begin   // a = 帧数（0 当 1），b 位0 = 只抓不传，c = 起始帧槽；起始槽 + 帧数不超过 20
                   gn <= g_n; gs0 <= g_s; gb0 <= g_s * 14'd800; ghold <= c_b[0];
                   rbuf[0] <= {3'd0, g_n};
                   send("g", 7'd1, 17'd0, M_GARM);
                 end
            "X": begin   // 传回帧槽 a 起的 b 帧（之前用 G 只抓不传存下的）
                   gs0 <= x_s; gb0 <= x_s * 14'd800; gn <= x_n; ghold <= 1'b0; m <= M_GFR;
                 end
            "T": begin g_tst_t <= ~g_tst_t; mt <= 0; m <= M_TSTW; end
            "Z": begin dv_align <= 1'b1; rbuf[0] <= c_a; send("z", 7'd1, 17'd0, M_IDLE); end
            "Y": begin dl0 <= c_a; dl1 <= c_b; dl_n0 <= c_a[6:0]; dl_n1 <= c_b[6:0]; dl_loadn <= 1'b0; mt <= 0; m <= M_DLY; end
            default: begin rbuf[0] <= c_cmd; send("?", 7'd1, 17'd0, M_IDLE); end
          endcase
        end
      end
      M_I2C:  begin istart <= 1'b1; m <= M_I2CW; end
      M_I2CW: if (!istart && !ibusy) begin
                rbuf[0] <= {4'd0, iack};
                rbuf[1] <= irx;
                send(is_read ? "r" : "w", is_read ? 7'd2 : 7'd1, 17'd0, M_IDLE);
              end
      M_SNAP: begin
        mt <= mt + 1;
        if (ack_s[2] == snap_req || mt > 1000) begin
          put32(0, {12'd0, sclk_khz}); put32(4, sh_fs); put32(8, sh_fe); put32(12, sh_ls);
          put32(16, sh_err); put32(20, {8'd0, sh_dt, sh_wc}); put32(24, {16'd0, sh_lines});
          put32(28, {opts, 2'd0, govf_s[1], 1'b0, garm, ovf_s[1], lk_s1[1], lk_s0[1], i2c_addr, io_oe, 5'd0, io1_v, io0_v});
          put32(32, sh_hs); put32(36, 32'hCA5E0002); put32(40, frames); put32(44, last_hdr);
          put32(48, sh_crc); put32(52, {dl0, dl1, 14'd0, dl_cf1, dl_cf0});
          send("s", 7'd56, 17'd0, M_IDLE);
        end
      end
      // 全分辨率：抓 gn 帧 -> 头包 G {帧数, 宽, 溢出, 总用时} -> 每帧一个 F 包 {序号, 行数, 开始, 写完}
      //   -> 每行一个 L 包 {帧序号, 行号, 像素}
      M_GARM: begin garm <= 1'b1; mt <= 0; t0 <= us; gf <= gs0; m <= M_GCAPW; end
      M_GCAPW: begin
        mt <= mt + 1;
        if (gfs_s[2] != gfs_s[1]) ts[gf] <= us - t0;
        if (gd_s[2] != gd_s[1]) begin
          te[gf] <= us - t0; fln[gf] <= g_lines; frames <= frames + 1; mt <= 0;
          gf <= gf + 5'd1;
          if (gf + 5'd1 == gs0 + gn) begin
            if (ghold) begin             // 只抓不传：回 h {帧数, 溢出, 末帧写完时刻}
              garm <= 1'b0; rbuf[0] <= {3'd0, gn}; rbuf[1] <= {7'd0, govf_s[1]}; put32(2, us - t0);
              send("h", 7'd6, 17'd0, M_IDLE);
            end else m <= M_GFR;
          end
        end else if (mt == TIMEOUT) begin
          if (gf != gs0 && !ghold) begin gn <= gf - gs0; m <= M_GFR; end   // 连拍中途超时：传回已抓到的帧
          else begin garm <= 1'b0; rbuf[0] <= 8'd2; send("E", 7'd1, 17'd0, M_IDLE); end   // 2 = 抓帧超时
        end
      end
      M_GFR: begin
        garm <= 1'b0;
        rbuf[0] <= {3'd0, gn}; rbuf[1] <= g_wc[15:8]; rbuf[2] <= g_wc[7:0]; rbuf[3] <= {7'd0, govf_s[1]};
        put32(4, te[gs0 + gn - 5'd1]);
        gf <= gs0; gb <= gb0; gl <= 0;
        send("G", 7'd8, 17'd0, M_GFRN);
      end
      M_GFRN: if (gf == gs0 + gn) begin gf <= gs0; m <= M_GLINE; end
              else begin
                rbuf[0] <= {3'd0, gf - gs0}; rbuf[1] <= fln[gf][15:8]; rbuf[2] <= fln[gf][7:0];
                put32(3, ts[gf]); put32(7, te[gf]);
                gf <= gf + 5'd1;
                send("F", 7'd11, 17'd0, M_GFRN);
              end
      M_GLINE: if (gf == gs0 + gn || g_wc == 16'd0) m <= M_IDLE;
               else if (gl == fln[gf]) begin gl <= 0; gf <= gf + 5'd1; gb <= gb + 14'd800; end
               else begin g_line <= gb + gl[13:0]; g_rd_t <= ~g_rd_t; mt <= 0; m <= M_GRDW; end
      M_GRDW: begin
        mt <= mt + 1;
        if (grd_s[2] != grd_s[1] || mt == 50000) begin
          rbuf[0] <= {3'd0, gf - gs0}; rbuf[1] <= gl[15:8]; rbuf[2] <= gl[7:0];
          send("L", 7'd3, {1'b0, g_wc} + 17'd2, M_GNEXT);   // 像素 + 收到的 2 字节 CRC（低字节在前）
        end
      end
      M_GNEXT: begin gl <= gl + 16'd1; m <= M_GLINE; end
      M_TSTW: begin
        mt <= mt + 1;
        if (gt_s[2] != gt_s[1] || mt == 50000) begin
          for (k = 0; k < 8; k = k + 1) begin rbuf[2*k] <= {6'd0, g_err[10*k+8 +: 2]}; rbuf[2*k+1] <= g_err[10*k +: 8]; end
          send("t", 7'd16, 17'd0, M_IDLE);
        end
      end
      // 延时设置：LOADN 拉低复位到 0 级，再按 MOVE 脉冲逐级加（每级 8 个 clk50：高 4 低 4）
      M_DLY: begin
        mt <= mt + 1;
        if (mt == 8) dl_loadn <= 1'b1;
        else if (mt > 16) begin
          if (mt[2:0] == 3'd0) begin
            dl_move <= {dl_n1 != 0, dl_n0 != 0};
            if (dl_n0 != 0) dl_n0 <= dl_n0 - 7'd1;
            if (dl_n1 != 0) dl_n1 <= dl_n1 - 7'd1;
          end else if (mt[2:0] == 3'd4) dl_move <= 2'b00;
          if (mt[2:0] == 3'd7 && dl_n0 == 0 && dl_n1 == 0 && dl_move == 2'b00) begin
            rbuf[0] <= dl0; rbuf[1] <= dl1; rbuf[2] <= {6'd0, dl_cf1, dl_cf0};
            send("y", 7'd3, 17'd0, M_IDLE);
          end
        end
      end
      M_SENDW: if (!p_start && !p_busy) m <= m_ret;
      default: m <= M_IDLE;
    endcase
  end

  // ---------------------------------------------------------------- LED
  reg [25:0] hb = 0;
  reg [23:0] fs_hold = 0, err_hold = 0;
  always @(posedge clk) begin
    hb <= hb + 26'd1;
    if (fs_s[2] != fs_s[1]) fs_hold <= 24'hFFFFFF; else if (fs_hold != 0) fs_hold <= fs_hold - 24'd1;
    if (err_s[2] != err_s[1]) err_hold <= 24'hFFFFFF; else if (err_hold != 0) err_hold <= err_hold - 24'd1;
    led[0] <= hb[25];                         // 心跳
    led[1] <= (sclk_khz > 20'd1000);          // 收到 MIPI 时钟
    led[2] <= (fs_hold != 0);                 // 最近收到帧开始包
    led[3] <= garm | p_busy;                  // 拍照/发送中
    led[4] <= (err_hold != 0);                // 最近有包头 ECC 错
  end
endmodule
