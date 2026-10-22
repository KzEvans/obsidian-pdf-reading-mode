# PDF Reading Mode for Obsidian

## 后续版本

本插件的后续开发已合并到 [Paper Workbench](https://github.com/KzEvans/obsidian-knowledge-base)，
统一提供 Zotero 同步、MinerU 解析、Qwen-MT 翻译、单栏阅读和手动笔记生成。
迁移前请阅读[迁移与回滚方案](https://github.com/KzEvans/obsidian-knowledge-base/blob/main/docs/migration.md)，
先停用旧插件并保留原目录和缓存；已有 MinerU 结果可复用，无需重新上传。
本仓库保留旧版 PDF Reading Mode 的源码与使用说明。


把文献 PDF 的多栏正文重排为连续单栏，在左右分屏中阅读、划选翻译及跳转原页。

## 安装

下载本仓库的 `main.js`、`manifest.json` 和 `styles.css`，放入 vault 的 `.obsidian/plugins/pdf-reading-mode/` 目录，重新加载 Obsidian 后在“第三方插件”中启用。需要桌面版 Obsidian 1.11.4 或更高版本，以及自己的 MinerU API Token。

## 使用

1. 在 Obsidian 启用 **PDF Reading Mode**。
2. 在插件设置中输入 MinerU 精准解析 API Token，点击“保存密钥”。密钥保存到 Obsidian SecretStorage；插件配置与缓存中不包含 Token。
3. 打开文献 PDF，点击标签页右上角的书本图标。它位于划线翻译按钮旁边。
4. 首次处理会上传当前 PDF 到 MinerU；排队时仍可阅读原 PDF。之后从本地缓存打开，可以离线阅读。
5. 工具栏可调整字号、查找正文及跳到原页。点击“原 PDF”或书本按钮退出，位置同步到当前原页。

正文默认 Times New Roman、18px、1.5 倍行距、首行缩进 2em，随窗格宽度换行。图表按原文顺序显示；多面板图在有明确图注及布局证据时归并，并从原 PDF 裁取完整图组。表格直接使用原 PDF 裁图，点击可放大；表题和科学脚注保持可划选。作者、出版信息及页眉页脚移到所属小节末尾并默认折叠；参考文献集中折叠于文末，可随时展开。图内 OCR 标签只用于图片辅助描述，不作为正文重复输出。

每个段落的原文工具提供“查看原页”和“复制原文页码链接”。链接仍指向原 PDF，不会生成另一份作为链接目标的笔记。原有页码链接在阅读层跳转；精确选区、注释或坐标链接恢复原生 PDF 显示。

## 划线翻译

可搭配支持下述接口的 **PDF Selection Translator**。两个开关独立，阅读模式不要求翻译密钥。阅读层的选中文字沿用翻译插件的接口与弹窗；翻译插件需单独安装，本仓库不包含该插件。

兼容接口：当前阅读 root 为 `.pdf-reader-content[data-pdf-reader-active="true"]`；模式切换从原 `view.containerEl` 派发冒泡的 `pdf-reading-mode:mode-change`，翻译插件清理旧 Range、请求与弹窗。

## 处理与缓存

- 使用 MinerU 精准云 API `vlm`，开启公式及表格识别；默认文献语言为英语。
- 只上传主动开启阅读模式的 PDF，不上传笔记、vault 路径或其他文献。上传文件名固定为 `paper.pdf`。
- 缓存在 `.obsidian/plugins/pdf-reading-mode/cache/`，按 PDF 内容摘要和解析合同区分。保留结构化内容、图像和原页来源。
- 排队任务可重试继续获取，成功结果无需重复上传。同一 PDF 的多个标签页共享解析任务，各自保存阅读状态。
- 云端支持最大 200 MB、200 页。解析失败或不兼容时保留原 PDF；“核对提示”列出需要查看原页的内容。
- 窗格内字体与配图自动适配；密集表格和公式保留原页或原图查看入口。
- 图片预留原始比例并按需加载，靠近阅读区域时逐张预解码，正文显示无需等待整篇图片解码；同页图表共用一次原 PDF 渲染。滚动页码使用位置索引，长文排版分批进行，避免连续占用界面线程。
- 本次运行中保留最近 8 篇文献的解析结果；文件修改后失效，重新加载 Obsidian 后使用磁盘缓存。首次云端处理仍受上传与 MinerU 排队时间影响。

## 开发

```sh
pnpm install
pnpm build
pnpm test
```

排查卡顿时可在插件设置中开启“滚动性能诊断”（默认关闭）。开启后，滚动停止时本地缓存目录的 `performance.json` 保存最近 12 段滚动的数值诊断，包括帧间隔、长任务、节点数量及页码索引重建次数。记录不包含正文或凭据，也不会上传；关闭阅读模式会停止采样。

安装文件为 `main.js`、`manifest.json`、`styles.css`。仅支持桌面版 Obsidian 1.11.4 及以上。源文件和原 PDF 身份保持不变；插件卸载会恢复原生 PDF 视图与链接处理。

解析列表以 MinerU 云端 Content List V1 为合同，保留 provider 顺序；源页显示为 `page_idx+1`，bbox 从 0–1000 转为 0–1。正文、图表、图注与科学脚注不会交给通用大模型改写。原生 PDF 视图与页码跳转的适配依赖部分内部实现，Obsidian 大版本更新后需重新验证。
