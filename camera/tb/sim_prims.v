// 仿真用的 ECP5 原语行为模型（只用于 iverilog）
`timescale 1ps/1ps
module sim_eclk (input wire i, output wire o); assign o = i; endmodule
module sim_div2 (input wire i, output reg o = 1'b0); always @(posedge i) o <= ~o; endmodule
// IDDRX2F：在 eclk 双沿采样，sclk 上升沿输出最近 4 位，q[0] 为最早
module sim_iddr (input wire d, input wire eclk, input wire sclk, output reg [3:0] q = 4'd0);
  reg [3:0] h = 4'd0;
  always @(posedge eclk or negedge eclk) h <= {d, h[3:1]};
  always @(posedge sclk) q <= h;
endmodule

// SDRAM 行为模型（W9825G6KH 的子集）：CL=3，突发长度 1；读数据在第 3 个时钟沿后 5.4 ns 出现，
// 下一个沿后 2.5 ns 变成 X（模拟 tOH），用来检验读出采样点选得对不对
module sdram_model (
  input wire clk, input wire cke, input wire csn, input wire rasn, input wire casn, input wire wen,
  input wire [1:0] ba, input wire [12:0] a, input wire [1:0] dqm, inout wire [15:0] dq
);
  reg [15:0] mem [0:(1<<21)-1];
  reg [12:0] orow [0:3];
  reg        act [0:3];
  reg [15:0] dout = 16'hxxxx;
  reg        doe = 1'b0;
  assign dq = doe ? dout : 16'hzzzz;
  reg        v1 = 0, v2 = 0, v3 = 0;
  reg [20:0] a1 = 0, a2 = 0, a3 = 0;
  integer errs = 0, i;
  initial for (i = 0; i < 4; i = i + 1) act[i] = 1'b0;
  always @(posedge clk) begin
    v2 <= v1; a2 <= a1; v3 <= v2; a3 <= a2; v1 <= 1'b0;
    dout <= #2500 16'hDEAD;                       // 无效期间给一个错值（用 X 会让比对漏计）
    if (v3) begin dout <= #5400 mem[a3]; doe <= #2500 1'b1; end
    else doe <= #2500 1'b0;
    if (cke && !csn) case ({rasn, casn, wen})
      3'b011: begin if (act[ba]) begin $display("SDRAM：bank %0d 未预充电就激活", ba); errs = errs + 1; end
                    orow[ba] <= a; act[ba] <= 1'b1; end
      3'b101: begin if (!act[ba]) begin $display("SDRAM：读未激活的 bank"); errs = errs + 1; end
                    v1 <= 1'b1; a1 <= {ba, orow[ba][9:0], a[8:0]}; end
      3'b100: begin if (!act[ba]) begin $display("SDRAM：写未激活的 bank"); errs = errs + 1; end
                    mem[{ba, orow[ba][9:0], a[8:0]}] <= dq; end
      3'b010: if (a[10]) for (i = 0; i < 4; i = i + 1) act[i] <= 1'b0; else act[ba] <= 1'b0;
      3'b001: for (i = 0; i < 4; i = i + 1) if (act[i]) begin $display("SDRAM：刷新时 bank %0d 未关", i); errs = errs + 1; end
      default: ;
    endcase
  end
endmodule
