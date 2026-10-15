import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { AudioManager } from './audioManager.js';
import { OsdManager } from './osdManager.js';
import { KeyManager } from './keyManager.js';

/**
 * KnobFlowExtension
 *
 * Main entry point for the KnobFlow extension. Manages the lifecycle of
 * core subsystems: AudioManager, OsdManager, and KeyManager.
 */
export default class KnobFlowExtension extends Extension {
    /**
     * Called when the extension is enabled. Initializes translations,
     * loads user settings, and constructs subsystems in dependency order.
     */
    enable() {
        this.initTranslations();
        this._settings = this.getSettings();

        // 1. Manages PulseAudio / PipeWire audio streams via Gvc
        this._audioManager = new AudioManager(this._settings);

        // 2. Handles on-screen feedback (native GNOME OSD or custom translucent HUD)
        this._osdManager = new OsdManager(this._audioManager, this._settings);

        // 3. Captures keyboard knob inputs and routes actions to audio & OSD managers
        this._keyManager = new KeyManager(this._audioManager, this._osdManager, this._settings);
    }

    /**
     * Called when the extension is disabled. Cleans up all resources
     * in reverse dependency order to ensure complete garbage collection.
     */
    disable() {
        // Unregister global keybindings and restore system media keys
        this._keyManager.destroy();
        this._keyManager = null;

        // Destroy UI actors, remove timers, and disconnect audio signals
        this._osdManager.destroy();
        this._osdManager = null;

        // Disconnect mixer control and stream notify signal handlers
        this._audioManager.destroy();
        this._audioManager = null;

        this._settings = null;
    }
}
