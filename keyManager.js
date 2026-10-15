import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * KeyManager
 *
 * Manages global keyboard shortcuts for the hardware knob (volume up, volume down, click).
 *
 * How shortcut routing works in GNOME Shell:
 * 1. By default, 'gnome-settings-daemon' (media-keys plugin) acquires compositor grabs
 *    in Mutter for XF86AudioRaiseVolume, XF86AudioLowerVolume, and XF86AudioMute.
 * 2. To allow KnobFlow to intercept these keys and route volume changes to specific apps,
 *    KeyManager temporarily clears those bindings in 'org.gnome.settings-daemon.plugins.media-keys'.
 * 3. Once gsd releases the compositor grabs, KeyManager registers its own handlers with
 *    Mutter via `Main.wm.addKeybinding()`.
 * 4. When KnobFlow is disabled, the original gsd-media-keys settings are fully restored.
 */
export const KeyManager = GObject.registerClass(
class KeyManager extends GObject.Object {
    _init(audioManager, osdManager, settings) {
        super._init();
        this._audioManager = audioManager;
        this._osdManager = osdManager;
        this._settings = settings;

        // Timing tracker for distinguishing single-click (cycle app) vs double-click (mute)
        this._lastClickTime = 0;
        this._pendingCycleTimeoutId = 0;
        this._boundKeys = [];
        this._retryTimeoutId = 0;
        this._retried = false;

        // Auto-heal any legacy or invalid shortcut definitions (e.g., raw kernel KEY_ names)
        this._sanitizeSettings();

        // Check if gsd-media-keys schema is available on the system
        const schemaSource = Gio.SettingsSchemaSource.get_default();
        if (schemaSource && schemaSource.lookup('org.gnome.settings-daemon.plugins.media-keys', true)) {
            this._mediaSettings = new Gio.Settings({
                schema_id: 'org.gnome.settings-daemon.plugins.media-keys',
            });
            this._takeoverMediaKeys();
        }

        // Allow ~120ms for gsd-media-keys to ungrab Mutter keys before registering our bindings
        this._retryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._retryTimeoutId = 0;
            this._registerBindings();
            return GLib.SOURCE_REMOVE;
        });

        // Listen for shortcut preference changes in the preferences dialog
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key.includes('shortcut')) {
                this._unregisterBindings();
                this._registerBindings();
            }
        });
    }

    /**
     * Verifies that shortcuts conform to standard X11/XKB accelerator names.
     * Prevents raw Linux kernel key names (such as KEY_MUTE) from breaking keybindings.
     */
    _sanitizeSettings() {
        const sanitizeKey = (keyName, defaultValues, kernelPattern) => {
            const vals = this._settings.get_strv(keyName);
            const needsFix = vals.length === 0 || vals.some(v => kernelPattern.test(v));
            if (needsFix)
                this._settings.set_strv(keyName, defaultValues);
        };

        sanitizeKey('cycle-shortcut', ['XF86AudioMute', 'AudioMute'], /KEY_MUTE|^MUTE$/i);
        sanitizeKey('volume-up-shortcut', ['XF86AudioRaiseVolume', 'AudioRaiseVolume'], /KEY_VOLUMEUP|^VOLUMEUP$/i);
        sanitizeKey('volume-down-shortcut', ['XF86AudioLowerVolume', 'AudioLowerVolume'], /KEY_VOLUMEDOWN|^VOLUMEDOWN$/i);
    }

    /**
     * Cleans up all resources: removes active timeouts, disconnects signals,
     * unregisters compositor keybindings, and restores original media keys.
     */
    destroy() {
        // 1. Remove active GLib timeouts
        if (this._retryTimeoutId) {
            GLib.Source.remove(this._retryTimeoutId);
            this._retryTimeoutId = 0;
        }

        if (this._pendingCycleTimeoutId) {
            GLib.Source.remove(this._pendingCycleTimeoutId);
            this._pendingCycleTimeoutId = 0;
        }

        // 2. Disconnect settings change listener
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        // 3. Remove compositor bindings and restore original system shortcuts
        this._unregisterBindings();
        this._restoreMediaKeys();

        // 4. Clear references
        this._audioManager = null;
        this._osdManager = null;
        this._settings = null;
    }

    /**
     * Backs up and empties gsd-media-keys bindings so Mutter yields media keys to our extension.
     */
    _takeoverMediaKeys() {
        if (!this._mediaSettings)
            return;

        // Cache original values to restore when disabled
        this._origMuteStatic = this._mediaSettings.get_strv('volume-mute-static');
        this._origUpStatic = this._mediaSettings.get_strv('volume-up-static');
        this._origDownStatic = this._mediaSettings.get_strv('volume-down-static');

        this._origMute = this._mediaSettings.get_strv('volume-mute');
        this._origUp = this._mediaSettings.get_strv('volume-up');
        this._origDown = this._mediaSettings.get_strv('volume-down');

        // Clear static volume/mute shortcuts in gsd-media-keys
        this._mediaSettings.set_strv('volume-mute-static', []);
        this._mediaSettings.set_strv('volume-up-static', []);
        this._mediaSettings.set_strv('volume-down-static', []);

        // Clear dynamic volume/mute shortcuts in gsd-media-keys if set
        if (this._origMute.length > 0)
            this._mediaSettings.set_strv('volume-mute', []);
        if (this._origUp.length > 0)
            this._mediaSettings.set_strv('volume-up', []);
        if (this._origDown.length > 0)
            this._mediaSettings.set_strv('volume-down', []);
    }

    /**
     * Restores original media-keys bindings in gsd-media-keys.
     */
    _restoreMediaKeys() {
        if (!this._mediaSettings)
            return;

        // Restore static shortcuts
        if (this._origMuteStatic && this._origMuteStatic.length > 0)
            this._mediaSettings.set_strv('volume-mute-static', this._origMuteStatic);
        if (this._origUpStatic && this._origUpStatic.length > 0)
            this._mediaSettings.set_strv('volume-up-static', this._origUpStatic);
        if (this._origDownStatic && this._origDownStatic.length > 0)
            this._mediaSettings.set_strv('volume-down-static', this._origDownStatic);

        // Restore dynamic shortcuts
        if (this._origMute && this._origMute.length > 0)
            this._mediaSettings.set_strv('volume-mute', this._origMute);
        if (this._origUp && this._origUp.length > 0)
            this._mediaSettings.set_strv('volume-up', this._origUp);
        if (this._origDown && this._origDown.length > 0)
            this._mediaSettings.set_strv('volume-down', this._origDown);

        this._mediaSettings = null;
    }

    /**
     * Registers the volume-up, volume-down, and cycle keybindings via Mutter.
     */
    _registerBindings() {
        this._unregisterBindings();

        // Volume Up knob rotation (IGNORE_AUTOREPEAT prevents rapid event storms)
        const okUp = this._bind(
            'volume-up-shortcut',
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            () => this._onVolumeUp()
        );

        // Volume Down knob rotation
        const okDown = this._bind(
            'volume-down-shortcut',
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            () => this._onVolumeDown()
        );

        // Knob click (cycle active target or toggle mute on double click)
        const okCycle = this._bind(
            'cycle-shortcut',
            Meta.KeyBindingFlags.NONE,
            () => this._onCyclePress()
        );

        // If gsd hasn't fully ungrabbed yet, retry registration once after 250ms
        if ((!okUp || !okDown || !okCycle) && !this._retried) {
            this._retried = true;
            this._retryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._retryTimeoutId = 0;
                this._registerBindings();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Helper to bind a single keybinding via Main.wm.
     */
    _bind(name, flags, callback) {
        const action = Main.wm.addKeybinding(
            name,
            this._settings,
            flags,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            callback
        );
        if (action !== Meta.KeyBindingAction.NONE) {
            this._boundKeys.push(name);
            return true;
        }
        return false;
    }

    /**
     * Unregisters all active keybindings from Mutter.
     */
    _unregisterBindings() {
        for (const name of this._boundKeys) {
            Main.wm.removeKeybinding(name);
        }
        this._boundKeys = [];
    }

    /**
     * Handler for volume up knob rotation: increments volume and displays OSD.
     */
    _onVolumeUp() {
        const step = this._settings.get_int('volume-step') || 5;
        this._audioManager.changeVolume(step);
        this._osdManager.showOSD();
    }

    /**
     * Handler for volume down knob rotation: decrements volume and displays OSD.
     */
    _onVolumeDown() {
        const step = this._settings.get_int('volume-step') || 5;
        this._audioManager.changeVolume(-step);
        this._osdManager.showOSD();
    }

    /**
     * Handler for knob click:
     * - Double click (< 400ms): Toggles mute on the active target.
     * - Single click (debounced at 260ms): Cycles to the next audio target.
     */
    _onCyclePress() {
        const now = GLib.get_monotonic_time();
        const doubleClickThresholdUs = 400 * 1000; // 400ms threshold in microseconds

        // Check if this click occurred within the double-click threshold
        if (this._pendingCycleTimeoutId && (now - this._lastClickTime < doubleClickThresholdUs)) {
            // Cancel the single-click debounce timer
            GLib.Source.remove(this._pendingCycleTimeoutId);
            this._pendingCycleTimeoutId = 0;
            this._lastClickTime = 0;

            // Execute MUTE / UNMUTE on the active audio stream
            this._audioManager.toggleMute();
            this._osdManager.showOSD();
            return;
        }

        this._lastClickTime = now;

        // Remove any existing timer before scheduling a new one
        if (this._pendingCycleTimeoutId) {
            GLib.Source.remove(this._pendingCycleTimeoutId);
            this._pendingCycleTimeoutId = 0;
        }

        // Single click: wait 260ms before cycling to ensure it is not a double-click
        this._pendingCycleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
            this._pendingCycleTimeoutId = 0;
            this._audioManager.cycleNext();
            this._osdManager.showOSD();
            return GLib.SOURCE_REMOVE;
        });
    }
});
