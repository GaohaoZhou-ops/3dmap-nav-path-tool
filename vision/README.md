# Vision Pro 空间示教

原生 visionOS App「Atlas 空间示教」，工程入口为 [AtlasVisionTeaching.xcodeproj](AtlasVisionTeaching.xcodeproj)。支持 Apple Vision Pro，包括 M5 设备；最低部署版本 visionOS 2.0。使用 SwiftUI、RealityKit 与 ARKit，不依赖第三方 Swift 包。

## 使用流程

1. 在电脑运行 `./scripts/start.sh`，打开独立示教物体，点击 **iPad / Vision Pro → 准备物体与配对码**。已有任务若已绑定 iPad，请新建传输。
2. Vision Pro 与电脑接入同一局域网，打开 App，允许本地网络。搜索并选择电脑，或输入电脑地址、端口（默认 `21990`）及四位配对码，接收模型。
3. 点击 **进入空间示教**，允许空间感知。观察到青色水平面后，注视该区域并捏合放置；也可沿头部朝向放到已识别水平面，或使用 **放到前方** 手动放置。
4. 模型以底部中心作为放置基准，始终保持 **1:1**。通过每次 1 cm 的平移、偏航、俯仰和翻滚调整位置，确认与现场对齐后点击 **确认校准**。
5. 将任务窗口移到侧面，使用空间控制板。移动到需要的观察位置，调整头部朝向，点击 **记录 Pose**。控制板在走远或转身后会移回附近，也可手动移到面前。小于上一点 10 cm 时需要确认；确认保存的是首次点击时冻结的位姿。支持重命名、删除、调整模型后新建校准段，以及 Mesh / 点云与显示精度切换。
6. 下载后可离线示教。每次采样自动保存，退出任务后可从本地任务恢复。**退出空间、切换任务或定位会话中断后需重新放置校准**，已有 Pose 保留。
7. **完成并保存在本机** 会冻结结果；回到局域网后填写当前电脑地址并同步。也可直接 **完成并同步**。同步先比较设备和电脑的实际模型文件 SHA-256，再上传结果；网络失败可重试同一结果。电脑端点击 **检查完成状态 → 接收示教结果**。

## 位姿含义

- 模型与保存结果采用 `virtual_origin`，米，右手系 Z 向上，与 iPad / 电脑一致。
- Vision Pro 通过 `WorldTrackingProvider.queryDeviceAnchor(atTimestamp:)` 获取头显参考位置与朝向，保存为 `visionpro_head_optical_frame`，虚拟光学轴为 X 向右、Y 向下、Z 向前。
- 换算为 `modelFromHeadOptical = inverse(worldFromModel) × worldFromDevice × diag(1, -1, -1, 1)`。
- 这是**头显参考位姿**，不读取眼球注视方向，不代表透视相机光心，也未包含头显到实际 Zivid / 机器人相机的外参标定。`device.platform=visionOS`、`poseSource=deviceAnchor`、`lidar=false` 表明采样没有使用 iPad 的原始 LiDAR 深度帧。
- M70 视锥是共点、同轴的虚拟观察辅助，范围 0.3–1.3 m；真正用于机器人前仍须完成实际工具 / 相机的外参标定与关节求解。电脑的机器人导出会继续拦截尚未求解的移动设备 Pose。
- 确认后使用本次会话的 WorldAnchor 更新模型位置。不会用上次会话的 AR 世界坐标直接恢复校准，也不会自动声称已完成物体识别或高精度配准。

## 真机接入

1. 使用含 visionOS SDK 且支持设备系统版本的 Xcode，打开 `vision/AtlasVisionTeaching.xcodeproj`，选择 `AtlasVisionTeaching` scheme。
2. 在 Target → Signing & Capabilities 中选择现有开发 Team。Bundle ID 默认为 `com.atlasroute.teaching.vision`，如个人账号要求唯一标识，可修改此 ID。
3. 在 Xcode → Window → Devices and Simulators 与 Vision Pro 建立开发配对，在设备设置中启用 Developer Mode，按系统提示确认。选择该设备后运行 App。
4. 首轮用较小的工件检查网络配对、1:1 尺寸、地面 / 桌面放置、三轴朝向和手动微调，记录至少三个相距超过 10 cm 的 Pose。
5. 检查退出重入必须重新校准；断网后记录、关闭重开后仍能恢复；重新连接网络完成同步，电脑端显示 **Vision Pro 示教**，采集设备为 **Apple Vision Pro**，各点位置、朝向、名称及校准段数一致。
6. 最后再用正式大模型检查双眼显示、温升、长时间跟踪漂移、摘戴 / 应用切换 / 权限拒绝后的恢复与模型锚点稳定性。这些项目需要真机联调，模拟器通过不等于定位精度已经验收。

## 构建与验证

```bash
# 从仓库根目录执行；不访问真实示教任务，网络测试使用临时目录与独立端口。
npm run test:vision
./scripts/check-vision.sh        # Swift / LAN / 协议 + Web + visionOS 真机与模拟器编译
./scripts/check-vision.sh --ui   # 增加模拟器界面流程测试

# 可指定模拟器或日志位置
VISION_SIMULATOR_ID=<UDID> VISION_ARTIFACTS=/tmp/atlas-vision-check ./scripts/check-vision.sh --ui
```

检查脚本生成的真机 `.app` **未签名**，安装到硬件时由 Xcode 使用开发 Team 签名。模拟器中的 **打开本地演练** 使用专门的合成模型和位姿，可测试放置、记录、调整、退出重入、离线恢复。模拟器不能为正式配对任务采样，演练数据在客户端与服务端均禁止同步。

测试入口：

- `vision/Tests/VisionCoreTests.swift`：坐标轴、任意旋转回算、禁止缩放 / 镜像 / 非有限矩阵、锚点微调、实际三角面命中、Mesh / 点云、下载、本地恢复、模型校验与同步重试。
- `tests/vision_teaching_smoke.mjs`：原生 Swift 与实际 LAN 服务往返、设备和轴约定校验、模拟结果拒绝、电脑导入及 ZIP 往返。
- `vision/UITests/AtlasVisionTeachingUITests.swift`：模拟器放置校准、连续记录、取消调整、退出重入和本地恢复。

## 实现范围

与 iPad 工程共享 `TeachingModels`、`TeachingSession`、`ProjectStore`、`LANClient`、Bonjour 发现和 ATLS 模型验证源码。独立的 visionOS Target 使用 RealityKit 渲染，不加载 iPad 的 ARSCNView。旧协议名称和 `/__atlas/ipad/` 路由保留，以兼容已有 iPad App；服务端依据明确的平台及位姿来源校验坐标轴。

模型原文件完整保留；空间显示预算为轻量 / 均衡 / 精细：最多 4 / 12 / 30 万三角面，或 0.8 / 2 / 5 万点。Mesh 使用抽样面及其平均顶点颜色，点云使用小四面体；显示精度不改变示教坐标或模型指纹。最多保存 50,000 个 Pose、1,000 段校准，空间中显示最近 500 个 Pose 标记。当前版本不包含 iPad 专用的原始相机预览、二维码相机扫描或已示教表面覆盖着色。

Apple 接口参考：[ARKit 权限与空间会话](https://developer.apple.com/documentation/visionos/setting-up-access-to-arkit-data)、[头显参考位姿查询](https://developer.apple.com/documentation/arkit/worldtrackingprovider/querydeviceanchor(attimestamp:))。

## 本次预检记录（2026-10-08）

- 环境：Xcode 26.6，visionOS SDK / Simulator 26.5。
- 通过：visionOS Release 真机架构编译（未签名）、模拟器编译、模拟器完整示教流程，以及完成后的只读空间回看。
- 通过：`npm run test:vision`、`test:ipad`、`test:ipad:native`、`test:ipad:qr`、`test:ipad:discovery`、`test:transfer`、Web 生产构建及 iPad 真机架构回归编译。
- 已通过 `simctl` 截图检查模型、任务窗口和空间控制板。真机尚未接入，物理定位精度、实际权限弹窗、锚点稳定性、长时间运行与佩戴交互待硬件联调。
- `test:abx` 的本工程断言已运行到外部契约阶段，完整回归因本机缺少 `../workspace/ABXBrainSystem/tools/web/teaching_store.py` 未完成。该外部项目就绪后可通过 `ABX_BRAIN_ROOT` 指定路径重跑。
