# 收录材料状态

核对日期：2026-11-05。此目录是投稿材料，不含账号检查、私人日志或本机操作记录。流程见 [发布与收录手册](../RELEASING.md)。

| 指南项目 | 当前状态 |
| --- | --- |
| 投稿范围 | 仅 data/plugins/cxydaizihao520__dsh-session-coordinator.yml；上游 README 不修改 |
| 公开源码 | main，版本 0.2.20 预览 |
| 仓库状态 | 已核对公开、未归档、创建满一天及 dsh-plugin topic |
| 安装清单 | dsh.bundle.patch、patch 文件、宿主与客户端入口齐全 |
| 公开源码安装 | 0.2.20 干净检出 prepare 构建通过，本地预构建包经官方安装器安装。旧版 GitHub 安装证据仅适用于 0.2.15 |
| 功能与版本范围 | 见 [本版验收说明](../ACCEPTANCE.md)；未覆盖项不标通过 |
| 条目 | session 分类；英中单行描述；复用上游校验器通过 |
| npm | 可选；发行版本以 npm registry 的 beta 标签为准 |
| tarball | 可选，未发布 Release，不填写未来下载地址 |
| 图标、截图 | 可选，未附加；避免未经核对的个人资料或会话内容进入附件 |
| 相关插件 | 已有 session-bridge 条目；差异写入 PR 草稿，是否重复由维护者评审 |
| 上游 PR | 仅草稿，未提交；上游 CI 与维护者评审尚未执行 |

依据：[最新贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。本次读取的指南 blob 为 `7d21f50d8948c978fd2cf12c50f0d22c724b1a11`，校验器 blob 为 `1f8a751219c50f8b3f84111e7ecd5f9cd2dc50d5`。每次提交前重新核对，不能把本次状态自动沿用为下个版本的验收。

材料清单：本文件、[PR 正文草稿](PR.md) 和 [唯一投稿 YAML](data/plugins/cxydaizihao520__dsh-session-coordinator.yml)。提交给上游时只取 YAML；不把整个材料目录附入 PR。
