# tts-voice-clone

从**单个角色的日文语音素材**（ASMR 音声 + 游戏语音）出发，训练一个能用该音色朗读任意文本（重点：中文）的 TTS 系统，**全程本地/自建部署，不发布任何训练素材或模型权重**。

---

## 结论先行

| 问题 | 答案 |
|---|---|
| 能不能做到"输入任意文本用这个音色念出来"？ | **能。** |
| 需要从零训练 TTS 吗？ | **不需要，也不现实。** 用少样本微调 |
| 日文素材能合成中文吗？ | **能**，但会有跨语言韵律残留（详见下方"口音"） |
| 数据要多少？ | 几秒可零样本；**5–30 分钟**可微调；你的素材量远超所需 |
| 本地方案？ | GPT-SoVITS **v2ProPlus** + 5060 Ti 16G（训练）/ M2 Mac（推理） |

---

## 为什么是 v2ProPlus

官方 wiki 的版本特性对比里有一条决定性的说明：

> v1/v2 和 v2Pro 系列是同样的特性，v3/v4 是同样的特性。音质一般的训练集用 v1/v2/v2Pro 能得到不错的效果，但是**用 v3/v4 不行**。

原因是 v3/v4 的 S2 采用"基于参考音频扩散补全"，**合成语气音色更偏向参考音频而非训练集整体**。混合质量数据集（游戏语音 + ASMR 干声）会把这种不一致放大。

官方中文 benchmark（SeedTTS 测试集）：

| 版本 | WER ↓ | SIM ↑ |
|---|---|---|
| v2 | 0.017 | 0.549 |
| v3 | 0.014 | 0.702 |
| v4 | 0.013 | 0.735 |
| **v2ProPlus** | **0.016** | **0.737** |
| GT（真人上限） | 0.013 | 0.750 |

v2ProPlus 的 SIM **0.737 已贴近真人上限 0.750**，硬件需求与 v2 同档，原生 48k 输出。

> ⚠️ SIM 超过 0.750 没有意义。任何声称"相似度 0.9"的说法都是误导——这是官方 wiki 的原话。

---

## 数据分层策略（本方案的核心）

### 有剧本时：文本为准（推荐）

**这是本次在真实素材上得到的最重要的一条经验。**

最初用纯声学判据（低频能量 / 零交叉率）区分"正常说话"与"气声"，
在 4329 个真实游戏语音文件上**完全失败**：

| 判据 | 对话组 | 拟声组 | 结论 |
|---|---|---|---|
| 低频能量（300Hz 高通前后差值） | 0.66 dB | 0.59 dB | ❌ 无区分度 |
| 零交叉率 | 0.124 | 0.126 | ❌ 无区分度 |
| 谱平坦度（ffprobe 帧 metadata） | ~0.20 | ~0.28 | ⚠️ 有区分但重叠大 |

原因是该角色为**女性音，基频本就偏高**：100Hz 以下能量≈0，
任何基于低频或过零的**绝对阈值**都会失效。声学方案最终把 1913 个文件
（占 44%）误判为"气声"，可用训练时长从 5.5 小时缩到 3.2 小时。

**但更根本的问题是主次搞反了**：手上有官方剧本时，**文本就是权威的层级信号**——
拟声台词就是拟声，正常台词就是正常，零成本、零误判。

改用文本驱动后：

| 方案 | 可用训练时长 | 拟声误判 |
|---|---|---|
| 纯声学 | 3.21 小时 | 1913 条被误判 |
| **文本驱动** | **5.51 小时** | 242 条准确识别 |

### 文本驱动的四层划分

| 层 | 判据 | 用途 |
|---|---|---|
| `tier0_normal` 正常台词 | 去掉语气字符后仍有实义内容 | **训练主力** |
| `tier1_short` 短感叹词 | 「え？」「ありがとう」这类 | 可选，占比 **≤10%** |
| `tier2_onomatopoeia` 拟声/喘息 | 「んっ」「はぁ…」 | **不训练** |
| `reject` | 损坏 / 静音 / 削波 / 时长<0.8s / 带 DSP | 拒绝 |

> `tier2_onomatopoeia` 之所以不训练：它们是**非语音事件**，没有文本对齐可言。
> 强行训练的结果是模型学会"在正常句子里随机插入气声"。
> 官方 issue #2382 的社区结论："目前所有声音克隆项目应该都做不到你说的这个。"

### 无声学剧本时：才退回声学判据

没有剧本的场景（例如只有 ASMR 音声），退回 `tier0_normal` / `tier2_whisper`
的声学划分，并**必须按你素材的实际分布重新校准阈值**（见下文「阈值调优」）。

### ASMR 素材的四个雷

1. **绝对不要用 8D / 双耳环绕版本**。双耳相位差会破坏模型对声源的建模。全部下混**单声道**。
2. **近距离拾音的爆音、齿音、口水音**密度远高于普通语音，必须做削波检测。
3. **避免激进响度归一化** —— 动态压缩会毁掉气声细节。
4. **拟声词不要试图转写**。「んっ」「はぁ…」没有标准表记，硬标会让模型学会"随机插入气声"。

---

## 关于中文口音（诚实版）

跨语言合成**可行**，但会有可辨识的"日式韵律"：中文有声调、日语是音高重音；日语 mora 计时、中文音节计时。模型共享音素空间时会把这些一起搬过去。

分三级处理：

1. **零样本跨语言** — 直接用日文参考合成中文，有口音，作为 baseline
2. **发音人自适应** — 口音主要来自 **GPT(S1) 的韵律建模**，可只对 S1 做轻量微调
3. **文本前端** — 多音字靠 G2P（G2PW 模型）、中日共有音素锚定、标点停顿

**如果该角色没有中文语音素材，"完全消除口音"做不到。** 建议接受它，当作"这个角色的说话方式"。

---

## 工具链

### 完整流程

**推荐：一条命令跑完**（自动串接、断点续跑、可预览）

```bash
# 先看计划，不碰任何文件
python3 -m ttsdat pipeline \
    --audio /path/to/语音目录 \
    --script /path/to/台词全集_日文.md \
    --work ./work --out ./dataset --dry-run

# 确认无误后执行
python3 -m ttsdat pipeline \
    --audio /path/to/语音目录 \
    --script /path/to/台词全集_日文.md \
    --work ./work --out ./dataset
```

中断了直接重跑——**已完成的步骤会自动跳过**（实测：全量 681 秒 → 续跑 0.09 秒）。
`--force` 强制全部重跑，`--no-refs` 跳过参考音频筛选。

**手动分步**（需要精细控制时）：

```
有剧本路线（推荐，跳过整个 ASR 环节）
   ├─ ttsdat script     解析剧本 ⟨语音ID⟩ 并与音频对齐
   ├─ ttsdat scan       声学体检（损坏/静音/削波/空间音频）
   ├─ ttsdat tierby     文本驱动分层 → 训练清单
   ├─ ttsdat lint       清单自检（格式/存在性/层级泄漏）  ← pipeline 内置
   └─ ttsdat preref     筛选参考音频候选

无剧本路线（退回 ASR）
   ├─ ttsdat scan → cut → transcribe → manifest → preref
```

**实测规模（4329 个真实游戏语音文件）：**

| 阶段 | 结果 |
|---|---|
| `script` | 解析 4131 条台词 → 对齐 4130 条 |
| `scan` | 4329 文件 / 6.03 小时 |
| `tierby` | **可训练 3744 条 / 5.51 小时** |
| `lint` | 0 缺失文件 / 0 重复 / 0 层级泄漏 |
| `preref` | 评估 3744 条 → 选出 40 条参考音频候选 |

**全程耗时 681 秒**（MacBook Air M2，含 4329 次 ffmpeg 调用）。

### 要不要跑 UVR5？先量 SNR

对几千条素材盲跑 UVR5 要花几小时 GPU 时间，**而且 UVR 本身会引入相位伪影**
（听起来发闷、气声被吃掉）。所以 `scan` 会先量信噪比，再给结论：

```
--- 信噪比（决定要不要跑 UVR5 去伴奏）---
  测量 3465 条：p10=26.4 / p50=39.5 / p90=47.8 dB
    干净（>=45dB）     839 条
    中等（25-45dB）   2374 条
    底噪明显（<25dB）  252 条
  ★ 素材质量参差，建议抽样 A/B 对比后再决定是否跑 UVR5
```

**探测原理**：语音段之间的停顿就是天然的噪声样本。工具用 **0.08 秒短窗口**
从 −45 dB 往下逐级探（−45/−51/…/−93），找到仍能稳定分出静音段的最低一级。
短窗口是必须的——游戏语音多是 1–3 秒短句，按默认 0.35 秒往往一个静音段都找不到，
而词间停顿常只有 0.1–0.2 秒。

| SNR | 建议 |
|---|---|
| ≥ 45 dB | **不要跑 UVR5**，只会引入伪影 |
| 25–45 dB | 抽听 A/B 对比后再决定 |
| < 25 dB | 值得跑 UVR5 |

> ⚠️ **SNR 对短文件会偏保守**——换气声也会被当成"静音"样本，导致数值偏低。
> 它适合用来分档，不适合当绝对指标。最终决定还是要靠耳朵。

### `ttsdat` — 素材盘点与分层

只读工具设计：**scan / cut / preref 不删除、不移动、不修改任何原始素材**。

```bash
# ---- 有剧本路线 ----
python3 -m ttsdat script \
    --script /path/to/台词全集_日文.md \
    --audio  /path/to/语音目录 \
    --out ./dataset --speaker Natsume

python3 -m ttsdat scan /path/to/语音目录 --out ./work --workers 6

python3 -m ttsdat tierby \
    --scan ./work/results.jsonl \
    --voice-map ./dataset/voice_text_map.json \
    --out ./dataset --speaker Natsume

# ---- 无剧本路线 ----
python3 -m ttsdat check
python3 -m ttsdat scan /path/to/素材 --out ./work --workers 4
python3 -m ttsdat cut --work ./work --out ./cuts --min-len 3 --max-len 10
python3 -m ttsdat transcribe --cuts ./cuts/cuts.jsonl --out ./cuts
python3 -m ttsdat manifest --transcripts ./cuts/transcripts.jsonl \
    --cuts ./cuts/cuts.jsonl --out ./dataset --speaker CV
python3 -m ttsdat preref --source ./cuts/cuts.jsonl --out ./refs --top 30
```

**参考音频筛选**（两条路线通用，自动识别产物格式）：

```bash
# 剧本路线（tiered.jsonl 自带台词文本，文本分会参与排序）
#   --emit-config 会顺手生成可直接使用的推理配置（推荐）
python3 -m ttsdat preref --source ./dataset/tiered.jsonl --out ./refs --top 40 \
    --emit-config ./dataset/infer_lock.use.yaml --ref-audio-dir ./refs

# 无剧本路线
python3 -m ttsdat preref --source ./cuts/cuts.jsonl --out ./refs --top 30
```

> 几千条候选时请调大 `--workers`（默认 4）。上游已算过的声学特征会自动复用，
> 不再重复跑 ffmpeg，所以耗时主要在读取而非测量。

**生成的推理配置**会直接把参考文本接上——`prompt_text` 取自官方剧本，**无需手抄**：

```yaml
inference:
  text_lang: zh                   # 合成语言：中文
  prompt_lang: ja                 # 参考音频语言：日文
  ref_audio_path: '/path/refs/ref_A.wav'
  prompt_text: '嫌な目ってほどでもないけど……何度か飲み会に誘われたことがある'
```

换用别的候选时用 `--rank N` 重新生成，或直接编辑 `infer_lock.yaml`。

> ⚠️ **`prompt_text` 的语言必须与 `prompt_lang` 一致。** 写错（例如把中文填进去
> 却留着 `prompt_lang: ja`）会让文本前端用错误的语言规则处理参考文本，
> 产出乱码韵律或直接报错，**而且配置里肉眼看不出问题**。
> `tools/check_service.py` 会按字符集自动核对这一点：

```
=== 参考文本语言核对 ===
  prompt_lang=ja  text_lang=zh  检出语言=zh
  [!!] ★prompt_text 的语言（zh）与 prompt_lang（ja）不一致★
```

产出：

| 文件 | 内容 |
|---|---|
| `dataset/voice_text_map.json` | 剧本 ↔ 音频对齐表（含 DSP 效果标记） |
| `dataset/tiered.jsonl` | 每条素材的层级、理由、声学特征 |
| `dataset/train.list` | **GPT-SoVITS 训练清单**（`路径\|说话人\|语言\|文本`） |
| `work/results.jsonl` | 每个文件的完整声学测量 |
| `work/report.json` | 汇总统计与特征分位数 |
| `work/cache.json` | 增量缓存，中断后续跑不重算 |

**依赖**：Python 3.7+、ffmpeg/ffprobe。核心功能**不需要 numpy**。

无剧本路线额外需要：

```bash
pip install faster-whisper      # ASR
pip install pykakasi            # 汉字→假名（仅 ASR 路线需要）
# 或更准确的形态素方案：
pip install fugashi unidic-lite
```

> ⚠️ **有官方剧本时不要做假名化。** GPT-SoVITS 的日语前端自带词典，
> 能正确处理汉字读音；强行转成假名反而丢掉了有助于消歧的信息
> （同音词、分词边界）。假名化只适用于"只有音频、没有文本"的兜底场景。

安装 ffmpeg：

```bash
# macOS
brew install ffmpeg

# Windows
winget install Gyan.FFmpeg
# 或 choco install ffmpeg-full
```

> 要装 **full 版**，确保 vorbis/opus 解码器齐全。跑 `ttsdat check` 会逐项探测。

### 阈值调优

`ttsdat/config.py` 里的 `Thresholds` 集中了声学判据。**不要凭感觉改**——先跑一次 `scan`，看 `report.json` 里 `feature_distribution` 的实际分位数（p10/p50/p90），再按你的素材分布调整。

> ⚠️ **绝对阈值在不同声音上不通用。** 实测教训：同一个"低频能量 < 4.0 dB 判为气声"
> 的阈值，在合成测试素材上区分度极好（正常 9.1 dB vs 气声 0.08 dB），
> 但在真实的女性角色音上**完全失效**（对话 0.66 dB vs 拟声 0.59 dB）——
> 因为该声音基频偏高，100Hz 以下能量≈0，300Hz 高通把基频一起滤掉了。
>
> **所以：先在你的素材上跑 scan，看实际分位数，再决定阈值。**
> 更好的是——有剧本就用剧本，别用声学判据猜。

命令行也能快速调：

```bash
python3 -m ttsdat scan /path --out ./work --zcr-whisper 0.16 --side-mid 0.30
```

### 已验证的判据区分度

`python3 tests/selftest.py`（41 项断言全通过）验证的是**合成素材上的判定链路**：

| 判据 | 值 A | 值 B | 阈值 | 说明 |
|---|---|---|---|---|
| 零交叉率 | 0.006（浊音） | 0.476（噪声） | 0.14 | 合成素材上有效 |
| 低频能量 | 9.1 dB（浊音） | 0.08 dB（噪声） | 4.0 | **真实女性音上失效，见上** |
| side/mid 能量比 | 0.001（伪立体声） | 1.01（双耳） | 0.25 | **跨素材稳定** ✅ |

> **跨素材稳定的是空间音频判据**（差 3 个数量级），它检测的是声道间相位关系，
> 与说话人音高无关。这也正是 ASMR 素材最需要的那一条。

### 实现说明：几个踩过的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 零交叉率读不到 | ffmpeg 7+ 只在显式指定 `measure_perchannel` 时输出，且只在 `Channel: N` 段 | `measure_stats` 同时解析 Overall 与第一个声道段 |
| 标签匹配到错误位置 | 裸正则搜 `"I:"` 会命中 `"Integrated loudness:"` 里的子串 | 改为按行锚定解析（`_labeled_value`） |
| 所有标签都匹配不上 | ffmpeg 给滤镜输出加了 `[Parsed_astats_0 @ 0x...]` 前缀 | `_strip_log_prefix` 先剥前缀 |
| side 通道测不到值 | 伪立体声的 side 是**纯静音**，`astats` 对全零信号不输出任何数值 | 改用 `volumedetect`（对静音返回 -91 dB） |
| `aspectralstats` 用 stderr 拿不到数值 | 它把统计量写进**帧 metadata**，不走文本输出 | 需要时用 `ffprobe -show_entries frame_tags=...` 读；分层已改为文本驱动，不再依赖它 |

---

## 目录结构

```
tts-voice-clone/
├── README.md                  ← 本文件
├── ttsdat/                    ← 素材盘点、分层、切分、转写、清单、选参考
│   ├── __init__.py
│   ├── __main__.py
│   ├── audio.py               ← ffmpeg/ffprobe 封装（含浊音/空间音频判据）
│   ├── classify.py            ← 单文件声学分析
│   ├── cli.py                 ← 命令行入口（10 个子命令）
│   ├── config.py              ← 阈值配置（调优入口）
│   ├── cut.py                 ← 长音轨切分 + 逐段分层
│   ├── manifest.py            ← GPT-SoVITS 清单生成（无剧本路线）
│   ├── pipeline.py            ← 一键编排 + 断点续跑 + 清单自检
│   ├── preref.py              ← 参考音频候选筛选 + 生成推理配置片段
│   ├── scan.py                ← 批量扫描与汇总
│   ├── script.py              ← 剧本解析 ↔ 音频对齐    ★有剧本时用★
│   ├── tiering.py             ← 文本驱动分层           ★有剧本时用★
│   └── transcribe.py          ← 日语 ASR + 汉字→假名（无剧本路线）
├── server/
│   └── app.py                 ← FastAPI 网关（参数锁定/分块/拼接/缓存/鉴权）
├── configs/
│   └── infer_lock.yaml        ← 推理参数锁定表（S1 路径已修正为 s1v3.ckpt）
├── tools/
│   ├── check_service.py       ← 部署前检查（依赖/锁定表/权重/参考音频/引擎）
│   ├── export_plugins.py      ← 导出 DSH 插件供跨平台迁移
│   ├── cer_normalize.py       ← CER 归一化（与官方 seed-tts-eval 逐字节对齐）
│   ├── lint_testset.py        ← 测试集体检 + 多音字上下文读音核对
│   ├── synth_testset.py       ← 用固定测试集批量合成
│   ├── eval_cer.py            ← 字错率评测（Paraformer-large + 编辑距离）
│   └── eval_sim.py            ← 声纹相似度评测（ERes2NetV2 余弦）
├── docs/
│   ├── 01-5060ti-setup.md     ← 训练机部署（v2ProPlus 权重清单已修正）
│   ├── 02-data-prep.md        ← ASMR 素材处理手册
│   ├── 03-evaluation.md       ← 评测闭环（CER + 声纹相似度）
│   ├── 04-deployment.md       ← 推理服务部署
│   └── 05-windows-setup.md    ← Windows 训练机部署（5060 Ti）
└── tests/
    ├── make_fixtures.sh       ← 生成合成测试素材
    ├── selftest.py            ← 素材流水线端到端自测（52 项断言）
    ├── test_gateway_logic.py  ← 推理网关纯逻辑测试（16 项断言）
    ├── test_testset_tools.py  ← CER 口径与测试集工具回归（25 项断言）
    ├── test_pipeline.py       ← 流水线编排与清单自检（23 项断言）
    └── testset_zh.tsv         ← 固定测试集 42 句（7 个类别，可入库）
```

### 评测口径与测试集

**CER 归一化集中在 `tools/cer_normalize.py`**，与官方 seed-tts-eval 逐字节对齐。
`eval_cer.py` 与 `lint_testset.py` 都从它导入——两份实现早晚会分叉。

对齐时发现并修掉了两个会让指标失真的偏差：

| 偏差 | 后果 | 修正 |
|---|---|---|
| `zhconv` 同时作用于参考文本 | 繁体参考被改写成简体，参考被人为改动 | **只对 ASR 输出转简体**（官方如此） |
| 删除标点时未跳过单引号 | `don't` 被删成 `dont`，平白制造错误 | 官方显式 `if x == "'": continue` |

另外 jiwer 4.x **移除了 `compute_measures`**（改为 `process_words`），
两份 API 已同时兼容。

**合成前先体检测试集**：

```bash
python3 tools/lint_testset.py tests/testset_zh.tsv --json out/lint.json
```

它会挡掉一类"让评测数字彻底失效"的输入（生僻字、半角标点、数字读法歧义），
并**标注多音字考察点**。装了 `pypinyin` 还能给出上下文读音供核对：

```
--- 多音字消歧考察点（15 处）---
ID    字    上下文                    应读     也可读
P01   行    …银行门口排…              háng     xíng / háng（行走 / 银行）
P03   曲    …这首曲子的乐…            qǔ       qū / qǔ（弯曲 / 曲子）
P09   着    …，我睡着以后被…          zháo     zhe / zháo / zhuó（看着 / 着火 / 着装）
```

> ⚠️ **多音字必须整句送进 pypinyin，不能单字查表。**
> 单字查永远返回最常用读音（「行」→ xíng），只有整句模式才会用词典消歧。
> 本工具因此对 pypinyin 的输出长度做**显式断言**——长度对不上就直接报错，
> 而不是静默错位（这个 bug 实际发生过：把「了」对到了「。」上）。

### 部署前检查

在训练机上装好 GPT-SoVITS 后、启动服务前跑一遍：

```bash
python3 tools/check_service.py --gsv-root ~/GPT-SoVITS
```

它会提前暴露那些"启动后才会发现"的错误：锁定表缺键、权重路径写错、
参考音频不存在、`prompt_text` 忘了填、依赖没装、引擎没起。

> 其中有一条专门检查 **v2ProPlus 的 S1 必须是 `s1v3.ckpt` 而不是 v2 底模**——
> 这是本项目实际踩过的坑，写错不会立刻报错，但会加载错误的权重。

### 自测

```bash
python3 tests/selftest.py             # 素材流水线
python3 tests/test_gateway_logic.py   # 推理网关纯逻辑
python3 tests/test_testset_tools.py   # CER 口径与测试集工具
python3 tests/test_pipeline.py        # 流水线编排与清单自检
python3 tools/cer_normalize.py        # CER 归一化离线自检
```

| 测试 | 验证内容 |
|---|---|
| `selftest.py` | 环境预检 → 扫描分层 → 增量缓存 → 长音轨切分 → 清单生成 → 文本分层 |
| `test_gateway_logic.py` | 长文本分块、音频拼接（静音/交叉淡化）、参数锁定约束 |
| `test_testset_tools.py` | CER 归一化口径、测试集解析、多音字对齐 |
| `test_pipeline.py` | 断点续跑判定、清单自检（格式/缺失/重复/层级泄漏）、dry-run 不落盘 |
| `cer_normalize.py` | 归一化本身（纯离线，不需要 jiwer/zhconv） |

后三个用 AST 从真实源文件**抽取函数**执行，测的是发布出去的那份代码。

> **只验证逻辑正确性，不验证阈值是否适合你的素材、也不给出 CER 绝对值。**
> 后者必须在评测机上用真实合成音频跑出来。

> **Windows**：直接用 `python` 或 `python3`（取决于你的安装方式）。
> **macOS 特例**：如果 PATH 里 `/opt/homebrew/bin` 在前，`python3` 会解析到
> Homebrew 的 Python，而 numpy/pypinyin 可能装在系统 Python 的 user
> site-packages 里，会报 `ModuleNotFoundError`——这时改用 `/usr/bin/python3`。

---

## 后续步骤

- [x] 素材盘点与声学分层
- [x] 长音轨 VAD 切分
- [x] 日语转写 + 汉字→假名对齐（无剧本路线）
- [x] 剧本解析与音频对齐（有剧本路线）
- [x] 文本驱动分层
- [x] 参考音频库自动筛选（两条路线通用）
- [x] 评测闭环脚本（CER + 声纹相似度）+ 固定测试集
- [x] 推理网关与部署前检查
- [x] 一键编排流水线（断点续跑 + 清单自检 + dry-run）
- [ ] 参考音频最终筛选（**需人工试听**，见 `refs/reference_candidates.json`）
- [ ] 在 5060 Ti 上跑通微调
- [ ] 中文跨语言合成的口音实测与调优

---

## 合规

本项目**仅提供方法**。训练素材、微调权重、参考音频**均不应提交到任何仓库或公开发布**。

- 训练数据与权重加入 `.gitignore`
- 分享方法时避免附带具体角色名、音声作品编号
- 不要发布参考音频的波形/频谱截图（可反推音色）


---

## 支持

如果这个项目帮到了你，可以请我喝杯咖啡（完全自愿）：**https://ko-fi.com/colome**

更多项目：**https://github.com/SourceAn**
