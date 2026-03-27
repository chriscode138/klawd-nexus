#!/bin/bash
# Klawd Nexus - macOS Installer
# Run: curl -fsSL https://raw.githubusercontent.com/chriscode138/klawd-nexus/main/install-mac.sh | bash

set -e

echo ""
echo "  ◆ Klawd Nexus Installer"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "  Node.js is required but not installed."
    echo "  Install it from https://nodejs.org (v18 or later)"
    echo ""
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "  Node.js v18+ required. You have $(node -v)."
    echo "  Update from https://nodejs.org"
    echo ""
    exit 1
fi

echo "  [1/4] Downloading Klawd Nexus..."
INSTALL_DIR="$HOME/klawd-nexus"

if [ -d "$INSTALL_DIR" ]; then
    echo "  Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull --quiet 2>/dev/null || true
else
    git clone --quiet https://github.com/chriscode138/klawd-nexus.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo "  [2/4] Installing dependencies..."
npm install --silent 2>/dev/null

echo "  [3/4] Building..."
npm run build --silent 2>/dev/null

echo "  [4/4] Creating desktop shortcut..."

# Create a launcher script
cat > "$INSTALL_DIR/launch.sh" << 'LAUNCHER'
#!/bin/bash
cd "$(dirname "$0")"
npx electron . 2>/dev/null &
LAUNCHER
chmod +x "$INSTALL_DIR/launch.sh"

# Create a macOS .app bundle in /Applications
APP_DIR="/Applications/Klawd Nexus.app"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy icon if it exists
if [ -f "$INSTALL_DIR/icon.icns" ]; then
    cp "$INSTALL_DIR/icon.icns" "$APP_DIR/Contents/Resources/app.icns"
elif [ -f "$INSTALL_DIR/icon.png" ]; then
    # Convert PNG to icns
    mkdir -p /tmp/kn-icon.iconset
    sips -z 512 512 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_512x512.png 2>/dev/null
    sips -z 256 256 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_256x256.png 2>/dev/null
    sips -z 128 128 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_128x128.png 2>/dev/null
    cp "$INSTALL_DIR/icon.png" /tmp/kn-icon.iconset/icon_512x512@2x.png
    sips -z 256 256 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_128x128@2x.png 2>/dev/null
    sips -z 64 64 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_32x32@2x.png 2>/dev/null
    sips -z 32 32 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_32x32.png 2>/dev/null
    sips -z 32 32 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_16x16@2x.png 2>/dev/null
    sips -z 16 16 "$INSTALL_DIR/icon.png" --out /tmp/kn-icon.iconset/icon_16x16.png 2>/dev/null
    iconutil -c icns /tmp/kn-icon.iconset -o "$APP_DIR/Contents/Resources/app.icns" 2>/dev/null
    rm -rf /tmp/kn-icon.iconset
fi

# Create the launcher executable
cat > "$APP_DIR/Contents/MacOS/Klawd Nexus" << APPSCRIPT
#!/bin/bash
cd "$INSTALL_DIR"
export PATH="\$PATH:/usr/local/bin:/opt/homebrew/bin"
npx electron . 2>/dev/null &
APPSCRIPT
chmod +x "$APP_DIR/Contents/MacOS/Klawd Nexus"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Klawd Nexus</string>
    <key>CFBundleDisplayName</key>
    <string>Klawd Nexus</string>
    <key>CFBundleIdentifier</key>
    <string>com.klawdnexus.app</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>Klawd Nexus</string>
    <key>CFBundleIconFile</key>
    <string>app</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

echo ""
echo "  ✓ Klawd Nexus installed successfully!"
echo ""
echo "  Open from:"
echo "    • Applications folder (Klawd Nexus)"
echo "    • Terminal: cd ~/klawd-nexus && npm run app"
echo ""
echo "  To run in browser instead: cd ~/klawd-nexus && npm start"
echo "  Then open http://localhost:3000"
echo ""
