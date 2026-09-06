# Desktop48.app

A cross-platform desktop application for Pocket48.

## Attribution

本项目基于原 Vue 2 版本项目 [desktop48](https://github.com/Jarvay/desktop48)（原作者 [@Jarvay](https://github.com/Jarvay)）重构与升级至 Vue 3。

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## Screenshot

![Desktop48 截图](resources/screenshot.png)

## macOS 常见问题

### 打开提示"已损坏，无法打开"

**临时解决**：

```bash
# 移除 quarantine 属性
sudo xattr -rd com.apple.quarantine /Applications/Desktop48.app
```

或者在访达中右键应用 → 选择「打开」（而非双击），在弹出的对话框中点击「打开」。

## License

 [MIT License](LICENSE)
