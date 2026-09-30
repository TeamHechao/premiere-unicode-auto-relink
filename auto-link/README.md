# Premiere UXP panel

从仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\auto-link\install-user-plugin.ps1
```

安装前请关闭 Premiere。脚本会校验每个文件的 SHA-256，并把旧版本放到用户备份目录；
不会启动 Premiere。面板状态、备份、日志和报告保存在 UXP 数据目录，不依赖源码路径。

首次打开面板只需选择一次素材库。它会自动启用检查并立即扫描；面板可见时定期检查，
只在找到唯一候选时调用 Premiere 的重链接接口。文件名、目录、素材内容都保持不变。

面板要求已保存工程、完整的项目清单和一个唯一候选。重链接前会备份工程并写事务日志；
失败或中断后会暂停，检查记录并确认后才允许继续。
