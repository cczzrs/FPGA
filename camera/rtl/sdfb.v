// 全分辨率帧缓存（clk100 域）：把连续 nfr 帧的原始行数据（RAW8 或打包的 RAW10 字节）写进 SDRAM，再按行读出
// SDRAM：W9825G6KH（4 bank × 8192 行 × 512 列 × 16 位），100 MHz，CL=3，突发长度 1
//   芯片时钟 = clk100 取反（ODDR 输出），命令和写数据在芯片时钟上升沿时已稳定半个周期
// 帧槽：第 n 帧占全局行 n*800 .. n*800+799，最多 20 帧（16000 行），每帧超过 800 行的部分丢弃
// 字地址 A = 全局行号 * 1024 + 像素对序号；列 = A[8:0]，bank = A[10:9]，行 = A[23:11]
// 读出采样点 rsel（8 选 1）：读命令所在沿之后第 4..7 个上升沿（rsel[1:0]），
//   rsel[2]=1 改用下降沿，即第 3.5..6.5 拍；默认 5（4.5 拍）
//   自检命令一次读回 512 个字，8 种采样点同时比对，主机据此选一个全对的
`default_nettype none
module sdfb #(
  parameter integer INIT_WAIT = 20000      // 上电等待 200 us
) (
  input  wire        clk,
  // 原始令牌（来自 tok_fifo）：0 像素对，1 FS，2 FE，3 LS(WC)
  input  wire        rv,
  input  wire [17:0] rt,
  output wire        rre,
  // 抓帧（已同步）
  input  wire        arm,
  input  wire [4:0]  nfr,                // 本次连拍帧数（1..20），arm 拉高前已稳定
  input  wire [13:0] gb0,                // 第一帧写到哪个全局行（= 起始帧槽 * 800），arm 拉高前已稳定
  output reg         fs_t = 1'b0,        // 每帧开始写入时翻转
  output reg         done_t = 1'b0,      // 每帧写完时翻转

  output reg  [15:0] cap_wc = 16'd0,
  output reg  [15:0] cap_lines = 16'd0,
  output reg         ovf = 1'b0,
  // 读一行（已同步的翻转请求）
  input  wire        rd_t,
  input  wire [13:0] rd_line,           // 全局行号 = 帧序号*800 + 行号
  output reg         rd_done_t = 1'b0,
  // 自检（已同步的翻转请求）
  input  wire        tst_t,
  output reg         tst_done_t = 1'b0,
  output reg  [79:0] tst_err = 80'd0,    // 8 个 10 位错误数，[10*k +: 10] 对应 rsel = k
  input  wire [2:0]  rsel,
  // 行缓冲写口
  output reg         lb_we = 1'b0,
  output reg  [9:0]  lb_a = 10'd0,
  output reg  [15:0] lb_d = 16'd0,
  // SDRAM
  output wire        sd_clk,
  output reg         sd_cke = 1'b0,
  output reg         sd_csn = 1'b1,
  output reg         sd_rasn = 1'b1,
  output reg         sd_casn = 1'b1,
  output reg         sd_wen = 1'b1,
  output reg  [1:0]  sd_ba = 2'd0,
  output reg  [12:0] sd_a = 13'd0,
  output reg  [1:0]  sd_dqm = 2'b11,
  inout  wire [15:0] sd_dq
);
`ifdef SIM
  assign sd_clk = ~clk;
`else
  ODDRX1F u_ck (.D0(1'b0), .D1(1'b1), .SCLK(clk), .RST(1'b0), .Q(sd_clk));
`endif

  // ---------------------------------------------------------------- 命令
  localparam [3:0] C_NOP = 4'b0111, C_ACT = 4'b0011, C_RD = 4'b0101, C_WR = 4'b0100,
                   C_PRE = 4'b0010, C_REF = 4'b0001, C_MRS = 4'b0000;
  task cmd(input [3:0] c);
    begin {sd_csn, sd_rasn, sd_casn, sd_wen} <= c; end
  endtask

  reg        dq_oe = 1'b0;
  reg [15:0] dq_o = 16'd0;
  assign sd_dq = dq_oe ? dq_o : 16'hzzzz;

  // ---------------------------------------------------------------- 抓帧：令牌 -> 写 FIFO
  assign rre = 1'b1;
  wire [1:0]  rk = rt[17:16];
  wire [15:0] rdat = rt[15:0];
  reg  [1:0]  cst = 2'd0;               // 0 空闲 1 等 FS 2 采集中 3 等写完
  reg         done_pend = 1'b0;
  reg  [10:0] lcnt = 11'd0;             // 本帧已收到的行数
  localparam [10:0] FL = 11'd800;      // 每个帧槽的行数
  reg  [4:0]  slot = 5'd0;              // 当前帧序号
  reg  [13:0] gbase = 14'd0;            // 当前帧槽的首个全局行
  reg  [13:0] cur = 14'd0;              // 当前全局行号
  reg  [10:0] wcol = 11'd0;             // 当前行内像素对序号

  // 写 FIFO：64 深分布式 RAM（异步读，出栈判断不经过块 RAM 的慢输出）
  reg  [39:0] fm [0:63];                // {字地址[23:0], 数据[15:0]}
  reg  [6:0]  wp = 7'd0, rp = 7'd0;
  wire [6:0]  avail = wp - rp;
  wire        push = rv && rk == 2'd0 && cst == 2'd2 && lcnt != 11'd0 && lcnt <= FL && wcol <= 11'd800;  // 一行最多 1600 字节（RAW10 1280 像素）+ 1 个字的 CRC
  wire        full = avail >= 7'd63;
  wire        start = cst == 2'd0 && arm && !done_pend;
  always @(posedge clk) begin
    if (start) ovf <= 1'b0;
    if (push) begin
      if (full) ovf <= 1'b1;
      else begin fm[wp[5:0]] <= {cur, wcol[9:0], rdat}; wp <= wp + 7'd1; end
    end
  end

  // ---------------------------------------------------------------- 主状态机
  localparam S_INIT = 4'd0, S_IDLE = 4'd1, S_WAIT = 4'd2, S_REF = 4'd3, S_WACT = 4'd4, S_WR = 4'd5,
             S_END = 4'd6, S_PRE = 4'd7, S_RACT = 4'd8, S_RD = 4'd9, S_TACT = 4'd10, S_TWR = 4'd11,
             S_DRAIN = 4'd12;
  reg [3:0]  st = S_INIT, st_next = S_INIT;
  reg [15:0] tc = 16'd0;                // 等待计数
  reg [3:0]  ini = 4'd0;                // 初始化步骤
  reg [9:0]  rcnt = 10'd0;              // 刷新计时
  wire       ref_due = rcnt >= 10'd700;   // 7.8 us 一次，留余量
  reg [14:0] orow = 15'd0;              // 打开的 {行, bank}

  wire [39:0] fm_head = fm[rp[5:0]];
  wire        pop = (st == S_WR) && avail != 7'd0 && fm_head[39:25] == orow && !ref_due;
  always @(posedge clk) if (pop) rp <= rp + 7'd1;
  wire [23:0] h_a = fm_head[39:16];

  // 读任务
  reg        rjob = 1'b0, rtest = 1'b0;
  reg [23:0] rbase = 24'd0;
  reg [9:0]  rn = 10'd0, ri = 10'd0;
  wire [23:0] r_a = rbase + {14'd0, ri};
  reg [1:0]  rq_s = 2'd0, tq_s = 2'd0;
  reg        rq_p = 1'b0, tq_p = 1'b0;
  reg [9:0]  ti = 10'd0;                // 自检写序号
  function [15:0] pat(input [9:0] i);
    pat = {i[7:0] ^ 8'h5A ^ {i[8], 7'd0}, ~i[7:0]};
  endfunction

  // 读出流水：标记 {有效, 序号}，与数据同拍移动
  reg [10:0] tag [0:6];
  reg [15:0] cp0 = 16'd0, cn = 16'd0, cn0 = 16'd0;
  always @(negedge clk) cn <= sd_dq;
  always @(posedge clk) begin cp0 <= sd_dq; cn0 <= cn; end
  reg [10:0] tag_in = 11'd0;
  integer k;
  always @(posedge clk) begin
    tag[0] <= tag_in;
    for (k = 1; k < 7; k = k + 1) tag[k] <= tag[k-1];
  end
  wire [10:0] tsel = tag[3 + rsel[1:0]];
  wire [15:0] dsel = rsel[2] ? cn0 : cp0;
  always @(posedge clk) begin
    lb_we <= tsel[10] && !rtest;
    lb_a  <= tsel[9:0];
    lb_d  <= dsel;
  end
  // 自检：8 种采样点同时比对
  genvar g;
  generate for (g = 0; g < 8; g = g + 1) begin : chk
    wire [10:0] tg = tag[3 + (g & 3)];
    wire [15:0] dg = (g >= 4) ? cn0 : cp0;
    always @(posedge clk)
      if (st == S_TACT && ti == 10'd0) tst_err[10*g +: 10] <= 10'd0;
      else if (rtest && tg[10] && dg != pat(tg[9:0]) && tst_err[10*g +: 10] != 10'h3FF)
        tst_err[10*g +: 10] <= tst_err[10*g +: 10] + 10'd1;
  end endgenerate

  always @(posedge clk) begin
    cmd(C_NOP);
    dq_oe <= 1'b0;
    tag_in <= 11'd0;
    rcnt <= (rcnt == 10'h3FF) ? rcnt : rcnt + 10'd1;
    rq_s <= {rq_s[0], rd_t}; tq_s <= {tq_s[0], tst_t};
    if (rq_s[1] != rq_p) begin rq_p <= rq_s[1]; rjob <= 1'b1; rtest <= 1'b0; ri <= 10'd0;
                               rbase <= {rd_line, 10'd0}; rn <= cap_wc[10:1] + 10'd1; end   // 像素 + 行尾 CRC

    // 抓帧控制
    if (!arm) begin done_pend <= 1'b0; if (cst == 2'd1) cst <= 2'd0; end   // 超时撤销
    if (start) begin cst <= 2'd1; slot <= 5'd0; gbase <= gb0; end
    if (rv) case (rk)
      2'd1: if (cst == 2'd1) begin cst <= 2'd2; lcnt <= 11'd0; fs_t <= ~fs_t; end
            else if (cst == 2'd2) begin cst <= 2'd3; cap_lines <= {5'd0, lcnt > FL ? FL : lcnt}; end   // 丢了 FE：到下一个 FS 为止
      2'd3: if (cst == 2'd2) begin
              cur <= gbase + {3'd0, lcnt}; wcol <= 11'd0; cap_wc <= rdat;
              if (lcnt != 11'd1024) lcnt <= lcnt + 11'd1;
            end
      2'd2: if (cst == 2'd2) begin cst <= 2'd3; cap_lines <= {5'd0, lcnt > FL ? FL : lcnt}; end
      default: if (push) wcol <= wcol + 11'd1;
    endcase

    case (st)
      S_INIT: begin
        sd_cke <= 1'b1;
        if (tc != 16'd0) tc <= tc - 16'd1;
        else case (ini)
          4'd0: begin tc <= INIT_WAIT; ini <= 4'd1; end
          4'd1: begin cmd(C_PRE); sd_a[10] <= 1'b1; tc <= 16'd4; ini <= 4'd2; end
          4'd2, 4'd3, 4'd4, 4'd5, 4'd6, 4'd7, 4'd8, 4'd9:
                begin cmd(C_REF); tc <= 16'd10; ini <= ini + 4'd1; end
          4'd10: begin cmd(C_MRS); sd_ba <= 2'd0; sd_a <= 13'h030; tc <= 16'd4; ini <= 4'd11; end   // CL=3，BL=1
          default: begin sd_dqm <= 2'b00; rcnt <= 10'd0; st <= S_IDLE; end
        endcase
      end
      S_IDLE: begin
        if (ref_due) begin cmd(C_REF); rcnt <= 10'd0; tc <= 16'd8; st <= S_WAIT; st_next <= S_IDLE; end
        else if (tq_s[1] != tq_p) begin tq_p <= tq_s[1]; ti <= 10'd0; st <= S_TACT; end
        else if (rjob && ri != rn) st <= S_RACT;
        else if (rjob) begin tc <= 16'd10; st <= S_DRAIN; end
        else if (avail >= 7'd16 || (avail != 7'd0 && cst == 2'd3)) st <= S_WACT;
        else if (cst == 2'd3 && wp == rp) begin
          done_t <= ~done_t;
          if (slot + 5'd1 < nfr) begin slot <= slot + 5'd1; gbase <= gbase + {3'd0, FL}; cst <= 2'd1; end   // 紧接着抓下一帧
          else begin cst <= 2'd0; done_pend <= 1'b1; end
        end
      end
      S_WAIT: if (tc == 16'd0) st <= st_next; else tc <= tc - 16'd1;
      // 写：打开 fm_head 所在行，连续写到 FIFO 空、换行或该刷新
      S_WACT: begin
        cmd(C_ACT); sd_ba <= h_a[10:9]; sd_a <= h_a[23:11]; orow <= h_a[23:9];
        tc <= 16'd1; st <= S_WAIT; st_next <= S_WR;
      end
      S_WR: if (pop) begin
              cmd(C_WR); sd_a <= {4'd0, h_a[8:0]}; dq_o <= fm_head[15:0]; dq_oe <= 1'b1;
            end else begin tc <= 16'd3; st <= S_END; end
      S_END: if (tc == 16'd0) begin cmd(C_PRE); sd_a[10] <= 1'b1; tc <= 16'd1; st <= S_WAIT; st_next <= S_IDLE; end
             else tc <= tc - 16'd1;
      // 读：每段最多 128 个字，段间回到空闲以便刷新
      S_RACT: begin
        cmd(C_ACT); sd_ba <= r_a[10:9]; sd_a <= r_a[23:11];
        tc <= 16'd1; st <= S_WAIT; st_next <= S_RD;
      end
      S_RD: begin
        cmd(C_RD); sd_a <= {4'd0, r_a[8:0]}; tag_in <= {1'b1, ri};
        ri <= ri + 10'd1;
        if (ri + 10'd1 == rn || r_a[6:0] == 7'h7F) begin tc <= 16'd3; st <= S_END; end
      end
      S_DRAIN: if (tc == 16'd0) begin
                 rjob <= 1'b0;
                 if (rtest) tst_done_t <= ~tst_done_t; else rd_done_t <= ~rd_done_t;
                 rtest <= 1'b0; st <= S_IDLE;
               end else tc <= tc - 16'd1;
      // 自检：在全局行 16383（帧槽之外，bank 2 行 8191）写 512 个字，再按读任务读回
      S_TACT: begin
        cmd(C_ACT); sd_ba <= 2'd2; sd_a <= 13'h1FFF;
        tc <= 16'd1; st <= S_WAIT; st_next <= S_TWR;
      end
      S_TWR: begin
        cmd(C_WR); sd_a <= {4'd0, ti[8:0]}; dq_o <= pat(ti); dq_oe <= 1'b1;
        ti <= ti + 10'd1;
        if (ti == 10'd511) begin
          tc <= 16'd3; st <= S_END;
          rjob <= 1'b1; rtest <= 1'b1; ri <= 10'd0; rbase <= {14'h3FFF, 10'd0}; rn <= 10'd512;
        end
      end
      default: st <= S_IDLE;
    endcase
  end
endmodule
