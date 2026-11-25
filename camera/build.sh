#!/bin/bash
# 构建 OV9281 拍照比特流：./build.sh [种子...]
set -e
cd "$(dirname "$0")"
export PATH="$HOME/oss-cad-suite/bin:$PATH"
mkdir -p build
yosys -q -l build/yosys.log -p "read_verilog -sv rtl/cam_top.v rtl/mipi_rx.v rtl/frame_build.v rtl/sdfb.v rtl/pll100.v; synth_ecp5 -top cam_top -json build/cam.json"
seeds="${@:-1 2 3}"
best=""; bestv=-1
for s in $seeds; do
  nextpnr-ecp5 --25k --package CABGA256 --speed 6 --seed "$s" --timing-allow-fail \
    --lpf cam.lpf --json build/cam.json --textcfg "build/cam_s$s.config" > "build/pnr_s$s.log" 2>&1 &
done
wait
for s in $seeds; do
  fails=$(grep -E 'Max frequency for clock' "build/pnr_s$s.log" | tail -4 | grep -c FAIL || true)   # 只看布线后的最终结果
  errs=$(grep -cE '^ERROR' "build/pnr_s$s.log" || true)
  echo "种子 $s：错误 $errs，时序未过 $fails"
  grep -E 'Max frequency for clock' "build/pnr_s$s.log" | tail -4 | sed 's/^/    /'
  if [ "$errs" = 0 ]; then
    score=$(( 100 - fails ))
    if [ "$score" -gt "$bestv" ]; then bestv=$score; best=$s; fi
  fi
done
[ -n "$best" ] || { echo "没有成功的布局布线"; exit 1; }
ecppack --compress "build/cam_s$best.config" build/cam.bit
cp "build/pnr_s$best.log" build/pnr_best.log
echo "已生成 build/cam.bit（种子 $best）"
