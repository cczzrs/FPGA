/** 页面“依据”面板与 README 列出同一组来源。 */
export const SOURCES: { title: string; url?: string; use: string }[] = [
  { title: 'AMD UG474 v1.9：CLB 结构', url: 'https://docs.amd.com/r/en-US/ug474_7Series_CLB/CLB-Overview', use: 'CLB、Slice、LUT6、存储单元、宽函数选择器' },
  { title: 'AMD UG474 v1.9：进位逻辑', url: 'https://docs.amd.com/r/en-US/ug474_7Series_CLB/Carry-Logic', use: 'LUT A–D 的位序、DI 来源、DMUX 与 COUT' },
  { title: 'AMD UG474 v1.9：ASMBL 架构', url: 'https://docs.amd.com/r/en-US/ug474_7Series_CLB/ASMBL-Architecture', use: '总览按列排布资源' },
  { title: 'AMD UNISIM 仿真模型', url: 'https://github.com/Xilinx/XilinxUnisimLibrary/tree/master/verilog/src/unisims', use: 'LUT6_2、CARRY4、FDRE 的逻辑' },
  { title: 'Lattice FPGA-DS-02012-3.4，第 2.1–2.2 节', url: 'https://www.latticesemi.com/view_document?document_id=50461', use: 'PFU、Slice、端口、按行排布的 EBR 与 sysDSP' },
  { title: 'Yosys ECP5 仿真模型（开源，非 Lattice 官方）', url: 'https://github.com/YosysHQ/yosys/tree/main/techlibs/lattice', use: 'CCU2C、TRELLIS_FF 的逻辑；OFX0/1 端口名' },
  { title: '本机 Yosys 0.71、nextpnr-ecp5 0.11.1 实测', use: '进位引入与引出 Slice 的位置、INIT' },
]
