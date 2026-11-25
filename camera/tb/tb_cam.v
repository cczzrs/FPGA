`timescale 1ps/1ps
// 相机通路仿真：软件 CSI-2 发送端（2 通道、RAW8、640 宽，行数取 40 以缩短仿真）+ SDRAM 模型 + 串口主机
module tb;
  localparam integer BAUDDIV = 4;
  localparam integer T = 2500;            // 每位 2.5 ns（400 Mbps/通道）
`ifdef RAW10
  localparam integer W = 1600, H = 40;   // iverilog -DRAW10：RAW10 行包（DT 0x2B），1280 像素 = 1600 字节
  localparam [7:0] DT = 8'h2B;
`elsif W1280
  localparam integer W = 1280, H = 40;   // iverilog -DW1280：测一行跨 SDRAM 行边界（512 字）的情况
`else
  localparam integer W = 640, H = 40;
`endif
`ifndef RAW10
  localparam [7:0] DT = 8'h2A;
`endif

  reg clk = 0, clk100 = 0;
  always #10000 clk = ~clk;               // 50 MHz
  always #5000  clk100 = ~clk100;         // 100 MHz
  reg mipi_ck = 0;
  reg gen_on = 1'b1;                      // 收完帧头后停发，加快仿真
  always #(T) if (gen_on) mipi_ck = ~mipi_ck;   // DDR：每个沿 1 位
  reg d0 = 0, d1 = 0;
  reg urx = 1'b1;
  wire utx;
  wire sda, scl;
  pullup (sda);
  pullup (scl);
  wire [4:0] led;
  wire io0, io1;
  wire sd_clk, sd_cke, sd_csn, sd_rasn, sd_casn, sd_wen;
  wire [1:0] sd_ba, sd_dqm;
  wire [12:0] sd_a;
  wire [15:0] sd_dq;
  sdram_model sdm (.clk(sd_clk), .cke(sd_cke), .csn(sd_csn), .rasn(sd_rasn), .casn(sd_casn), .wen(sd_wen),
                   .ba(sd_ba), .a(sd_a), .dqm(sd_dqm), .dq(sd_dq));

  cam_top #(.BAUDDIV(BAUDDIV), .I2CDIV(4), .TIMEOUT(2000000), .MS(5000)) dut (
    .sdram_clk(sd_clk), .sdram_cke(sd_cke), .sdram_csn(sd_csn), .sdram_rasn(sd_rasn), .sdram_casn(sd_casn),
    .sdram_wen(sd_wen), .sdram_ba(sd_ba), .sdram_a(sd_a), .sdram_dqm(sd_dqm), .sdram_dq(sd_dq),
    .clk(clk), .button(2'b11), .led(led), .usb_tx(utx), .usb_rx(urx),
    .mipi_ck(mipi_ck), .mipi_d0(d0), .mipi_d1(d1),
    .cam_sda(sda), .cam_scl(scl), .cam_io0(io0), .cam_io1(io1), .clk100_sim(clk100));

  // ------------------------------------------------ CSI-2 发送端
  function [5:0] ecc6(input [23:0] d);
    begin
      ecc6[0] = d[0]^d[1]^d[2]^d[4]^d[5]^d[7]^d[10]^d[11]^d[13]^d[16]^d[20]^d[21]^d[22]^d[23];
      ecc6[1] = d[0]^d[1]^d[3]^d[4]^d[6]^d[8]^d[10]^d[12]^d[14]^d[17]^d[20]^d[21]^d[22]^d[23];
      ecc6[2] = d[0]^d[2]^d[3]^d[5]^d[6]^d[9]^d[11]^d[12]^d[15]^d[18]^d[20]^d[21]^d[22];
      ecc6[3] = d[1]^d[2]^d[3]^d[7]^d[8]^d[9]^d[13]^d[14]^d[15]^d[19]^d[20]^d[21]^d[23];
      ecc6[4] = d[4]^d[5]^d[6]^d[7]^d[8]^d[9]^d[16]^d[17]^d[18]^d[19]^d[20]^d[22]^d[23];
      ecc6[5] = d[10]^d[11]^d[12]^d[13]^d[14]^d[15]^d[16]^d[17]^d[18]^d[19]^d[21]^d[22]^d[23];
    end
  endfunction
  function [7:0] pix(input integer x, input integer y, input integer f);
    pix = (x * 3 + y * 5 + f * 7) & 8'hFF;   // 帧号参与：能看出帧槽是否串、帧是否相邻
  endfunction

  reg [7:0] pkt [0:4095];
  integer plen;
  integer seed = 7;
  task slot(input x0, input x1);
    begin @(mipi_ck); #(T/2); d0 = x0; d1 = x1; end
  endtask
  task burst;
    integer i, b;
    reg t0, t1;
    begin
      for (i = 0; i < 24; i = i + 1) slot($random(seed), $random(seed));   // LP 期间的随机电平
      for (i = 0; i < 16; i = i + 1) slot(1'b0, 1'b0);                     // HS-zero
      for (b = 0; b < 8; b = b + 1) slot(8'hB8 >> b, 8'hB8 >> b);           // 同步字，低位先发
      for (i = 0; i < plen; i = i + 2)
        for (b = 0; b < 8; b = b + 1) slot(pkt[i] >> b, pkt[i+1] >> b);
      t0 = ~d0; t1 = ~d1;
      for (i = 0; i < 16; i = i + 1) slot(t0, t1);                          // HS-trail：恒为最后一位取反
      for (i = 0; i < 24; i = i + 1) slot($random(seed), $random(seed));
    end
  endtask
  task hdr(input [7:0] di, input [15:0] wc);
    begin
      pkt[0] = di; pkt[1] = wc[7:0]; pkt[2] = wc[15:8];
      pkt[3] = {2'b00, ecc6({wc[15:8], wc[7:0], di})};
    end
  endtask
  task frame(input integer fn);
    integer x, y, k;
    reg [15:0] crc;
    begin
      hdr(8'h00, fn); plen = 4; burst;                                  // FS
      for (y = 0; y < H; y = y + 1) begin
        hdr(DT, W);
        for (x = 0; x < W; x = x + 1) pkt[4 + x] = pix(x, y, fn);
        crc = 16'hFFFF;
        for (x = 0; x < W; x = x + 1)
          for (k = 0; k < 8; k = k + 1) crc = (crc[0] ^ pkt[4 + x][k]) ? ((crc >> 1) ^ 16'h8408) : (crc >> 1);
        if (y == 3) crc = crc ^ 16'h0001;                                // 每帧第 3 行故意给错 CRC
        pkt[4 + W] = crc[7:0]; pkt[5 + W] = crc[15:8];
        plen = W + 6; burst;
      end
      hdr(8'h01, fn); plen = 4; burst;                                  // FE
    end
  endtask

  // ------------------------------------------------ 串口主机
  task ubyte(input [7:0] v);
    integer i;
    begin
      urx = 1'b0; repeat (BAUDDIV) @(posedge clk);
      for (i = 0; i < 8; i = i + 1) begin urx = v[i]; repeat (BAUDDIV) @(posedge clk); end
      urx = 1'b1; repeat (BAUDDIV) @(posedge clk);
    end
  endtask
  task cmd(input [7:0] c, input [7:0] a, input [7:0] b, input [7:0] cc);
    begin ubyte(8'hA5); ubyte(c); ubyte(a); ubyte(b); ubyte(cc); end
  endtask

  reg [7:0] rx [0:400000];
  integer rn = 0;
  reg [7:0] ch;
  integer i;
  initial forever begin
    @(negedge utx);
    repeat (BAUDDIV / 2) @(posedge clk);
    for (i = 0; i < 8; i = i + 1) begin repeat (BAUDDIV) @(posedge clk); ch[i] = utx; end
    repeat (BAUDDIV) @(posedge clk);
    rx[rn] = ch; rn = rn + 1;
  end
  // 解包
  integer pi = 0, plen2, j, errs, pk;
  reg [7:0] chk;
  task wait_pkt(output [7:0] ty);
    begin
      while (rn < pi + 5) @(posedge clk);
      if (rx[pi] !== 8'h5A) begin $display("包头错 %h", rx[pi]); $finish; end
      ty = rx[pi + 1];
      plen2 = {rx[pi + 2], rx[pi + 3], rx[pi + 4]};
      while (rn < pi + 6 + plen2) @(posedge clk);
      chk = 0;
      for (j = 0; j < plen2; j = j + 1) chk = chk ^ rx[pi + 5 + j];
      if (chk !== rx[pi + 5 + plen2]) $display("校验错 type=%s", ty);
      pk = pi + 5;
      pi = pi + 6 + plen2;
    end
  endtask

  reg [7:0] ty;
  integer r, c, dy, dx, s, x0, exp, nl, nf, f, f0, fl [0:19], fnum [0:19];
  // 按 CSI-2 规则重算一行的 CRC（期望值；第 3 行发送端故意改过，用来核对 CRC 是否原样传回）
  function [15:0] lcrc(input integer at);
    integer q, k;
    begin
      lcrc = 16'hFFFF;
      for (q = 0; q < W; q = q + 1)
        for (k = 0; k < 8; k = k + 1) lcrc = (lcrc[0] ^ rx[at + q][k]) ? ((lcrc >> 1) ^ 16'h8408) : (lcrc >> 1);
      if (r == 3) lcrc = lcrc ^ 16'h0001;
    end
  endfunction
  task get_frames;
    begin
      wait_pkt(ty); nf = rx[pk];
      $display("帧头 %s：帧数 %0d 宽 %0d 溢出 %0d 总用时 %0d us", ty, nf, {rx[pk+1], rx[pk+2]}, rx[pk+3],
               {rx[pk+4], rx[pk+5], rx[pk+6], rx[pk+7]});
      gen_on = 1'b0;
      for (f = 0; f < nf; f = f + 1) begin
        wait_pkt(ty); fl[f] = {rx[pk+1], rx[pk+2]};
        $display("  %s 帧%0d 行数 %0d 开始 %0d us 写完 %0d us", ty, rx[pk], fl[f],
                 {rx[pk+3], rx[pk+4], rx[pk+5], rx[pk+6]}, {rx[pk+7], rx[pk+8], rx[pk+9], rx[pk+10]});
      end
      errs = 0;
      for (f = 0; f < nf; f = f + 1)
        for (r = 0; r < fl[f]; r = r + 1) begin
          wait_pkt(ty);
          if (r == 0) begin fnum[f] = ((rx[pk+3] * 183) & 255); f0 = fnum[f] - f; end   // 7 的模 256 逆元是 183：由首像素反推帧号
          if (ty !== "L" || rx[pk] !== f || {rx[pk+1], rx[pk+2]} !== r || plen2 !== W + 5 || {rx[pk+4+W], rx[pk+3+W]} !== lcrc(pk + 3)) begin
            $display("行包错：type=%s 帧=%0d 行号=%0d 长度=%0d", ty, rx[pk], {rx[pk+1], rx[pk+2]}, plen2); errs = errs + 1;
          end else
            for (c = 0; c < W; c = c + 1)
              if (rx[pk + 3 + c] !== pix(c, r, f0 + f)) begin
                if (errs < 5) $display("像素错 帧%0d (%0d,%0d) 得 %0d 应 %0d", f, c, r, rx[pk + 3 + c], pix(c, r, f0 + f));
                errs = errs + 1;
              end
        end
      $write("比对 %0d 帧，帧号", nf);
      for (f = 0; f < nf; f = f + 1) $write(" %0d", fnum[f]);
      $display("：错误 %0d 像素", errs);
    end
  endtask
  initial begin
    #1000000;
    cmd("V", 0, 0, 0); wait_pkt(ty); $display("ping: %s %s%s%s%s", ty, rx[pk], rx[pk+1], rx[pk+2], rx[pk+3]);
    cmd("O", 8'h00, 0, 0); wait_pkt(ty); $display("opts: %s %h", ty, rx[pk]);
    cmd("W", 8'h01, 8'h00, 8'h00); wait_pkt(ty); $display("i2c 写（无器件）: %s ack=%b", ty, rx[pk][3:0]);
    cmd("R", 8'h30, 8'h0A, 8'h00); wait_pkt(ty); $display("i2c 读（无器件）: %s ack=%b data=%h", ty, rx[pk][3:0], rx[pk+1]);
    cmd("T", 0, 0, 0); wait_pkt(ty);
    $write("SDRAM 自检 %s，采样点 0..7 的错误数：", ty);
    for (j = 0; j < 8; j = j + 1) $write(" %0d", {rx[pk+2*j], rx[pk+2*j+1]});
    $display("");
    cmd("O", 8'hA0, 0, 0); wait_pkt(ty); $display("opts: %s %h（采样点 5）", ty, rx[pk]);
    // 命令 G 3：连拍 3 帧
    cmd("G", 8'd3, 0, 0); wait_pkt(ty); $display("连拍应答: %s n=%0d", ty, rx[pk]);
    get_frames;
    // 只抓不传：槽 0、槽 1 各 1 帧，再用 X 一起传回
    gen_on = 1'b1;
    cmd("G", 8'd1, 8'd1, 8'd0); wait_pkt(ty); $display("只抓应答: %s n=%0d", ty, rx[pk]);
    wait_pkt(ty); $display("抓完: %s n=%0d 溢出=%0d", ty, rx[pk], rx[pk+1]);
    cmd("G", 8'd1, 8'd1, 8'd1); wait_pkt(ty); wait_pkt(ty); $display("抓完: %s n=%0d", ty, rx[pk]);
    cmd("X", 8'd0, 8'd2, 8'd0);
    get_frames;
    // 按键 0：单拍
    gen_on = 1'b1;
    @(negedge clk); dut.sim_press = 1'b1; @(negedge clk); dut.sim_press = 1'b0;
    wait_pkt(ty); $display("按键事件: %s 键%0d n=%0d", ty, rx[pk], rx[pk+1]);
    get_frames;
    $display("SDRAM 模型时序错误：%0d", sdm.errs);
    cmd("S", 0, 0, 0); wait_pkt(ty);
    $display("CRC 错行数=%0d（每帧故意错 1 行，应等于已发帧数）FS=%0d", dut.c_crc, dut.c_fs);
    $display("最终状态：FS=%0d FE=%0d LS=%0d ECC错=%0d 最近一帧行数=%0d flags=%h", {rx[pk+4], rx[pk+5], rx[pk+6], rx[pk+7]},
             {rx[pk+8], rx[pk+9], rx[pk+10], rx[pk+11]}, {rx[pk+12], rx[pk+13], rx[pk+14], rx[pk+15]},
             {rx[pk+16], rx[pk+17], rx[pk+18], rx[pk+19]}, {rx[pk+26], rx[pk+27]}, {rx[pk+28], rx[pk+29], rx[pk+30], rx[pk+31]});
    $finish;
  end

  // 发送端：持续发帧
  integer fn = 0;
  initial begin
    #500000;
    forever begin fn = fn + 1; frame(fn); end
  end
  initial begin #400_000_000_000; $display("仿真超时：m=%0d gl=%0d sd.st=%0d rjob=%0d ri=%0d rn=%0d cst=%0d rn_pk=%0d pi=%0d rn=%0d",
    dut.m, dut.gl, dut.fbs.st, dut.fbs.rjob, dut.fbs.ri, dut.fbs.rn, dut.fbs.cst, rn, pi, rn); $finish; end
endmodule
