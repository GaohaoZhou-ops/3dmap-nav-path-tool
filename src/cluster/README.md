# Atlas 停车点 Server 合并任务

该目录是由“示教数据中心 → 合并停车点-Server → 导出”生成的只读计算快照。

## 一键执行

```bash
bash run_cluster.sh
```

脚本会创建隔离的 `.atlas-merge-venv`、安装 `requirements.txt`，校验 `manifest.json`
列出的所有 SHA-256，然后执行近邻聚类、双臂光学位姿 DLS 重规划和最终姿态环境碰撞校验。
计算期间终端会持续显示总体百分比进度条、当前阶段、正在处理的资源/姿态以及累计用时；即使单个
候选位姿耗时较长，进度条旁的活动标记和用时也会持续刷新。在 Slurm 等非交互式任务日志中，
则每跨越 5% 或 15 秒输出一行心跳，便于判断进程仍在运行。

完成后，`output/` 会同时生成：

- `parking-merge-…-result.zip`：推荐带回网页导入；
- `parking-merge-…-result.json`：内容相同的单文件结果。

可选参数：

```bash
bash run_cluster.sh --workers 8
bash run_cluster.sh --skip-collision
```

`--skip-collision` 仅用于诊断，不建议把该模式生成的结果用于正式归档。计算包绑定示教任务、
地图来源 SHA-256、导出环境几何摘要、机器人 URDF/碰撞网格摘要和算法版本。任意一项不匹配，
网页都会拒绝导入。
