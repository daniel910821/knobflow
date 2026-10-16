import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

/**
 * KnobFlowPreferences
 *
 * Implements the Libadwaita / GTK4 preferences window for KnobFlow.
 *
 * Process Isolation Architecture:
 * - This file is executed by the standalone 'gnome-extensions prefs' process.
 * - It MUST strictly avoid importing Clutter, St, or Shell internal libraries.
 * - Settings are persisted directly to GSettings ('org.gnome.shell.extensions.knobflow').
 */
export default class KnobFlowPreferences extends ExtensionPreferences {
    /**
     * Constructs the preferences window layout using modern Libadwaita widgets.
     */
    fillPreferencesWindow(window) {
        this.initTranslations();
        const settings = this.getSettings();

        // Top-level preferences page
        const page = new Adw.PreferencesPage({
            title: _('KnobFlow'),
            icon_name: 'audio-volume-high-symbolic',
        });
        window.add(page);

        // ── Group 1: General & Display ──────────────────────────────────────
        const generalGroup = new Adw.PreferencesGroup({
            title: _('Display &amp; Behavior'),
            description: _('Configure on-screen display and volume parameters.'),
        });
        page.add(generalGroup);

        // 1. OSD Display Style Selector (Stock GNOME vs Custom HUD)
        const osdModel = new Gtk.StringList();
        osdModel.append(_('Stock GNOME OSD (Native)'));
        osdModel.append(_('Custom HUD Switcher (Centered)'));

        const currentStyle = settings.get_string('osd-style') || 'stock';
        const osdRow = new Adw.ComboRow({
            title: _('OSD Display Style'),
            subtitle: _('Choose between GNOME native volume OSD and custom centered HUD'),
            model: osdModel,
            selected: currentStyle === 'custom' ? 1 : 0,
        });

        osdRow.connect('notify::selected', () => {
            const style = osdRow.selected === 1 ? 'custom' : 'stock';
            settings.set_string('osd-style', style);
        });
        generalGroup.add(osdRow);

        // 2. Volume Step (%) Spin Row
        const stepRow = new Adw.SpinRow({
            title: _('Volume Step (%)'),
            subtitle: _('Percentage volume change per knob rotation step'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 25,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('volume-step'),
            }),
        });
        settings.bind('volume-step', stepRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(stepRow);

        // 3. Active-only apps filter switch
        const activeOnlyRow = new Adw.SwitchRow({
            title: _('Only Active Audio Streams'),
            subtitle: _('Exclude applications that are currently silent or paused'),
            active: settings.get_boolean('active-only'),
        });
        settings.bind('active-only', activeOnlyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(activeOnlyRow);

        // 4. Custom HUD display duration (ms)
        const timeoutRow = new Adw.SpinRow({
            title: _('HUD Duration (ms)'),
            subtitle: _('Display duration for custom HUD before fading out'),
            adjustment: new Gtk.Adjustment({
                lower: 500,
                upper: 5000,
                step_increment: 250,
                page_increment: 500,
                value: settings.get_int('hud-timeout-ms'),
            }),
        });
        settings.bind('hud-timeout-ms', timeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(timeoutRow);

        // 5. Verbose debug logging switch
        const debugRow = new Adw.SwitchRow({
            title: _('Debug Logging'),
            subtitle: _('Print detailed audio stream detection and knob events to journalctl'),
            active: settings.get_boolean('debug-logging'),
        });
        settings.bind('debug-logging', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(debugRow);

        // ── Group 2: Knob Shortcuts & Hardware Mapping ───────────────────────
        const keysGroup = new Adw.PreferencesGroup({
            title: _('Knob Shortcuts &amp; Hardware Mapping'),
            description: _('Select common keyboard presets or record custom shortcuts.'),
        });
        page.add(keysGroup);

        // Shortcut Row 1: Knob Click (Cycle / Mute)
        this._addShortcutRow(
            window,
            keysGroup,
            settings,
            'cycle-shortcut',
            _('Knob Click (Cycle / Mute)'),
            _('Short click cycles active apps; double-click or hold toggles mute'),
            'XF86AudioMute'
        );

        // Shortcut Row 2: Knob Turn Up (Volume Up)
        this._addShortcutRow(
            window,
            keysGroup,
            settings,
            'volume-up-shortcut',
            _('Knob Turn Up (Volume Up)'),
            _('Increases volume of selected app or system'),
            'XF86AudioRaiseVolume'
        );

        // Shortcut Row 3: Knob Turn Down (Volume Down)
        this._addShortcutRow(
            window,
            keysGroup,
            settings,
            'volume-down-shortcut',
            _('Knob Turn Down (Volume Down)'),
            _('Decreases volume of selected app or system'),
            'XF86AudioLowerVolume'
        );
    }

    /**
     * Builds an action row for a keybinding setting, complete with current value label,
     * record button, and reset button.
     */
    _addShortcutRow(parentWindow, group, settings, keyName, title, subtitle, defaultKey) {
        const row = new Adw.ActionRow({
            title,
            subtitle,
        });

        const currentValues = settings.get_strv(keyName);
        const currentVal = currentValues.length > 0 ? currentValues[0] : defaultKey;

        // Current assigned key display label
        const keyLabel = new Gtk.Label({
            label: currentVal,
            css_classes: ['title-4'],
        });
        row.add_suffix(keyLabel);

        // Assign / Record button opening modal dialog
        const recordBtn = new Gtk.Button({
            label: _('Assign / Record'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });

        recordBtn.connect('clicked', () => {
            this._showRecordDialog(parentWindow, title, (detectedAccel) => {
                // Store primary shortcut and stripped XF86 variant for maximum compatibility
                const variants = [detectedAccel];
                const clean = detectedAccel.replace(/^XF86/, '');
                if (clean !== detectedAccel)
                    variants.push(clean);
                settings.set_strv(keyName, variants);
                keyLabel.set_label(detectedAccel);
            });
        });
        row.add_suffix(recordBtn);

        // Reset to default hardware key preset
        const resetBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Reset to default preset'),
        });
        resetBtn.connect('clicked', () => {
            const defaults = defaultKey === 'XF86AudioMute'
                ? ['XF86AudioMute', 'AudioMute']
                : defaultKey === 'XF86AudioRaiseVolume'
                    ? ['XF86AudioRaiseVolume', 'AudioRaiseVolume']
                    : ['XF86AudioLowerVolume', 'AudioLowerVolume'];
            settings.set_strv(keyName, defaults);
            keyLabel.set_label(defaultKey);
        });
        row.add_suffix(resetBtn);

        group.add(row);
    }

    /**
     * Displays an interactive dialog allowing the user to select popular knob presets
     * or press any key / multimedia key to record a new shortcut.
     */
    _showRecordDialog(parentWindow, targetName, onKeyRecorded) {
        const dialog = new Adw.Window({
            title: _('Assign Key / Preset'),
            modal: true,
            transient_for: parentWindow,
            default_width: 500,
            default_height: 440,
            resizable: false,
        });

        const toolbarView = new Adw.ToolbarView();
        dialog.set_content(toolbarView);

        const headerBar = new Adw.HeaderBar({
            show_end_title_buttons: true,
            show_start_title_buttons: false,
        });
        toolbarView.add_top_bar(headerBar);

        const clamp = new Adw.Clamp({
            maximum_size: 460,
            margin_top: 14,
            margin_bottom: 20,
            margin_start: 16,
            margin_end: 16,
        });
        toolbarView.set_content(clamp);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
        });
        clamp.set_child(content);

        // Header info box
        const infoBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            halign: Gtk.Align.CENTER,
        });
        const titleLabel = new Gtk.Label({
            label: targetName,
            css_classes: ['title-2'],
        });
        infoBox.append(titleLabel);

        const instructionLabel = new Gtk.Label({
            label: _('Select a hardware preset or press any key on your keyboard:'),
            css_classes: ['dim-label'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
        });
        infoBox.append(instructionLabel);
        content.append(infoBox);

        // Hardware preset buttons for standard keyboards and VIA / QMK profiles
        const presetsGroup = new Adw.PreferencesGroup({
            title: _('Common Knob Presets'),
        });
        content.append(presetsGroup);

        const presets = [
            {
                name: _('Standard Knob Click'),
                sub: _('Hardware KEY_MUTE signal (XF86AudioMute)'),
                val: 'XF86AudioMute',
            },
            {
                name: _('Standard Volume Up'),
                sub: _('Hardware KEY_VOLUMEUP signal (XF86AudioRaiseVolume)'),
                val: 'XF86AudioRaiseVolume',
            },
            {
                name: _('Standard Volume Down'),
                sub: _('Hardware KEY_VOLUMEDOWN signal (XF86AudioLowerVolume)'),
                val: 'XF86AudioLowerVolume',
            },
            {
                name: _('Play / Pause Click'),
                sub: _('Used by Keychron and QMK/VIA custom knob profiles'),
                val: 'XF86AudioPlay',
            },
        ];

        for (const p of presets) {
            const row = new Adw.ActionRow({
                title: p.name,
                subtitle: p.sub,
                activatable: true,
            });

            const selBtn = new Gtk.Button({
                label: p.val,
                valign: Gtk.Align.CENTER,
                css_classes: ['pill'],
            });
            const choose = () => {
                onKeyRecorded(p.val);
                dialog.close();
            };
            row.connect('activated', choose);
            selBtn.connect('clicked', choose);
            row.add_suffix(selBtn);
            presetsGroup.add(row);
        }

        // Cancel button
        const cancelBtn = new Gtk.Button({
            label: _('Cancel'),
            halign: Gtk.Align.CENTER,
            margin_top: 8,
        });
        cancelBtn.connect('clicked', () => dialog.close());
        content.append(cancelBtn);

        // Key Controller with CAPTURE phase to intercept keyboard events before child widgets
        const controller = new Gtk.EventControllerKey();
        controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            // Dismiss dialog on Escape
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }

            // Mask out non-standard modifier states (e.g. NumLock, CapsLock)
            const cleanState = state & (
                Gdk.ModifierType.SHIFT_MASK |
                Gdk.ModifierType.CONTROL_MASK |
                Gdk.ModifierType.ALT_MASK |
                Gdk.ModifierType.SUPER_MASK
            );

            // Convert raw keyval and modifiers to Gtk accelerator string
            const accel = Gtk.accelerator_name(keyval, cleanState);
            // Ignore standalone modifier key presses
            if (accel && !['Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Super_L', 'Super_R'].includes(accel)) {
                onKeyRecorded(accel);
                dialog.close();
                return true;
            }
            return false;
        });

        dialog.add_controller(controller);
        dialog.present();
    }
}
