// MIPI CSI-2 接收（2 条数据通道，RAW8），运行在 sclk = MIPI 时钟 / 2
// 输入为 IDDRX2F 每拍 4 位；按 HS 同步字 0xB8（前面 8 个 0）对齐；
// 解析包头（含 ECC 校验），把一行像素按水平 HF 个求和后作为令牌送出。
`default_nettype none

// ---------------------------------------------------------------- 单通道对齐
module mipi_lane (
  input  wire       clk,
  input  wire       unlock,
  input  wire [3:0] nib,      // 默认 nib[0] 为最早到达的位
  input  wire       rev,      // 1：反转 4 位顺序
  input  wire       inv,      // 1：数据取反（P/N 接反）
  output reg  [7:0] dout = 8'd0,
  output reg        dval = 1'b0,
  output reg        locked = 1'b0
);
  wire [3:0] d0 = rev ? {nib[0], nib[1], nib[2], nib[3]} : nib;
  wire [3:0] d  = d0 ^ {4{inv}};
  reg  [23:0] sr = 24'd0;               // 低位为较早的位（CSI-2 字节低位先发）
  always @(posedge clk) sr <= {d, sr[23:4]};

  // 在 sr[k+7:k]（k=8..15）找 0xB8，且其前 8 位全 0
  reg [7:0] m = 8'd0;
  integer i;
  always @(posedge clk)
    for (i = 0; i < 8; i = i + 1)
      m[i] <= (sr[i+8 +: 8] == 8'hB8) && (sr[i +: 8] == 8'h00);

  function [2:0] lowest(input [7:0] v);
    integer j;
    begin
      lowest = 3'd0;
      for (j = 7; j >= 0; j = j - 1) if (v[j]) lowest = j[2:0];
    end
  endfunction

  reg [3:0] off = 4'd8;
  reg       ph  = 1'b0;
  always @(posedge clk) begin
    dval <= 1'b0;
    if (unlock) locked <= 1'b0;
    else if (!locked) begin
      if (|m) begin locked <= 1'b1; ph <= 1'b1; off <= 4'd8 + {1'b0, lowest(m)}; end
    end else begin
      ph <= ~ph;
      if (ph) begin dout <= sr[off +: 8]; dval <= 1'b1; end
    end
  end
endmodule

// ---------------------------------------------------------------- 包解析
// 令牌：{类型[2:0], 数据[15:0]}
//   1 HSUM 水平求和   2 FS 帧开始   3 FE 帧结束   4 LS 行开始(WC)
//   5 LE 行结束       6 ERR 包头 ECC 错({DI, ECC})   7 OTHER 其他长包(DT)
module mipi_csi (
  input  wire        clk,
  input  wire [7:0]  b0, input wire v0,     // 通道 0 字节
  input  wire [7:0]  b1, input wire v1,     // 通道 1 字节
  input  wire        ignore_ecc,
  input  wire        lk0, input wire lk1,   // 两通道锁定状态
  output reg         unlock = 1'b0,
  output reg         tv = 1'b0,
  output reg  [18:0] tok = 19'd0,
  output reg  [31:0] last_hdr = 32'd0,
  // 原始像素令牌（给全分辨率帧缓存）：{类型[1:0], 数据[15:0]}
  //   0 像素对 {第二个, 第一个}   1 FS   2 FE   3 LS（数据 = WC）
  output reg         rtv = 1'b0,
  output reg  [17:0] rtok = 18'd0
);
  // 每通道 4 深 FIFO，吸收两通道锁定时刻的差异
  reg [7:0] f0 [0:3], f1 [0:3];
  reg [1:0] w0 = 0, r0 = 0, w1 = 0, r1 = 0;
  reg [2:0] n0 = 0, n1 = 0;
  localparam H0 = 3'd0, H1 = 3'd1, C1 = 3'd2, C2 = 3'd3, PAY = 3'd4, CRC = 3'd5;
  reg [2:0] ps = H0;
  wire pop = (n0 != 0) && (n1 != 0) && (ps == H0 || ps == H1 || ps == PAY || ps == CRC) && !unlock;
  wire [7:0] a = f0[r0], b = f1[r1];

  always @(posedge clk) begin
    if (unlock) begin
      w0 <= 0; r0 <= 0; n0 <= 0; w1 <= 0; r1 <= 0; n1 <= 0;
    end else begin
      if (v0) begin f0[w0] <= b0; w0 <= w0 + 2'd1; end
      if (v1) begin f1[w1] <= b1; w1 <= w1 + 2'd1; end
      if (pop) begin r0 <= r0 + 2'd1; r1 <= r1 + 2'd1; end
      n0 <= n0 + (v0 ? 3'd1 : 3'd0) - (pop ? 3'd1 : 3'd0);
      n1 <= n1 + (v1 ? 3'd1 : 3'd0) - (pop ? 3'd1 : 3'd0);
    end
  end

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

  reg [7:0]  di = 0, wcl = 0, wch = 0, ec = 0;
  reg        eok = 1'b0;
  reg        fresh = 1'b1;          // 1：刚同步；0：上一个包之后的续读
  wire [15:0] wcw = {wch, wcl};
  wire        px_dt = (di[5:0] == 6'h2A) || (di[5:0] == 6'h2B);   // 像素行包（RAW8 或 RAW10）
  // 包头合法：ECC 对、虚拟通道 0；短包只认 0x00-0x03；RAW8（0x2A）行宽须为 640/1280，
  // RAW10（0x2B，4 像素打包成 5 字节）行宽须为 800/1600；其他长包只在刚同步时接受
  wire hdr_ok = (eok || ignore_ecc) && (di[7:6] == 2'b00) &&
                ((di[5:0] <= 6'h03) ||
                 (di[5:0] == 6'h2A && (wcw == 16'd640 || wcw == 16'd1280)) ||
                 (di[5:0] == 6'h2B && (wcw == 16'd800 || wcw == 16'd1600)) ||
                 (di[5:0] >= 6'h10 && !px_dt && fresh));
  reg [15:0] cnt = 0;
  reg        ispx = 1'b0, hf2 = 1'b0, grp = 1'b0;
  // 长包 CRC：CRC-16，多项式 x^16+x^12+x^5+1（反射 0x8408），初值 0xFFFF，字节低位先算（CSI-2 规定）
  function [15:0] crc8(input [15:0] c, input [7:0] d);
    integer k;
    begin
      crc8 = c;
      for (k = 0; k < 8; k = k + 1) crc8 = (crc8[0] ^ d[k]) ? ((crc8 >> 1) ^ 16'h8408) : (crc8 >> 1);
    end
  endfunction
  reg [15:0] crc = 16'hFFFF;
  reg [9:0]  hs = 0;
  wire [9:0] s = hs + a + b;

  // 真实的 SoT 两通道几乎同时锁定；单通道锁定超过 4 拍视为假同步
  reg [2:0] solo = 3'd0;
  always @(posedge clk) solo <= (lk0 ^ lk1) ? ((solo == 3'd7) ? solo : solo + 3'd1) : 3'd0;
  reg both_d = 1'b0;
  always @(posedge clk) both_d <= lk0 & lk1;
  // 两通道锁定先后差超过 1 拍：至少一条是假同步
  wire solo_kill = (solo == 3'd4) || ((lk0 & lk1) && !both_d && solo >= 3'd2);

  always @(posedge clk) begin
    tv <= 1'b0;
    rtv <= 1'b0;
    unlock <= 1'b0;
    if (solo_kill) begin unlock <= 1'b1; fresh <= 1'b1; ps <= H0; end
    else case (ps)
      H0:  if (pop) begin
             // 包后续读：两通道都是 HS-trail（各自全 0 或全 1）说明这次 HS 传输已结束，重新找同步
             if (!fresh && (a == 8'h00 || a == 8'hFF) && (b == 8'h00 || b == 8'hFF)) begin
               unlock <= 1'b1; fresh <= 1'b1;
             end else begin di <= a; wcl <= b; ps <= H1; end
           end
      H1:  if (pop) begin wch <= a; ec <= b; ps <= C1; end
      C1:  begin
             eok <= (ecc6({wch, wcl, di}) == ec[5:0]) && (ec[7:6] == 2'b00);
             last_hdr <= {di, wcl, wch, ec};
             ps <= C2;
           end
      C2:  begin
             if (!hdr_ok) begin
               // 只统计刚同步后的包头错误；包后续读到的噪声直接丢弃
               if (fresh) begin tv <= 1'b1; tok <= {3'd6, di, ec}; end
               unlock <= 1'b1; fresh <= 1'b1; ps <= H0;
             end else if (di[5:0] < 6'h10) begin
               fresh <= 1'b0;
               if (di[5:0] == 6'h00) begin tv <= 1'b1; tok <= {3'd2, wch, wcl}; rtv <= 1'b1; rtok <= {2'd1, 16'd0}; end
               if (di[5:0] == 6'h01) begin tv <= 1'b1; tok <= {3'd3, wch, wcl}; rtv <= 1'b1; rtok <= {2'd2, 16'd0}; end
               ps <= H0;
             end else begin
               fresh <= 1'b0;
               ispx <= px_dt;
               hf2 <= ({wch, wcl} == 16'd640);
               cnt <= {1'b0, wch, wcl[7:1]};
               grp <= 1'b0; hs <= 10'd0; crc <= 16'hFFFF;
               tv  <= 1'b1;
               tok <= px_dt ? {3'd4, wch, wcl} : {3'd7, 8'd0, 2'b00, di[5:0]};
               rtv <= px_dt; rtok <= {2'd3, wch, wcl};
               ps  <= ({wch, wcl[7:1]} == 15'd0) ? CRC : PAY;
             end
           end
      PAY: if (pop) begin
             cnt <= cnt - 16'd1;
             crc <= crc8(crc8(crc, a), b);
             if (ispx) begin
               rtv <= 1'b1; rtok <= {2'd0, b, a};
               if (hf2 || grp) begin tv <= 1'b1; tok <= {3'd1, 6'd0, s}; hs <= 10'd0; grp <= 1'b0; end
               else begin hs <= s; grp <= 1'b1; end
             end
             if (cnt == 16'd1) ps <= CRC;
           end
      CRC: if (pop) begin
             if (ispx) begin
               tv <= 1'b1; tok <= {3'd5, 15'd0, {b, a} != crc};      // 数据位 0：CRC 错
               rtv <= 1'b1; rtok <= {2'd0, b, a};                    // 收到的 CRC 跟在像素后面存进 SDRAM，主机端再校验
             end
             ps <= H0;
           end
      default: ps <= H0;
    endcase
  end
endmodule

// ---------------------------------------------------------------- 异步 FIFO（令牌跨时钟域）
module tok_fifo #(parameter integer W = 19) (
  input  wire         wclk, input wire we, input wire [W-1:0] wd, output reg ovf = 1'b0,
  input  wire         rclk, output wire rv, output wire [W-1:0] rd, input wire re
);
  reg [W-1:0] mem [0:15];
  reg [4:0] wb = 0, rb = 0;
  reg [4:0] wg = 0, rg = 0;
  reg [4:0] rg_w1 = 0, rg_w2 = 0, wg_r1 = 0, wg_r2 = 0;
  function [4:0] g2b(input [4:0] g);
    begin g2b[4] = g[4]; g2b[3] = g2b[4]^g[3]; g2b[2] = g2b[3]^g[2]; g2b[1] = g2b[2]^g[1]; g2b[0] = g2b[1]^g[0]; end
  endfunction
  wire [4:0] rb_w = g2b(rg_w2);
  wire full = (wb[3:0] == rb_w[3:0]) && (wb[4] != rb_w[4]);
  always @(posedge wclk) begin
    rg_w1 <= rg; rg_w2 <= rg_w1;
    if (we) begin
      if (full) ovf <= 1'b1;
      else begin mem[wb[3:0]] <= wd; wb <= wb + 5'd1; wg <= (wb + 5'd1) ^ ((wb + 5'd1) >> 1); end
    end
  end
  wire [4:0] wb_r = g2b(wg_r2);
  assign rv = (wb_r != rb);
  assign rd = mem[rb[3:0]];
  always @(posedge rclk) begin
    wg_r1 <= wg; wg_r2 <= wg_r1;
    if (re && rv) begin rb <= rb + 5'd1; rg <= (rb + 5'd1) ^ ((rb + 5'd1) >> 1); end
  end
endmodule
