export type Arch = 'amd' | 'ecp5'
export type Example = 'xor' | 'adder' | 'counter'

export const ARCHES: readonly Arch[] = ['amd', 'ecp5']
export const EXAMPLES: readonly Example[] = ['xor', 'adder', 'counter']
export const BITS = [0, 1, 2, 3] as const

export const ARCH_NAME: Record<Arch, string> = { amd: 'AMD 7 系列', ecp5: 'Lattice ECP5' }
export const EXAMPLE_NAME: Record<Example, string> = { xor: 'LUT 异或', adder: '4 位加法器', counter: '4 位同步计数器' }

/** 阶段与架构无关；role 在每套架构里各自指向承担该功能的模块。 */
export interface Stage {
  id: string
  name: string
  text: string
  role: string
}

const stage = (id: string, name: string, role: string, text: string): Stage => ({ id, name, role, text })

const bitStages = (): Stage[] =>
  BITS.flatMap((i) => [
    stage(`p${i}`, `第 ${i} 位：传播`, `lut:${i}`, `LUT 按地址读出配置位，得到第 ${i} 位的传播信号 P${i}。`),
    stage(`s${i}`, `第 ${i} 位：和`, `carry:${i}`, `专用异或门算出和位：P${i} ⊕ C${i}。`),
    stage(`c${i}`, `第 ${i} 位：进位`, `carry:${i}`, `进位选择器在 P${i}=1 时传递 C${i}，否则送出生成值，得到 C${i + 1}。`),
  ])

export const STAGES: Record<Example, readonly Stage[]> = {
  xor: [
    stage('input', '输入', 'lut:0', 'A、B 到达 I/O 引脚。'),
    stage('route', '互连', 'lut:0', '开关盒把两个输入送进逻辑块旁的布线通道。'),
    stage('pins', 'LUT 引脚', 'lut:0', '连接盒把通道上的信号接到 LUT 的地址引脚。'),
    stage('config', '配置位', 'lut:0', '地址选中一个配置位，也就是真值表的一行。'),
    stage('branch', 'MUX 分支', 'lut:0', '配置位沿选中的选择器分支逐级到达 LUT 输出。'),
    stage('output', '输出', 'lut:0', '结果经互连到达输出引脚。'),
  ],
  adder: [
    stage('input', '输入', 'lut:0', 'A[3:0]、B[3:0] 到达 I/O 引脚。'),
    stage('route', '互连', 'lut:0', '8 个输入经开关盒和连接盒到达各位的引脚。'),
    stage('cinit', '进位初值', 'cinit', '初始进位 C0=0 进入专用进位链。'),
    ...bitStages(),
    stage('exit', '进位引出', 'exit', '辅助 Slice 把最终进位 C4 从专用进位链送到普通布线。'),
    stage('output', '输出', 'exit', '四个和位与最终进位到达输出引脚。'),
  ],
  counter: [
    stage('feedback', 'Q 反馈', 'ff:0', '当前 Q 离开触发器，沿互连回到 LUT 输入。'),
    stage('cinit', '进位初值', 'cinit', '初始进位为 0，加数 0001 已写入配置位，或接为常量。'),
    ...bitStages(),
    stage('ready', 'D 就绪', 'ff:0', 'Q+1 到达 D。CLK 为低，主锁存跟随“将采样”的值，从锁存保持。'),
    stage('rise', '上升沿采样', 'ff:0', 'CLK 0→1。主锁存关闭并留住采样值，从锁存刚打开，Q 尚未翻转。'),
    stage('update', 'Q 更新', 'ff:0', '从锁存把采样值送到 Q。新 Q 尚未传过加法逻辑。'),
    stage('high', '高电平保持', 'ff:0', '新 Q+1 已回到 D，但主锁存关闭，Q 不再变化。'),
    stage('fall', '下降沿保持', 'ff:0', 'CLK 1→0。主锁存再次跟随输入，从锁存关闭，Q 保持。'),
  ],
}

export function at(example: Example, id: string): number {
  const index = STAGES[example].findIndex((s) => s.id === id)
  if (index < 0) throw new Error(`${example} 没有阶段 ${id}`)
  return index
}
