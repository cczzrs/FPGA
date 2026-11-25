# Fabric Atlas · FPGA 结构工作台

此站点包含两个可独立运行的演示项目。Fabric Atlas 的完整 TypeScript 源码位于根目录。另一个 FPGA Floorplan 项目及其独立配置、测试和运行说明位于 [projects/floorplan](projects/floorplan/README.md)，两个首页都提供项目切换链接。

用 Three.js 交互探索 AMD 7 系列与 Lattice ECP5，从芯片阵列下钻到 Slice、LUT 选择器树、进位逻辑和触发器的等效门。三个示例分别演示 LUT 异或、4 位无符号加法和带使能、同步清零的 4 位计数器。

## 本地运行

使用 Node.js 22.18 或更高版本，在此目录执行以下命令。

```sh
npm ci
npm run dev
```

`npm test` 验证电路、时钟边沿、资源树与三维布线。`npm run build` 执行 TypeScript 检查并生成静态站点，`npm run preview` 可在浏览器验证构建结果。

## 探索电路

- 首页左侧是三维视图，右侧是结构导航、电路演示和程序坞。拖动分隔条调整宽度，拖动窗口标题或右下角调整位置与尺寸。程序坞可以找回收起的窗口，布局会保存在当前浏览器。窄屏使用底部程序坞切换窗口。
- 结构树默认展开示例逻辑块及其全部 Slice。其余逻辑块按阵列行查找，还可独立展开存储、DSP、时钟、I/O 和互连分支。点击节点定位到三维结构，拖动旋转，滚轮缩放。使用面包屑返回上级。
- 线路按信号分别着色。点击线路、标签或“线路说明”中的信号，可单独高亮对应路径，查看来源、去向、用途和当前值。“全部线路”恢复演示步骤的高亮。
- 切换输入位可立即改变异或与加法的结果。选择加法器后逐步观察进位，切换架构可对照同一算术位的资源位置。
- 三种演示都显示 CLK 的电平、虚拟频率、周期、最近边沿、上升沿次数与仿真时间。可手动推进到下一边沿。异或与加法使用参考时钟。计数器在上升沿按同步清零、使能的优先级更新 Q，并展示 CLK、D、Q 的波形。
- 点击 LUT 中的选择器可以检查对应层级和索引的输入值。在等效门视图使用单步或门级探针逐门追踪。

芯片总览采用教学阵列，AMD 视图绘出 72 个 CLB，ECP5 视图绘出 77 个 PFU。AMD 的示例 CLB 选用 SLICEM 与 SLICEL，ECP5 的 4 位运算使用两个相邻 Slice。几何位置和时钟速度按教学需要设置。架构依据见 [AMD 7 系列 CLB 手册](https://docs.amd.com/r/en-US/ug474_7Series_CLB/CLB-Overview) 和 [Lattice ECP5 系列数据手册](https://www.latticesemi.com/view_document?document_id=50461)。
