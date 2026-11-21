# Desktop48.app

A cross-platform desktop application for Pocket48（口袋48）.

## 📥 Download

Get the latest build from the official download page — it detects your OS and CPU and points at the right package:

**➡️ [48.v2ing.com](https://48.v2ing.com/)**

| Platform              | Package                                                  |
| --------------------- | -------------------------------------------------------- |
| macOS (Apple Silicon) | [arm64](https://48.v2ing.com/download/mac-arm64)         |
| macOS (Intel)         | [x64](https://48.v2ing.com/download/mac-x64)             |
| Windows (x64)         | [installer](https://48.v2ing.com/download/windows-x64)   |
| Linux (AppImage)      | [AppImage](https://48.v2ing.com/download/linux-appimage) |
| Linux (deb)           | [deb](https://48.v2ing.com/download/linux-deb)           |

Installers are served from our own mirror for faster access in mainland China; the same artifacts are also published on [GitHub Releases](https://github.com/mirtu-ko/Desktop48.app/releases) as a fallback.

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

## 📊 Telemetry

This app includes anonymous usage stats via [Umami](https://umami.is) (open source, cookie-free). Collected: in-app page routes (e.g. `/#/setting`) and generic device fields (OS, screen, language). Never collected: account credentials, chat or room messages, or anything that can identify you. No cookies, no cross-app tracking.

## 💬 Feedback

The feedback form in Settings sends what you write, an optional contact, and a few environment fields (app version, OS and architecture, Electron version, locale, client profile, whether you are signed in) to our own endpoint — only when you press submit. Never collected: account credentials, phone number, chat or room messages. IP addresses are stored only as a salted hash, used for rate limiting.

## 📄 License

[MIT License](LICENSE)
