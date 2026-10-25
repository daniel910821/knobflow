# KnobFlow for GNOME (GNOME Shell 51)

A native GNOME Shell extension that turns your mechanical keyboard volume knob into a per-application audio mixer and system volume controller.

## Development Notice

This project was developed with the assistance of Google Gemini. All code has been carefully reviewed, refactored, and audited to adhere strictly to the GNOME Shell Extension Review Guidelines, ensuring clean resource lifecycles, memory safety, and no redundant defensive code.

## Key Features

- **Knob Rotation (Up / Down)**:
  - Adjusts the volume of the currently selected target in configurable percentage steps (default: 5%).
  - Supports configurable fine/granular volume stepping (e.g. 1% steps below 20% volume, and 5% steps above).
- **Knob Click (Loop Cycle)**:
  - A short click cycles sequentially through active targets:
    `System / Master -> App 1 -> App 2 -> ... -> System`.
- **Double-Click or Hold (~400ms)**:
  - Toggles mute for the selected application or system audio.
- **Stock GNOME OSD & Custom Translucent HUD**:
  - **Stock GNOME OSD (Default)**: Uses GNOME's native on-screen volume popup (`Main.osdWindowManager`), displaying the real app name, icon, and native volume bar.
  - **Custom HUD Switcher**: A compact, translucent centered floating HUD showing app cards with system accent colors (`-st-accent-color`). Switchable in Preferences.
- **Smart App & Web App Name Resolution**:
  - Completely eliminates generic stream labels like "Playback".
  - Resolves exact desktop applications (Google Chrome, Spotify, Firefox, VLC, Discord, etc.).
  - Detects active media services running in browser tabs (e.g. Spotify Web, YouTube, SoundCloud, Netflix, Twitch) and displays the service name directly.
- **Active Streams Only**:
  - Configurable option to cycle only through applications that are actively outputting audio at that moment.
- **Automatic Fallback to System**:
  - If the active app closes or stops playing audio, control automatically falls back to **System / Master**.
- **Multilingual Support**:
  - Default language: **English**. Includes complete **Spanish (`es`)** translation (`gettext`).
- **Hardware Presets & Key Recording**:
  - Assign shortcuts via built-in presets (`XF86AudioMute`, `XF86AudioRaiseVolume`, `XF86AudioLowerVolume`, `XF86AudioPlay`) or record custom keys directly in the Preferences window.

## Installation & Usage

1. **Build & Link**:
   ```bash
   make link
   ```

2. **Reload GNOME Shell Session**:
   On Wayland, log out and log back in to reload extensions into memory.
   *(On X11, press `Alt + F2`, type `r`, and hit Enter).*

3. **Enable Extension**:
   ```bash
   gnome-extensions enable knobflow@felipe.local
   ```

4. **Preferences**:
   ```bash
   gnome-extensions prefs knobflow@felipe.local
   ```
   Or open the **Extensions** app and click settings next to KnobFlow.

## Configuration Options

| Setting | Options / Range | Default | Description |
|---|---|---|---|
| **OSD Display Style** | `Stock GNOME OSD`, `Custom HUD Switcher` | `Stock` | Choose between native GNOME volume overlay or centered HUD |
| **Volume Step** | `1% - 25%` | `5%` | Standard percentage volume increment/decrement per knob step |
| **Fine Volume Threshold** | `0% - 50%` | `20%` | Volume percentage below which fine volume stepping is activated (0 to disable) |
| **Fine Volume Step** | `1% - 5%` | `1%` | Granular volume increment/decrement when at or below threshold |
| **Only Active Streams** | `true / false` | `false` | Exclude silent or paused applications from cycle |
| **HUD Duration** | `500ms - 5000ms` | `2000ms` | Display duration before HUD fades out (if using Custom HUD) |
| **Knob Click** | Key shortcut / Presets | `XF86AudioMute` | Shortcut mapped to knob click |
| **Knob Turn Up** | Key shortcut / Presets | `XF86AudioRaiseVolume` | Shortcut mapped to clockwise rotation |
| **Knob Turn Down** | Key shortcut / Presets | `XF86AudioLowerVolume` | Shortcut mapped to counter-clockwise rotation |

## Project Structure

- [`metadata.json`](metadata.json): Extension metadata and supported GNOME versions.
- [`extension.js`](extension.js): Extension lifecycle entry point (`enable`/`disable`) and translation setup.
- [`audioManager.js`](audioManager.js): Audio backend using `Gvc`, PipeWire stream tracking, window title and media resolution.
- [`keyManager.js`](keyManager.js): Hardware key capturing, static media-key ungrabbing, single/double click detection.
- [`osdManager.js`](osdManager.js): Stock OSD and translucent compact HUD presentation.
- [`prefs.js`](prefs.js): Libadwaita Preferences dialog with preset selection and key recorder.
- [`stylesheet.css`](stylesheet.css): CSS styling using GNOME system accent colors, translucency, and compact dimensions.
- [`po/`](po/): Translation sources (`es.po`).
- [`locale/`](locale/): Compiled binary gettext catalogs (`knobflow.mo`).
- [`schemas/`](schemas/): GSettings XML definitions and compiled schemas.

## License

This project is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later) - see the [LICENSE](LICENSE) file for details.
