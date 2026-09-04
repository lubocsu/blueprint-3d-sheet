[English](README.md) | **简体中文**

# blueprint-3d-sheet

把一张二维图纸、CAD 文件、照片或一段文字说明，变成**一份自包含的交互式三维工程图**
—— 正投影视图、带引线的编号标注、尺寸标注、剖切视图、完整爆炸视图、实时仪表读数和
动画运动，全部装在一个离线的 `index.html` 里。

[**在线演示 →**](https://lubocsu.github.io/blueprint-3d-sheet/)

![渲染成制图页面的主战坦克爆炸视图](docs/images/tank-exploded.webp)

```
图纸 / 说明 ──▶ AssemblySpec (JSON) ──build──▶ Three.js 场景 ──▶ 一个 index.html
                     这是契约              确定性构建            自包含
                 可校验 · 可手改 · 可复现
```

中间这份 spec 就是整个设计的关键：作者输出的是**数据，而不是代码**，所以一份图纸可以
被 schema 校验、用密度标准衡量、手工修正，并确定性地重建。任何三维物体 —— 机械、建筑、
家电、容器、仪器 —— 都走同一条路径。

| | |
|---|---|
| ![剖切视图](docs/images/tank-section.webp) | ![星型发动机爆炸视图](docs/images/radial-exploded.webp) |

## 作为 Claude Code 插件安装

```bash
/plugin marketplace add lubocsu/blueprint-3d-sheet
```

然后

```bash
/plugin install blueprint-3d-sheet@blueprint-3d-sheet
```

装好后 Claude 就有了一个 `blueprint-3d-sheet` skill：它会先判断你给的材料够不够细，
再撰写 spec、过质量门、构建、并验证结果。详见
[`skills/blueprint-3d-sheet/SKILL.md`](skills/blueprint-3d-sheet/SKILL.md)。

## 或者独立使用

```bash
git clone https://github.com/lubocsu/blueprint-3d-sheet
cd blueprint-3d-sheet && npm install
node bin/b2d.mjs build examples/mbt-mk6/spec.json --out out/mbt-mk6
```

打开 `out/mbt-mk6/index.html`。不需要服务器，不联网，没有外部资源。

`npm install` 会通过 puppeteer 拉一个 Chromium（约 300 MB），它负责渲染验证用的截图。
想跳过：

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm install
```

撰写 spec、`validate` 和 `build` 在轻装模式下都能用；只有 `selftest` 和 `dev/` 下的两个
检查需要浏览器。之后随时可以用 `npx puppeteer browsers install chrome` 补上。
**不要**用 `npm install --omit=optional` —— 它会连带砍掉 esbuild 自己的平台二进制，
安装会直接失败。

## 什么会联网

产出的页面永远不会：没有请求、没有外部字体、没有统计、没有遥测。CI 每次推送都会断言这
一点，部署环节也会拒绝发布任何带外部 URL 的页面。

工具链这边，正常使用中只有一件事会联网：`npm install` 可能下载 Chromium（见上）。
撰写、`validate`、`build`、`selftest` 全部离线，不需要任何凭据。

仓库里还有一部分**未完成**的代码，在被显式调用时*会*发起请求 ——
见[本版本未包含的内容](#本版本未包含的内容)。

## 命令

```bash
b2d validate <spec.json> [--strict]                  # schema + 语义 + 密度门
b2d build <spec.json>    [--out dir] [--no-minify] [--embed-font f.woff2] [--force]
b2d selftest <spec.json> [--out dir] [--shots dir]   # 无头渲染每个视图/运动 + 页面断言
b2d serve                [--port 5178]               # 开发用静态服务器
```

CLI 里还有 `ingest`、`research`、`bundle` 三条命令。它们尚未完成，这里刻意不作说明 ——
见[本版本未包含的内容](#本版本未包含的内容)。

`--strict` 会把偏软的不足项（正投影视图太少、页面动起来的部分太少、数字无法追溯）
从警告提升为错误。`--force` 让没过门的 spec 照样构建，手工迭代时正需要这个。

## 为什么中间要有一份 spec

模型输出的是**数据，不是代码**。这一个决定支撑了其余所有事情：spec 可以被 schema 校验、
用密度标准衡量、手工修正、做 diff、重放。渲染器从不需要信任生成出来的 JavaScript，
而且可以对着一份已提交的 spec 离线开发。

## 让它通用的四件事

参考样例里所有跟具体主题相关的东西（`FIRE`、`SKIRTS`、炮塔方位角）都是数据。除了注释和
原型词汇表 —— 那本来就是一本领域词典 —— "炮塔"这个词在 `src/` 里一次都没出现过：没有任何
构建器、渲染器或运行时对它做分支判断。

**1. 驱动量与通道。** 一份 spec 声明具名标量（`speed`、`rpm`、`openness`）。零件把动画
通道绑定到这些量的表达式上。控制台按钮推动驱动量的目标值，仪表行打印驱动量表达式。
坦克的 `DRIVE`、涡轮的 `SPIN`、舱门的 `OPEN`，用的是同样十个原语：

`spin · oscillate · reciprocate · articulate · pathFollow · impulse · visibility · explode · emit · flow`

**2. 用制图剖面线做材质系统。** ISO 128 / ANSI Y14.2 已经规定了各种材质在图纸上怎么读，
所以 `metal` 是 45° 交叉线，`casting` 是点画，`glass` 是稀疏断续斜线，`masonry` 是砌块，
一共十二种材质。默认情况下这些**只用在剖切面上** —— 实体表面统一用参考样例那种单一交叉
线。见下面的*渲染*一节。

**3. 细节装饰器。** 真实图纸的密度大部分来自紧固件、百叶、格栅和花纹板。十二个程序化生成
器（`boltCircle`、`louvre`、`rivetRow`、`perforation` 等）把一行 spec 变成几百个看起来
正确的特征。

**4. 原型 + 密度门。** `src/ingest/archetypes.mjs` 告诉模型每一类主题实际上是怎么拆解的
—— 八个原型（`vehicle`、`rotating-machine`、`mechanism`、`structure`、`appliance`、
`vessel`、`aircraft`、`instrument`）外加一个 `generic` 兜底。`src/spec/richness.mjs` 随后
*强制执行*结果：按原型缩放的零件数量、每个零件都要有注释、最少的标注数、尺寸数、视图数、
运动数、仪表数和细节数。单薄的 spec 会被驳回，并附上缺什么的清单，直接回灌去修。
正是这套机制，让任意主题不至于产出八个无聊的方块。

## 知道图纸不知道什么

密度门能强迫每个零件都带一条注释，却无法判断那条注释是否**属实** —— 而一张写满自信的
编造数字的图纸，比一张稀疏但诚实的图纸更糟。三个阶段来堵这个口子，且没有一个会让构建失败。

**证据评分**（`src/ingest/evidence.mjs`）把"说明够不够长"换成七条轴 ——
`identity · scale · decomposition · internals · kinematics · materials · geometry`
—— 每条打 0..1 分，并按该主题原型实际要求的权重加权。一个压力容器如果对内部只字未提，
那是严重证据不足；同样状态的一个支架则完全没问题。它的输出不是一个判决，而是一份
**缺口清单**，这正是让追问能有的放矢、而不是笼统重问的原因。确定性、离线、便宜：
决定要不要问模型这件事本身，不需要问模型。

补上缺口是人的动作，不是自动动作：重读已有材料、问知道答案的人，或者把该数字记为未知。
缺口清单给你的是一个具体问题，而不是一句笼统的"再给点资料"。

这道门只升级**一次**。当返回的 spec 在某处单薄，且读起来像是缺**知识**而不是 spec 写坏了
—— 比如一个里面空无一物的剖视图 —— 门会指名这个缺口，而不是让模型"再努力一点"，因为后者
只会招来更多编造。标注太少不会触发升级；那是偷懒，不是无知。

**接地度**（`src/spec/grounding.mjs`）随后开始计数。图纸声称的每一个数字都会被提取出来、
按单位族归一（所以 `7.7 m` 能匹配上档案里的 `7700 mm`），再和档案、说明、CAD 图纸上的
文字里实际存在的数字做匹配。比值写进 `meta.grounding`，低于 25% 时门会明说。它衡量的是
一个数字是否**可追溯**，不是它是否正确，也不是它有没有挂在正确的零件上 —— 报告里的措辞
之所以用"可追溯"，正是这个原因。它抓的是那种否则完全看不见的失败：一整张图的自信数字，
全都无处可查。

来源信息最终落在 spec 自身上：`meta.researched`、`meta.references`、`meta.grounding`。
标志**缺失**表示是手工撰写的，不予干预；只有显式的 `false` 才表示 ingest 跑过但什么都没核实。

## 标注层

标注在这里是一个**三维**问题，而且是被*解决*了，不是被*跟踪*：

- **延迟重解。** 任何改变画面的操作 —— 切视图、开关运动、旋转、缩放、改变窗口大小 ——
  都会让标注层淡出并冻结。画面安静约 400 ms 之后，整个布局重解一次并淡入。你在移动图纸
  的时候，不会有任何东西在画面上乱扫。`dev/smoothness.mjs` 在一次旋转过程中、2400 个采样上
  报告的标注位移是 **0.0 px** —— 中位数、p99 和最大值都是。
- **引线出点在零件上，而且会滑动。** 每个零件的表面在构建时被采样成一组带法线的候选点；
  每次重解都会挑出朝向相机、且位于气泡将要占据那一侧的那个点。旋转模型，引线就绕着零件走。
  `dev/anchor-check.mjs` 会实测：`radial-engine` 上 12/12 个锚点发生了迁移，`mbt-mk6` 上
  10/16 —— 其余那些零件的可见面在探针的视角摆动范围内几乎不变，此时保持不动才是正确答案。
- **引线无视运动零件。** 锚点在零件坐标系中、在动画通道**之上**求解，所以旋转的负重轮或
  往复的活塞永远不会拖着自己的引线走 —— DRIVE 和 CRUISE 运行时实测 **0.00 px**。爆炸是
  刻意的例外：分离出去的零件要把引线一起带走，否则你分不清哪块是哪块。
- **绝不压在图上。** 引线槽位于投影轮廓之外，且槽的走线会扣除面板占用的那些条带。
- **有序，但不呆板。** 成员按锚点位置排序（这同时让引线不可能交叉），按子系统聚成簇、
  簇间留空，再按被锚特征的深度分三个泳道。同一泳道的气泡精确对齐；整条引线槽是一段阶梯，
  而不是一根死直的柱子。
- **引线是两段式**：从气泡出来一段水平肩线，再一段直线连到锚点上的圆点 —— 参考样例用的
  正是这种画法。

`callout.point` 是关于挂在零件哪个位置的**提示**，不是硬坐标 —— 求解器会待在它附近，但
仍然会滑动。`callout.instance` 用来指定挂在实例化零件的哪一个副本上。

## 视图

正投影视图会变成**图纸页**：图例和仪表面板让位、点划线基准中心线出现、投影阴影和透视网格
消失，模型按自身投影轮廓缩放到合适大小，而不是用一个固定距离。

尺寸标注是青色的**世界空间几何体**，不是平面叠加层 —— 它们随透视倾斜，箭头会透视缩短。
只有标签留在屏幕空间，且无论标注线多陡都保持水平。每个尺寸只出现在读得通的视图里：
长度在侧视/俯视，高度在侧视/正视，宽度在正视/俯视，由它所测的轴自动推导。

## 渲染

屏幕空间剖面线，不用贴图：线距由 `gl_FragCoord / devicePixelRatio` 算出，所以在曲率、
深度和显示器像素密度变化时都保持恒定 —— 与参考样例完全一致。明暗被量化成四档密度，
就像制图员挑剖面线那样。

**一种交叉线，不是十二种。** 参考样例对所有材质都用单一的 45° 交叉线，只改变密度，
所以那就是默认值。逐材质的图案保留给**剖切面**，那才是制图标准真正赋予它们的职责 ——
这样一个剖面就能区分钢、混凝土和玻璃。设 `style.materialHatch: "per-material"` 可以让
所有表面都用各自图案。

地面阴影是真实几何体沿光线方向的**真平面投影**，不是轮廓近似：它会显示凹陷，并跟随模型
做的每一件事 —— 车体起伏、炮塔回转、履带行进、爆炸时零件飞散。对超大装配体，
`style.shadow` 可以退回到廉价的静态包络。

轮廓线用 `EdgesGeometry` + `LineSegments2` 实现恒定屏幕宽度，不是后处理。剖视图用平面裁剪
并强制剖切面使用密集剖面线。"正投影"视图是通过把 FOV 补间降到约 2° 同时后拉相机达成的，
这样能收敛到平行投影，又不会有切换相机时的跳变。

**爆炸视图带着自己的轨迹线。** 在印刷的爆炸装配图上，每个零件都用一条细断线连回它出来的
那个孔位；没有这些线，视图就只是一堆零件的云，而不是一份拆解说明。整个装配体用一个
`LineSegments2`，每个零件实例两个顶点，每帧在世界空间原地重写
（`src/render/explode-trace.mjs`）。`dev/explode-check.mjs` 断言了爆炸视图最容易造假的
那件事 —— 它是真的**散开**，而不只是整体膨胀：在 `mbt-mk6` 上，平均两两间距 ×2.31、
平均埋没度 48% → 5.5%、包裹度 20% → 0%，且全部 16 个内部零件在 ISO 视图下隐藏、
在 EXPLODE 下显现。

## 目录结构

```
bin/b2d.mjs           CLI
src/spec/             schema.json、校验、密度门、接地度、归一化、
                      表达式语言、爆炸参与度
src/build/            几何（15 种形状）、CSG、细节装饰器、装配、边线
src/render/           剖面线着色器、材质表、场景、页面框架、标注、尺寸、
                      爆炸轨迹线、应用入口
src/runtime/          驱动量、十个通道、视图、交互
src/ingest/           原型、证据评分、调研、prompt、凭据、
                      模型客户端 + 修复循环、栅格/矢量读取
src/emit/             esbuild 打包 -> 单文件内联 HTML
templates/            页面骨架 + 样式表
examples/             mbt-mk6（对齐参考样例）、radial-engine（通用性）、smoke（引擎自测）
dev/                  剖面线着色器实验台、无头截图、平滑度 + 锚点 + 爆炸探针、
                      离线证据与调研检查、静态服务器
```

每个探针都做断言，不合格就以非零退出码结束 —— 这样它才是真的在守着上文那项主张，
而不只是打印一个没人看的数字：

```bash
node dev/smoothness.mjs   out/mbt-mk6/index.html               # 旋转期间的标注位移
node dev/anchor-check.mjs out/mbt-mk6/index.html --motion drive
node dev/explode-check.mjs out/mbt-mk6/index.html              # 确实散开；内部件显现
node dev/evidence-check.mjs    # 充分性、调研请求、接地度、只升级一次
node dev/research-check.mjs    # 触发条件、缓存、档案渲染、降级路径
```

最后两个刻意**不**覆盖真实联网搜索：那需要凭据，而在没跑过的情况下断言它能用，
恰恰就是这个功能本身要防止的那种未经核实的声称。

## 开发

仓库是唯一真源。把它注册成本地 marketplace，插件就从你自己的检出构建，
而不是从 GitHub 拉：

```powershell
claude plugin marketplace add C:\path\to\blueprint-3d-sheet
claude plugin install blueprint-3d-sheet@blueprint-3d-sheet
```

**安装动作会拍一张快照。** 插件被拷进 `~/.claude/plugins/cache/`，并钉死在安装那一刻的
HEAD 提交上 —— 改仓库*不会*改变 Claude 加载的内容，提交了也不会。由此有两条结论：

- `claude plugin update` 比较的是**版本号**，所以无论代码走出多远，它都会回答"已是最新版"。
  只有 `plugin.json` 里的版本变了，它才会真的刷新。
- 想在同一版本号下装入当前代码，就卸载再装一次。这就是迭代循环：

```powershell
claude plugin uninstall blueprint-3d-sheet@blueprint-3d-sheet
claude plugin install blueprint-3d-sheet@blueprint-3d-sheet -y
```

安装拷贝的是**工作区**，未提交的改动也一并带上，所以一个实验不必先提交就能试。
`installed_plugins.json` 里记的 `gitCommitSha` 只是"安装时 HEAD 恰好是什么"的标签 ——
它不是拷贝的来源，工作区不干净时这个标签会误导人。

然后重启会话 —— skill 是在会话启动时读取的。

fork 本仓库后若想要演示站点，需在 **Settings > Pages > Source** 里手工选一次
**GitHub Actions**。workflow 里虽然让 action 自行开启 Pages，但那需要带 Pages-write
权限的 token，默认的 `GITHUB_TOKEN` 没有。

日常循环，PowerShell 写法（`&&` 要 PowerShell 7；5.1 上用 `;`）：

```powershell
node scripts/check-manifests.mjs; if ($?) { node scripts/check-readmes.mjs }
node bin/b2d.mjs validate examples/mbt-mk6/spec.json --strict
git add -A; git commit -m "..."; git push
```

bash 写法：

```bash
node scripts/check-manifests.mjs && node scripts/check-readmes.mjs
node bin/b2d.mjs validate examples/mbt-mk6/spec.json --strict
git add -A && git commit -m "..." && git push
```

本地 marketplace 服务的是**工作区**，包含你尚未提交的改动。发版前先验证一份干净克隆，
免得"我这儿能跑"其实是靠某个没提交的文件撑着。

推送到 `main` 会部署演示站点，所以 `main` 一坏，线上 demo 就跟着坏。
要改渲染这类容易出事的地方，请开分支。

## 示例

| | 零件数（含实例） | 证明了什么 |
|---|---|---|
| `mbt-mk6` | 51 → 244 | 对齐参考样例：16 个标注、39 个细节、7 个视图、每个零件都有注释 |
| `radial-engine` | 23 → 117 | 通用性：相位相差 40° 的往复活塞、剖视图、六种材质 |
| `smoke` | 14 → 24 | 所有通道类型集中在一处；刻意低于密度门 |

`radial-engine` 才是真正的验收测试 —— 一个在词汇允许范围内离车辆最远的主题，经由完全
相同的引擎渲染。`smoke` 预期会*通不过* `validate`；那次失败就是密度门自己的测试。

## 扩展

- **新主题** → 写一份 spec。不改任何代码。
- **新领域知识** → 往 `src/ingest/archetypes.mjs` 加一条：它的指导文字、逐轴的 `demand`
  权重，以及证据评分用来比对输入的零件 / 内部件 / 运动词汇。
- **新形状** → 往 `src/build/geometry.mjs` 加一个构建器，并在 schema 的 shape 联合类型里
  加一个分支。
- **新材质** → 往 `src/render/hatch-material.mjs` 加一个图案分支，并在 `MATERIAL_INDEX`
  里加一条。

## 环境要求

Node 20+。ffmpeg 需在 PATH 上，用于缩小图纸；`@resvg/resvg-js` 是可选的：装了它 SVG 会
额外被栅格化，不装则矢量路径只走文本，同样能用。

`validate`、`build` 和 `selftest` 不需要任何凭据。

## 本版本未包含的内容

**从网络收集资料这件事尚未完成，不是本版本的功能。** 仓库确实带着这部分代码 ——
`src/ingest/bundle.mjs` 能下载你提供的 URL，`src/ingest/research.mjs` 能调用带搜索能力的
模型 —— 所以在这里如实披露，而不是藏起来。但是：

- `bundle` 只对着一个本地测试服务器跑过（`dev/gather-check.mjs`，24 条断言）。
  它从未对真实来源运行过。
- `research` 一次都没跑过；开发机上没有任何凭据。

两者都没有被写成工作流，都无法从 skill 里触达，也都不应被依赖。请视为进行中的工作。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

所有依赖都是宽松许可：three、esbuild、ajv、ajv-formats、dxf-parser、three-bvh-csg 和
Anthropic SDK 是 MIT；puppeteer 是 Apache-2.0。
