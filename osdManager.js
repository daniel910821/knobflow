import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Helper to construct a vertical St.BoxLayout.
 * Standardized for GNOME Shell 45-51 using Clutter.Orientation.VERTICAL.
 */
function _createVerticalBox(props = {}) {
    return new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        ...props,
    });
}

/**
 * OsdManager
 *
 * Manages on-screen visual feedback when volume changes or applications are cycled.
 *
 * Supports two distinct display modes:
 * 1. Stock GNOME OSD ('stock'): Uses Main.osdWindowManager.showAll to display
 *    the standard GNOME volume popup with app icon and name.
 * 2. Custom HUD Switcher ('custom'): Displays a centered, translucent overlay showing
 *    all active audio streams as cards, along with the volume level and mute state.
 */
export const OsdManager = GObject.registerClass(
class OsdManager extends GObject.Object {
    _init(audioManager, settings) {
        super._init();
        this._audioManager = audioManager;
        this._settings = settings;

        this._hideTimeoutId = 0;

        // Build the Clutter/St actor hierarchy for the custom HUD
        this._buildHUD();

        // React to changes in audio targets or volume updates from AudioManager
        this._audioSignals = [
            this._audioManager.connect('targets-changed', () => this._onTargetsChanged()),
            this._audioManager.connect('target-updated', () => this._onTargetUpdated()),
            this._audioManager.connect('active-target-changed', () => this._onActiveTargetChanged()),
        ];

        // If the user switches display style in preferences, hide the custom HUD immediately
        this._settingsSignalId = this._settings.connect('changed::osd-style', () => {
            if (this._settings.get_string('osd-style') === 'stock') {
                this._hideHUDImmediate();
            }
        });
    }

    /**
     * Cleans up all UI elements, timers, and signal connections.
     * Follows the recommended EGO teardown sequence.
     */
    destroy() {
        // 1. Remove active auto-hide timer
        if (this._hideTimeoutId) {
            GLib.Source.remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }

        // 2. Disconnect settings change listener
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        // 3. Disconnect audio manager signal listeners
        if (this._audioSignals) {
            for (const id of this._audioSignals) {
                this._audioManager.disconnect(id);
            }
            this._audioSignals = [];
        }

        // 4. Destroy the HUD container actor from Main.uiGroup
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }

        // 5. Clear object references
        this._audioManager = null;
        this._settings = null;
    }

    /**
     * Constructs the custom HUD widget tree and adds it to the compositor UI group.
     */
    _buildHUD() {
        // Top-level container box with translucent styling and rounded corners
        this._container = _createVerticalBox({
            name: 'KnobFlowHudContainer',
            style_class: 'knobflow-hud',
            reactive: false,
            visible: false,
            opacity: 0,
        });

        // Horizontal row containing individual application stream cards
        this._cardsRow = new St.BoxLayout({
            style_class: 'knobflow-cards-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._container.add_child(this._cardsRow);

        // Active target details box (application name, percentage, volume bar)
        this._detailBox = _createVerticalBox({
            style_class: 'knobflow-detail-box',
            x_align: Clutter.ActorAlign.FILL,
        });

        const headerBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.FILL,
        });

        // Active app or system label
        this._detailTitle = new St.Label({
            style_class: 'knobflow-detail-title',
            text: _('System'),
            x_expand: true,
        });
        headerBox.add_child(this._detailTitle);

        // Volume percentage indicator (e.g., '75%' or 'MUTED')
        this._detailPercent = new St.Label({
            style_class: 'knobflow-detail-percent',
            text: '100%',
        });
        headerBox.add_child(this._detailPercent);

        this._detailBox.add_child(headerBox);

        // Horizontal volume level progress bar track
        this._barTrack = new St.Widget({
            style_class: 'knobflow-bar-track',
            layout_manager: new Clutter.BinLayout(),
        });

        // Dynamic filled bar representing current volume level
        this._barFill = new St.Widget({
            style_class: 'knobflow-bar-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._barTrack.add_child(this._barFill);

        this._detailBox.add_child(this._barTrack);
        this._container.add_child(this._detailBox);

        // Insert container into Main.uiGroup to render on top of windows
        Main.uiGroup.add_child(this._container);
    }

    _onTargetsChanged() {
        if (this._container.visible) {
            this._renderCards();
            this._updateDetail();
        }
    }

    _onTargetUpdated() {
        if (this._container.visible) {
            this._renderCards();
            this._updateDetail();
        }
    }

    _onActiveTargetChanged() {
        if (this._container.visible) {
            this._renderCards();
            this._updateDetail();
        }
    }

    /**
     * Renders cards for each discovered audio target.
     * Highlights the card corresponding to the currently active stream.
     */
    _renderCards() {
        this._cardsRow.destroy_all_children();

        const targets = this._audioManager.getTargets();
        const activeTarget = this._audioManager.getActiveTarget();
        const activeId = activeTarget ? activeTarget.id : 'system';

        for (const target of targets) {
            const isActive = target.id === activeId;
            const card = _createVerticalBox({
                style_class: `knobflow-card ${isActive ? 'knobflow-card-active' : ''}`,
                x_align: Clutter.ActorAlign.CENTER,
            });

            // Card icon (prefers Gio.Icon from Shell.AppSystem, falls back to symbolic icon)
            let iconActor;
            if (target.gicon) {
                iconActor = new St.Icon({
                    gicon: target.gicon,
                    style_class: 'knobflow-card-icon',
                });
            } else {
                iconActor = new St.Icon({
                    icon_name: target.iconName || 'audio-volume-high-symbolic',
                    style_class: 'knobflow-card-icon',
                });
            }

            // Ensure symbolic icons (e.g. System speaker/volume) are rendered in bright white rather than dark theme fallback
            if (target.isSystem || (target.iconName && target.iconName.includes('symbolic'))) {
                iconActor.style = isActive ? 'color: #ffffff;' : 'color: rgba(255, 255, 255, 0.9);';
            }

            card.add_child(iconActor);

            // Card name label (truncated to 10 chars to maintain compact HUD dimensions)
            let shortName = target.name || 'App';
            if (shortName.length > 10)
                shortName = `${shortName.substring(0, 9)}…`;

            const nameLabel = new St.Label({
                style_class: `knobflow-card-name ${isActive ? 'knobflow-card-name-active' : ''}`,
                text: shortName,
            });
            card.add_child(nameLabel);

            this._cardsRow.add_child(card);
        }
    }

    /**
     * Updates detail text and progress bar width based on active target's volume state.
     */
    _updateDetail() {
        const target = this._audioManager.getActiveTarget();
        if (!target)
            return;

        this._detailTitle.text = target.name || _('System');

        // Toggle muted style classes
        if (target.isMuted) {
            this._detailPercent.text = _('MUTED');
            this._detailPercent.add_style_class_name('knobflow-detail-percent-muted');
            this._barFill.add_style_class_name('knobflow-bar-fill-muted');
        } else {
            this._detailPercent.text = `${target.volumePercent}%`;
            this._detailPercent.remove_style_class_name('knobflow-detail-percent-muted');
            this._barFill.remove_style_class_name('knobflow-bar-fill-muted');
        }

        // Calculate proportional width of the volume progress bar
        const trackWidth = 240;
        const fillWidth = Math.max(4, Math.round((target.volumePercent / 100) * trackWidth));
        this._barFill.set_width(fillWidth);
    }

    /**
     * Centers the HUD container on the user's primary monitor.
     */
    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        if (!monitor)
            return;

        const [, natWidth] = this._container.get_preferred_width(-1);
        const [, natHeight] = this._container.get_preferred_height(natWidth);

        const x = monitor.x + Math.floor((monitor.width - natWidth) / 2);
        const y = monitor.y + Math.floor((monitor.height - natHeight) / 2);

        this._container.set_position(x, y);
    }

    /**
     * Public method to display the appropriate on-screen indicator.
     */
    showOSD() {
        const style = this._settings.get_string('osd-style') || 'stock';
        const target = this._audioManager.getActiveTarget();
        if (!target)
            return;

        if (style === 'stock') {
            this._showStockOSD(target);
        } else {
            this._showCustomHUD();
        }
    }

    /**
     * Triggers the stock GNOME Shell OSD popup via Main.osdWindowManager.
     */
    _showStockOSD(target) {
        let icon;
        if (target.isMuted) {
            icon = new Gio.ThemedIcon({ name: 'audio-volume-muted-symbolic' });
        } else if (target.isSystem) {
            const vol = target.volumePercent;
            const iconName = vol < 33
                ? 'audio-volume-low-symbolic'
                : vol < 66
                    ? 'audio-volume-medium-symbolic'
                    : 'audio-volume-high-symbolic';
            icon = new Gio.ThemedIcon({ name: iconName });
        } else {
            icon = target.gicon || new Gio.ThemedIcon({ name: target.iconName || 'audio-card-symbolic' });
        }

        const level = target.isMuted ? 0 : target.volumePercent / 100;
        const maxLevel = 1.0;
        const label = target.name || null;

        Main.osdWindowManager.showAll(icon, label, level, maxLevel);
    }

    /**
     * Displays the custom translucent centered HUD with smooth Clutter fade-in animation.
     */
    _showCustomHUD() {
        this._renderCards();
        this._updateDetail();

        this._container.show();
        this._reposition();

        // Animate fade-in
        this._container.remove_all_transitions();
        this._container.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Reset auto-hide timer
        if (this._hideTimeoutId) {
            GLib.Source.remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }

        const timeoutMs = this._settings.get_int('hud-timeout-ms') || 2000;
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            this._hideHUD();
            this._hideTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Immediately hides and cancels transitions for the custom HUD.
     */
    _hideHUDImmediate() {
        if (this._hideTimeoutId) {
            GLib.Source.remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        this._container.remove_all_transitions();
        this._container.opacity = 0;
        this._container.hide();
    }

    /**
     * Smoothly fades out the HUD container before setting visible = false.
     */
    _hideHUD() {
        this._container.remove_all_transitions();
        this._container.ease({
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._container.hide();
            },
        });
    }
});
