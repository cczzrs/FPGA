// 取帧（clk100 域）：接收 mipi_csi 的令牌，把一帧缩成 320x200 写入帧缓冲
//   源 1280x800（每令牌 = 4 个水平像素之和）：4x4 平均
//   源  640x400（每令牌 = 2 个水平像素之和）：2x2 平均
`default_nettype none
module frame_build (
  input  wire        clk,
  input  wire        tv,
  input  wire [18:0] tok,
  output wire        tre,
  input  wire        arm,            // 已同步：为 1 时在下一个 FS 开始采集
  output reg         done_t = 1'b0,  // 每完成一帧翻转一次
  output reg  [7:0]  rows = 8'd0,    // 本帧得到的输出行数（<=200）
  output reg  [15:0] src_wc = 16'd0,
  output reg  [15:0] src_lines = 16'd0,
  output reg         capturing = 1'b0,
  // 帧缓冲写口
  output reg         fwe = 1'b0,
  output reg  [15:0] fwa = 16'd0,
  output reg  [7:0]  fwd = 8'd0,
  // 统计
  output reg  [31:0] c_fs, c_fe, c_ls, c_err, c_hs, c_crc,
  output reg  [15:0] last_wc, last_lines,
  output reg  [7:0]  last_dt,
  output reg         fs_t, err_t
);
  initial begin
    c_fs = 0; c_fe = 0; c_ls = 0; c_err = 0; c_hs = 0; c_crc = 0;
    last_wc = 0; last_lines = 0; last_dt = 0; fs_t = 1'b0; err_t = 1'b0;
  end
  assign tre = 1'b1;                 // 每拍都能消费一个令牌
  wire [2:0]  ty = tok[18:16];
  wire [15:0] td = tok[15:0];

  reg        f4 = 1'b1;              // 1：4x4，0：2x2
  reg [15:0] ln = 0;                 // 帧内行号
  reg [8:0]  col = 0;
  reg [15:0] base = 0;               // 当前输出行起始地址 = 行号 * 320
  wire [1:0] vsub = f4 ? ln[1:0] : {1'b0, ln[0]};
  wire [7:0] row  = f4 ? ln[9:2] : ln[8:1];
  wire       vlast = f4 ? (ln[1:0] == 2'd3) : ln[0];
  reg        pend = 1'b0;
  reg        done_pending = 1'b0;      // 本次 arm 已出一帧，等 arm 撤销

  // 纵向累加器：读 -> 寄存 RAM 输出 -> 加并写回，三级流水
  reg [11:0] acc [0:319];
  reg [11:0] acc_q = 0, acc_r = 0;
  reg        s1 = 1'b0, s1_first = 1'b0, s1_last = 1'b0;
  reg [8:0]  s1_col = 0;
  reg [9:0]  s1_v = 0;
  reg [15:0] s1_addr = 0;
  reg        s2 = 1'b0, s2_first = 1'b0, s2_last = 1'b0;
  reg [8:0]  s2_col = 0;
  reg [9:0]  s2_v = 0;
  reg [15:0] s2_addr = 0;
  always @(posedge clk) acc_q <= acc[col];
  always @(posedge clk) begin
    acc_r <= acc_q;
    s2 <= s1; s2_first <= s1_first; s2_last <= s1_last; s2_col <= s1_col; s2_v <= s1_v; s2_addr <= s1_addr;
  end
  wire [11:0] nv = s2_first ? {2'b00, s2_v} : acc_r + {2'b00, s2_v};

  always @(posedge clk) begin
    fwe <= 1'b0;
    s1 <= 1'b0;
    if (s2) begin
      acc[s2_col] <= nv;
      if (s2_last) begin fwe <= 1'b1; fwa <= s2_addr; fwd <= f4 ? nv[11:4] : nv[9:2]; end
    end
    if (!arm) begin pend <= 1'b0; capturing <= 1'b0; end
    else if (!capturing && !pend && !done_pending) pend <= 1'b1;
    if (tv) case (ty)
      3'd1: begin
              c_hs <= c_hs + 1;
              if (capturing && row < 8'd200 && col < 9'd320) begin
                s1 <= 1'b1; s1_first <= (vsub == 2'd0); s1_last <= vlast;
                s1_col <= col; s1_v <= td[9:0]; s1_addr <= base + {7'd0, col};
              end
              col <= col + 9'd1;
            end
      3'd2: begin
              c_fs <= c_fs + 1; fs_t <= ~fs_t; ln <= 16'd0; base <= 16'd0;
              if (pend && arm) begin capturing <= 1'b1; pend <= 1'b0; end
            end
      3'd3: begin
              c_fe <= c_fe + 1; last_lines <= ln;
              if (capturing) begin
                capturing <= 1'b0; done_t <= ~done_t; done_pending <= 1'b1;
                rows <= (row > 8'd200) ? 8'd200 : row; src_wc <= last_wc; src_lines <= ln;
              end
            end
      3'd4: begin c_ls <= c_ls + 1; last_wc <= td; f4 <= (td != 16'd640); col <= 9'd0; end
      3'd5: begin
              ln <= ln + 16'd1;
              if (td[0]) c_crc <= c_crc + 1;
              if (vlast) base <= base + 16'd320;
            end
      3'd6: begin c_err <= c_err + 1; err_t <= ~err_t; end
      3'd7: last_dt <= td[7:0];
      default: ;
    endcase
    if (!arm) done_pending <= 1'b0;
  end
endmodule
