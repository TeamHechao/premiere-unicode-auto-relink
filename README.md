# Premiere Unicode Auto Relink

解决 Premiere 在 Mac 与 Windows 交接时的素材失联，尤其是日文文件名的
NFC/NFD 编码不同、看起来相同但无法逐字匹配的情况。

## 日常使用

1. 关闭 Premiere，运行安装脚本：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\auto-link\install-user-plugin.ps1
   ```

2. 打开 Premiere，在 `窗口 > UXP 插件 > 素材自动补链` 打开面板。

3. 第一次点击 **选择素材库并启用**，选后期包根目录即可。插件会保存设置、
   开启检查并立即扫描一次；以后只要面板可见，就会自动检查。

常用操作只有三个：**打开工程并检查**、**立即检查**、**暂停自动检查**。
补链后检查结果，由用户确认并保存工程。素材名不会被改动，新下载的 BGM 会在
下一次检查时自动发现。旧素材库改过目录名时，再到 **高级设置** 每行填一个旧名。

插件只处理已保存工程，并在第一次修改前建立备份。候选不唯一、素材缺失、工程清单
不完整或事务未核对时会停下，不会按文件名或时间戳猜测。

## 不能打开 Premiere 时

使用离线副本工具，必须显式指定真实素材库：

```powershell
py -3 .\relink_media.py --media-root 'D:\Media\PostPackage' 'D:\Edit\episode.prproj'
```

它不覆盖输入工程，会输出原工程备份、修复副本和报告。

## 验证

```powershell
npm --prefix auto-link test
python -m unittest discover -v
node --check auto-link/plugin/main.js
```

详细设计、限制和排障：[`docs/architecture.md`](docs/architecture.md)、
[`docs/limitations.md`](docs/limitations.md)、[`docs/troubleshooting.md`](docs/troubleshooting.md)。

仓库只含源码和合成测试，不含真实工程、素材或本机配置。
