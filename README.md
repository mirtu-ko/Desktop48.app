# Desktop48.app

A cross-platform desktop application for Pocket48（口袋48）.

## 📌 Attribution

This project is based on the original Vue 2 project [desktop48](https://github.com/Jarvay/desktop48) by [@Jarvay](https://github.com/Jarvay), rebuilt and upgraded to Vue 3.

The room message data structures and protocol parsing were implemented with reference to [@yk1z](https://github.com/yk1z)'s project [yaya_msg](https://github.com/yk1z/yaya_msg).

## 🛠️ Project Setup

### 📦 Install

```bash
$ npm install
```

### 💻 Development

```bash
$ npm run dev
```

### 🏗️ Build

```bash
# For Windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## 📷 Screenshot

![Desktop48 截图](docs/screenshot.png)

## 🍎 macOS 常见问题

### 打开提示"已损坏，无法打开"

**临时解决**：

```bash
# 移除 quarantine 属性
sudo xattr -rd com.apple.quarantine /Applications/Desktop48.app
```

## 📊 Telemetry

This app includes anonymous usage stats via [Umami](https://umami.is) (open source, cookie-free). Collected: in-app page routes (e.g. `/#/setting`) and generic device fields (OS, screen, language). Never collected: account credentials, chat or room messages, or anything that can identify you. No cookies, no cross-app tracking.

## 📄 License

[MIT License](LICENSE)
