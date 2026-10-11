# RESTORE-NOTES.md · 还原记录

> 本文件是**还原过程记录**，不属于原始项目内容（原包里没有这个文件）。
> 还原时间：2026-09-17 ｜ 目标：`$HOME/Code/Harness/Natsume_TTS`
> 依据：`README-压缩包说明.txt`、`Natsume-incremental/README-INCREMENTAL.txt`、`MANIFEST.txt`

---

## 1. 结论

全量包 + 增量包已按文档顺序还原：**先全量、后覆盖增量**。

| 项目 | 结果 |
|---|---|
| 文件数 | 16,633（期望 16,633，**0 缺失**） |
| SHA256 校验 | **16,633 / 16,633 全部一致，0 不一致** |
| 大小 | 11.75 GiB（12 GB 显示值）／121 个目录 |
| 时间戳 | 全部保留原包 mtime |
| 额外文件 | 仅 `.DS_Store`（Finder 残留）与本记录文件 |

---

## 2. 来源

| 来源 | 说明 |
|---|---|
| `~/Downloads/Quark/Natsume/Natsume-full_7z/` | 全量包 `Natsume-full.7z.001~004`（16.5 GB / 4 卷）的**已解压副本** |
| `~/Downloads/Quark/Natsume/Natsume-incremental/files/` | 增量包 46 个文件（2026-09-17 07:20 之后的改动） |

**先核对再复制**：把已解压副本与 `Natsume-full.7z.001` 的归档清单逐条比对
（74,900 条 = 69,465 文件 + 5,434 目录），**路径、大小、目录全部一致**，
因此确认副本完整，未重新解压（省去 16.5 GB 解压开销）。

---

## 3. 还原步骤

1. 校验已解压副本 vs 7z 归档清单 → 完全一致
2. `cp -cRp` 复制 22 个顶层条目到目标（**排除 `_env`**）
   - 源与目标同属一个 APFS 卷，用 `clonefile` 写时复制：23 GB 只花 **2 秒**，且不额外占磁盘
3. `ditto` 把增量包 `files/` 合并覆盖到目标（保留 mtime）

> 注：克隆副本与 `~/Downloads` 源文件**共享磁盘块**。将来删除 Downloads 里的源目录，
> 释放的是 4 个 `.7z` 分卷（16.5 GB）与 `_env`（11.4 GB）；已还原项目的 11.75 GB 照常保留。

---

## 4. 增量包落地明细（46 个文件）

| 类别 | 数量 | 说明 |
|---|---|---|
| **真正更新**（内容变化） | 3 | `_run/infer_api.py`、`_run/trylisten/server.py`、`_run/trylisten/index.html` |
| **新增**（全量包里没有） | 26 | 情绪标注链路 `_run/{audio_emotion,llm_label,llm_scene,fuse_emotion,persona_voice,build_digest,emotion_ref,scan_duration,label_server,make_incremental}.py`、`_run/labeler/index.html`、dashboard/s1_watch 等 |
| 内容相同（覆盖无变化） | 17 | 如 `README-HARNESS.md`、`_dl/*.md`、`dataset/emotion_*.json` 等 |

已抽查确认：3 个"真正更新"的文件在目标中确为**增量版**（SHA256 与增量包一致，与全量包不同）。

---

## 5. 验收抽查

* **权重齐全**：`GPT_weights_v2ProPlus/` 7 个 `.ckpt`（e2/e4/e6/e8/e10/e12/e14）+ `SoVITS_weights_v2ProPlus/` 7 个 `.pth`
* **关键入口齐全**：`_run/infer_api.py`、`_run/INFER-API.md`、`_run/test_infer_api.py`、`_run/trylisten/server.py`、`_run/label_server.py`、`README-HARNESS.md`、`_dl/SESSION-STATE.md`
* **dataset JSON 全部可解析**，条数与文档吻合：
  `emotion_llm.json` 4130 ／ `emotion_scene.json` 4130 ／ `audio_emotion.json` 4130 ／
  `audio_duration.json` 4329 ／ `voice_text_map.json` 4130 ／ `emotion_digest.json` 20 类

---

## 6. ⚠️ 未还原：`_env`（按你的选择跳过）

`_env` 是 **11.37 GiB / 52,858 个文件**的 **Windows conda 环境**（`python.exe` + 384 个 `.dll`），
macOS 上无法运行，因此没有复制。

需要时单独取回（只解 `_env` 一个目录）：

```bash
7z x ~/Downloads/Quark/Natsume/Natsume-full.7z.001 _env -o<目标目录>
```

---

## 7. ⚠️ 安全提醒：`dataset/api_config.json` 里有真实 API Key

`README-INCREMENTAL.txt` 第 79 行写的是"**不含 Key，需自填**"，但**实际文件里带了一个可用的
`sk-` 开头的 Key**（`base_url` = `https://api.deepseek.com`，`model` = `deepseek-flash`）。

* 我没有把这个 Key 抄进本文件；Key 只存在于 `dataset/api_config.json` 一处
* 该项目 `.gitignore` 含 `dataset/` 规则，**不会误入库**
* 但这个 Key 随网盘包走了一趟 Quark，**建议去 DeepSeek 控制台吊销并换新**，再按文档填回

---

## 8. ⚠️ macOS 上的现实情况

原项目是 **Windows + NVIDIA** 工作流，直接搬过来只有一部分能跑：

| 能力 | macOS 上能否跑 |
|---|---|
| 纯标准库链路：`llm_label.py`、`llm_scene.py`、`fuse_emotion.py`、`persona_voice.py`、`build_digest.py` | ✅ 可以（见 `README-INCREMENTAL.txt` §11，产物 `dataset/*.json` 已随包还原） |
| 推理 API（9880）／试听台（8788）／标注台（8790） | ❌ 需 CUDA + Windows 环境，本机无法直接起 |
| 训练脚本 | ❌ 同上 |

具体阻碍：

1. `_run/*.sh` 里硬编码 `Z:/tts-voice-clone/_env/envs/GPTSoVits/python.exe`（Windows/WSL 路径）
2. `_tools/ffmpeg-master-latest-win64-gpl/bin/*.exe` 是 Windows 版 ffmpeg，macOS 需 `brew install ffmpeg`
3. `.sh` 脚本**没有可执行位**（原包里就是 644，已原样保留），要跑先 `chmod +x`
4. 权重的推理依赖 `GPT_SoVITS/TTS_infer_pack`，需要 CUDA

想在本机跑文本侧链路时，自建一个 venv 即可（纯标准库，无需 pip install）。

---

## 9. 目录与体积

```
GPT-SoVITS   9.7G   框架 + 权重 + logs 训练产物
_dl          1.3G   诊断日志
_tools       483M   ffmpeg（win64）
_assets      281M   训练素材 ogg
_run          17M    脚本 / 服务 / 试听台 / 标注台
dataset       15M    情绪与人设数据表（14 个 JSON）
_fixtures     13M
work         7.5M
refs/docs/tests/tools/ttsdat/server/configs  < 1M 各
```

---

## 10. 复验方法

结构复验（路径 + 大小）：

```bash
cd ~/Downloads/Quark/Natsume && 7z l -slt Natsume-full.7z.001 > /tmp/arc.txt
# 与目标树逐条比对；期望 16,607（全量去掉 _env）+ 26（增量新增）= 16,633
```

内容复验（SHA256）：对每个文件取期望源（**增量包优先于全量包**）与目标做 `shasum -a 256` 对比，
本次结果 16,633/16,633 一致。若要重跑，注意增量包中 3 个更新文件应以增量版为准。

---

## 11. 后续：macOS 推理环境

本记录只覆盖「还原」。之后项目又做了一次 **Windows → macOS 的推理迁移**，
新增 `_mac/` 目录与 `.venv/` 环境，删掉了 Windows 专用文件，
并改动了若干 `_run/*.py`（详见 `_mac/README-MAC.md` 第 5 节）。

因此**本文第 5/9 节的「文件数 / 体积」是还原当时的快照**，之后的变化是：

| 变化 | 影响 |
|---|---|
| 新增 `_mac/`、`.venv/`（1.7 GB）、`_tools/README.md`、`RESTORE-NOTES.md` | 文件数 + |
| 删除 `_tools/ffmpeg-master-latest-win64-gpl/`（483 MB）、`_run/*.ps1` | 体积 − |
| 修改 `_run/infer_api.py`、`synth_v2.py`、`synth_holdout.py`、`test_infer_api.py`、`trylisten/server.py`、`label_server.py` | 内容变 |

**上游 `GPT-SoVITS/` 依旧保持完整**：11,502 个文件里 11,501 个未动，
唯一变化的 `configs/tts_infer.yaml` 是上游 `save_configs()` 自己写的（Windows 上同样会写）。

### 11.1 这台机器只做推理

`_run/` 里 24 个 Windows/WSL 训练脚本（`stage_*.sh`、`gsv_train.py`、`s1_watch.py`、
`dashboard_*.py`、`mem_scan.py` 等）连 `shims/`、`synth_out/` 一起**移到了 `_win/`**
（316 KB，**未删除**，`mv` 回去即可恢复）—— 清单与原因见 `_win/README.md`。

`_run/` 现在只留推理与数据侧：`infer_api.py` / `synth_v2.py` / `synth_holdout.py` /
`test_infer_api.py` / `trylisten/` / `label_server.py` / 情绪标注链路 / `emotion_ref.py`。

`GPT-SoVITS/logs/Natsume/`（5.4 GB 训练中间产物）**按你的选择原样保留**，
推理侧不引用它（只有 `synth_holdout.py` 用到其中的 `2-name2text.txt`）。

