# tools/ — DSH 取证工具

只读工具：用来核实桌面端 DSH 的实现细节（`app.asar` 里的源码与 README）。**不改任何东西**，也不参与插件构建。

```bash
node tools/asar.mjs doctor                      # 归档路径、运行时版本、文件数、索引状态
node tools/asar.mjs index                       # 强制重建索引
node tools/asar.mjs cat /dsh/package.json        # 打印一个文件
node tools/asar.mjs extract /dsh/package.json --out /tmp/dsh
node tools/asar.mjs grep "includePrerelease" dsh-app-boot
```

归档路径默认是 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，可用 `DSH_ASAR` 覆盖。

## 两条规矩

1. **先核版本，再信结论**：`doctor` 打印的 runtime 版本才是「你正在读的那份实现」的版本。文档里写的行号、函数位置随版本漂移。
2. **索引与归档指纹绑定**：缓存（`tools/.cache/asar-index.json`）记录归档的大小、mtime 与运行时版本，任一不符就重建并告警。**不要手工复用旧索引**——asar 的目录表是偏移表，套错会把别的包的内容当成本包内容返回，且不会报错（本项目踩过一次：按旧索引抽 `ui-reference/package.json` 得到的是别人的 README）。

## 常见用途

- 核实某个 API 是否真实存在、签名是什么（`grep` + `cat`）。
- 确认插件兼容闸门、事件格式、客户端插槽名字。
- 升级 DSH 后对比行为差异：先 `doctor` 看版本，再 `grep` 关键函数。
