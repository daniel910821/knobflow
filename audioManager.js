import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Gvc from 'gi://Gvc';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * AudioManager
 *
 * Interfaces directly with GNOME Shell's audio subsystem (Gvc / PulseAudio / PipeWire).
 *
 * Key Responsibilities:
 * 1. Obtains the shared Gvc.MixerControl from GNOME Shell's Volume status menu.
 * 2. Tracks available audio targets: the Default Sink (Master system volume) and
 *    active Application Sink Inputs (per-app volume streams).
 * 3. Resolves friendly application names, desktop IDs, and icons using Shell.AppSystem
 *    and Mutter window heuristics (supporting web apps like Spotify Web and YouTube).
 * 4. Modifies volume levels and mute states for the currently selected audio target.
 */
export const AudioManager = GObject.registerClass({
    Signals: {
        'targets-changed': {},
        'target-updated': {
            param_types: [GObject.TYPE_STRING],
        },
        'active-target-changed': {
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class AudioManager extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;

        // Reuse GNOME Shell's existing mixer control instance
        this._control = Volume.getMixerControl();
        this._activeTargetId = 'system';
        this._streamSignalIds = new Map();
        this._targets = [];

        // Connect to mixer state and stream lifecycle events
        this._controlSignalIds = [
            this._control.connect('state-changed', () => this._onStateChanged()),
            this._control.connect('default-sink-changed', () => this._updateTargets()),
            this._control.connect('stream-added', (_c, id) => this._onStreamAdded(id)),
            this._control.connect('stream-removed', (_c, id) => this._onStreamRemoved(id)),
        ];

        // Listen for preference changes (e.g., active-only streams filter)
        this._settingsSignalId = this._settings.connect('changed::active-only', () => {
            this._updateTargets();
        });

        // Initial scan of audio streams
        this._updateTargets();
    }

    /**
     * Disconnects all signal listeners and clears stream caches.
     */
    destroy() {
        // Disconnect settings listener
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        // Disconnect stream-specific notify handlers
        for (const [stream, signalIds] of this._streamSignalIds) {
            for (const sigId of signalIds) {
                if (GObject.signal_handler_is_connected(stream, sigId))
                    stream.disconnect(sigId);
            }
        }
        this._streamSignalIds.clear();

        // Disconnect mixer control handlers
        if (this._control && this._controlSignalIds) {
            for (const id of this._controlSignalIds) {
                if (GObject.signal_handler_is_connected(this._control, id))
                    this._control.disconnect(id);
            }
            this._controlSignalIds = [];
        }

        this._targets = [];
        this._control = null;
        this._settings = null;
    }

    /**
     * Internal debug logging helper, active when 'debug-logging' is enabled in settings.
     */
    _logDebug(message) {
        if (this._settings && this._settings.get_boolean('debug-logging')) {
            console.log(`[KnobFlow Debug] ${message}`);
        }
    }

    /**
     * Triggered when Gvc finishes connecting to the audio server.
     */
    _onStateChanged() {
        this._logDebug(`Mixer control state: ${this._control.get_state()}`);
        if (this._control.get_state() === Gvc.MixerControlState.READY) {
            this._updateTargets();
        }
    }

    /**
     * Triggered when a new audio stream appears (e.g., an app starts playback).
     */
    _onStreamAdded(id) {
        this._logDebug(`Stream added to mixer: id=${id}`);
        this._updateTargets();
    }

    /**
     * Triggered when an audio stream closes. Reverts to System if the closed stream was active.
     */
    _onStreamRemoved(id) {
        this._logDebug(`Stream removed from mixer: id=${id}`);
        const streamIdStr = id.toString();
        if (this._activeTargetId === streamIdStr) {
            this._activeTargetId = 'system';
            this.emit('active-target-changed', 'system');
        }
        this._updateTargets();
    }

    /**
     * Connects notify signals to monitor external volume or mute changes on a stream.
     */
    _connectStream(stream) {
        if (!stream || this._streamSignalIds.has(stream))
            return;

        const ids = [
            stream.connect('notify::volume', () => this._onStreamVolumeNotify(stream)),
            stream.connect('notify::is-muted', () => this._onStreamVolumeNotify(stream)),
            stream.connect('notify::state', () => this._updateTargets()),
        ];
        this._streamSignalIds.set(stream, ids);
    }

    /**
     * Emits target-updated when an application changes its volume internally.
     */
    _onStreamVolumeNotify(stream) {
        const target = this._targets.find(t => t.stream === stream);
        if (target) {
            target.volumePercent = this._calcVolumePercent(stream);
            target.isMuted = Boolean(stream.is_muted);
            this.emit('target-updated', target.id);
        }
    }

    /**
     * Computes percentage volume (0-100) from Gvc's normalized volume range.
     */
    _calcVolumePercent(stream) {
        if (!stream)
            return 0;
        const maxNorm = this._control.get_vol_max_norm();
        if (maxNorm <= 0)
            return 0;
        return Math.min(100, Math.round((stream.get_volume() / maxNorm) * 100));
    }

    /**
     * Checks if a string is a generic or meaningless audio backend description.
     */
    _isGenericString(str) {
        if (!str || typeof str !== 'string')
            return true;
        const s = str.trim().toLowerCase();
        return (
            s === '' ||
            s === 'playback' ||
            s === 'audio' ||
            s === 'stream' ||
            s === 'audio stream' ||
            s === 'output' ||
            s === 'audio output' ||
            s === 'alsa playback' ||
            s === 'audiocallbackdriver' ||
            s === 'pulseaudio' ||
            s === 'pipewire' ||
            s === 'application' ||
            s === 'unknown'
        );
    }

    /**
     * Resolves human-readable application name and icons for an audio stream.
     * Uses a multi-tier lookup hierarchy:
     * 1. Direct Shell.AppSystem lookup using application_id, icon_name, or stream name.
     * 2. Fuzzy matching against currently running applications.
     * 3. Browser-specific window title inspection for web players (e.g. YouTube Music, YouTube, Spotify Web).
     */
    _resolveAppInfo(stream, usedMediaTitles = new Set()) {
        const appId = stream.get_application_id() || '';
        const streamName = stream.get_name() || '';
        const streamDesc = stream.get_description() || '';
        const iconName = stream.get_icon_name() || '';
        let gicon = stream.get_gicon();

        this._logDebug(`Evaluating stream id=${stream.get_id()}: appId="${appId}", streamName="${streamName}", desc="${streamDesc}", icon="${iconName}"`);

        const appSys = Shell.AppSystem.get_default();
        let app = null;

        // 1. Build candidates list for Shell.AppSystem lookup (including Snap package naming)
        const candidates = [];
        if (appId) {
            candidates.push(
                appId,
                `${appId}.desktop`,
                `${appId}_${appId}.desktop`,
                `snap.${appId}.${appId}.desktop`
            );
            if (appId.includes('.')) {
                const parts = appId.split('.');
                const last = parts[parts.length - 1];
                candidates.push(last, `${last}.desktop`, `${last}_${last}.desktop`);
            }
        }
        if (iconName && !this._isGenericString(iconName)) {
            candidates.push(iconName, `${iconName}.desktop`);
        }
        if (streamName && !this._isGenericString(streamName)) {
            const s = streamName.trim();
            candidates.push(s, `${s}.desktop`);
            candidates.push(s.toLowerCase(), `${s.toLowerCase()}.desktop`);
            const hyphenated = s.toLowerCase().replace(/\s+/g, '-');
            candidates.push(hyphenated, `${hyphenated}.desktop`);
            const spaceless = s.toLowerCase().replace(/[\s\-_]+/g, '');
            candidates.push(spaceless, `${spaceless}.desktop`);
        }

        for (const c of candidates) {
            if (c) {
                app = appSys.lookup_app(c);
                if (app)
                    break;
            }
        }

        // 2. Fuzzy match against running apps if not found directly
        if (!app && appSys.get_running) {
            const runningApps = appSys.get_running();
            const norm = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const targetStream = norm(streamName);
            const targetIcon = norm(iconName);
            const targetId = norm(appId);

            for (const rApp of runningApps) {
                const rName = norm(rApp.get_name());
                const rId = norm(rApp.get_id());
                if ((targetStream && (rName === targetStream || rId.includes(targetStream))) ||
                    (targetIcon && (rId.includes(targetIcon) || rName.includes(targetIcon))) ||
                    (targetId && (rId.includes(targetId) || rName.includes(targetId)))) {
                    app = rApp;
                    break;
                }
            }
        }

        // 3. Extract base name and icon
        let name = '';
        if (app) {
            name = app.get_name();
            gicon = app.get_icon() || gicon;
        } else if (!this._isGenericString(streamName)) {
            name = streamName;
        } else if (!this._isGenericString(streamDesc)) {
            name = streamDesc;
        } else if (!this._isGenericString(iconName)) {
            name = iconName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        } else {
            name = _('Application');
        }

        // 4. Web browser media stream detection (YouTube Music, YouTube, Spotify Web, etc.)
        // ONLY perform window title analysis if the stream belongs to a generic web browser!
        // Never override native desktop apps like Spotify, VLC, Discord, etc.
        const isBrowser = (app && /chrome|chromium|firefox|brave|edge|opera|epiphany|browser/i.test(app.get_id() || '')) ||
            (app && /chrome|chromium|firefox|brave|edge|opera|browser/i.test(app.get_name() || '')) ||
            /chrome|chromium|firefox|brave|edge|opera|browser/i.test(appId || '');

        if (isBrowser) {
            const mediaTitle = this._detectBrowserMediaTitle(app, appId, usedMediaTitles);
            if (mediaTitle) {
                name = mediaTitle;
                usedMediaTitles.add(mediaTitle);
            }
        }

        this._logDebug(`Stream id=${stream.get_id()} finalized target name: "${name}"`);

        const fallbackIcon = iconName || 'audio-card-symbolic';
        return { name, gicon, iconName: fallbackIcon };
    }

    /**
     * Inspects active MPRIS players managed by GNOME Shell.
     * Returns a list of playing track titles.
     */
    _getPlayingMprisTracks() {
        const tracks = [];
        const messageList = Main.panel?.statusArea?.dateMenu?._messageList;
        const mediaSource = messageList ? messageList._mediaSource : null;
        if (mediaSource && mediaSource.players) {
            for (const player of mediaSource.players) {
                if (player.status === 'Playing') {
                    if (player.trackTitle)
                        tracks.push(player.trackTitle.toLowerCase());
                    if (Array.isArray(player.trackArtists)) {
                        for (const artist of player.trackArtists) {
                            if (artist)
                                tracks.push(artist.toLowerCase());
                        }
                    }
                }
            }
        }
        return tracks;
    }

    /**
     * Inspects browser windows to identify specific active web players.
     * Crucially differentiates between 'YouTube Music' and standard 'YouTube'
     * by scoring candidates across all windows rather than relying on first match.
     */
    _detectBrowserMediaTitle(app, appId, usedMediaTitles) {
        const windows = [];
        if (app && typeof app.get_windows === 'function') {
            windows.push(...app.get_windows());
        }

        // Also inspect open windows to catch Chrome PWAs (StartupWMClass=crx_*) or detached browser windows
        if (global.display && typeof global.display.get_tab_list === 'function') {
            const tabList = global.display.get_tab_list(Meta.TabList.NORMAL, null);
            const tracker = Shell.WindowTracker.get_default();

            for (const win of tabList) {
                if (windows.includes(win))
                    continue;

                const wmClass = (win.get_wm_class() || '').toLowerCase();
                const gtkId = (win.get_gtk_application_id() || '').toLowerCase();
                const winApp = tracker ? tracker.get_window_app(win) : null;
                const winAppId = winApp ? (winApp.get_id() || '').toLowerCase() : '';
                const winAppName = winApp ? (winApp.get_name() || '').toLowerCase() : '';

                // Match browser windows and web apps (Chrome PWAs use crx_ or chrome-*)
                const isBrowserOrWebApp =
                    wmClass.includes('chrome') ||
                    wmClass.includes('chromium') ||
                    wmClass.includes('firefox') ||
                    wmClass.includes('brave') ||
                    wmClass.includes('edge') ||
                    wmClass.includes('opera') ||
                    wmClass.startsWith('crx_') ||
                    gtkId.includes('chrome') ||
                    winAppId.includes('chrome') ||
                    winAppName.includes('chrome') ||
                    winAppName.includes('youtube');

                if (isBrowserOrWebApp) {
                    windows.push(win);
                }
            }
        }

        this._logDebug(`Browser detection found ${windows.length} window(s) for appId="${appId}"`);

        const tracker = Shell.WindowTracker.get_default();
        const playingTracks = this._getPlayingMprisTracks();
        if (playingTracks.length > 0) {
            this._logDebug(`  Active MPRIS playing tracks: ${playingTracks.join(', ')}`);
        }

        const candidates = [];

        for (const win of windows) {
            const title = (win.get_title() || '').trim();
            const wmClass = win.get_wm_class() || '';
            const winApp = tracker ? tracker.get_window_app(win) : null;
            const winAppName = winApp ? (winApp.get_name() || '').trim() : '';
            const winAppId = winApp ? (winApp.get_id() || '').trim() : '';

            this._logDebug(`  - Checking window: title="${title}", wmClass="${wmClass}", winApp="${winAppName}"`);

            if (!title && !winAppName)
                continue;

            let candidate = null;
            let score = 0;

            // 1. YouTube Music MUST be evaluated before standard YouTube!
            // Matches titles like: "Song Name • Artist - YouTube Music", "YouTube Music", "music.youtube.com", or PWA name "YouTube Music"
            if (
                /youtube\s*music/i.test(title) ||
                /music\.youtube/i.test(title) ||
                /yt\s*music/i.test(title) ||
                (winAppName && /youtube\s*music/i.test(winAppName)) ||
                (winAppId && /youtube\s*music/i.test(winAppId))
            ) {
                candidate = 'YouTube Music';
                score = 80;
            } else if (
                /youtube/i.test(title) ||
                /\byoutube\.com\b/i.test(title) ||
                (winAppName && /youtube/i.test(winAppName))
            ) {
                candidate = 'YouTube';
                score = 40;
            } else if (/spotify/i.test(title) || (winAppName && /spotify/i.test(winAppName))) {
                candidate = 'Spotify';
                score = 80;
            } else if (/soundcloud/i.test(title)) {
                candidate = 'SoundCloud';
                score = 80;
            } else if (/apple\s*music/i.test(title)) {
                candidate = 'Apple Music';
                score = 80;
            } else if (/amazon\s*music/i.test(title)) {
                candidate = 'Amazon Music';
                score = 80;
            } else if (/netflix/i.test(title)) {
                candidate = 'Netflix';
                score = 40;
            } else if (/twitch/i.test(title)) {
                candidate = 'Twitch';
                score = 40;
            } else if (/tidal/i.test(title)) {
                candidate = 'Tidal';
                score = 80;
            } else if (/deezer/i.test(title)) {
                candidate = 'Deezer';
                score = 80;
            } else if (/bandcamp/i.test(title)) {
                candidate = 'Bandcamp';
                score = 80;
            }

            if (!candidate)
                continue;

            // Dedicated Web App / PWA bonus: standalone apps are explicitly launched for audio playback
            const isDedicatedApp = (winAppName && winAppName.toLowerCase() === candidate.toLowerCase()) ||
                wmClass.toLowerCase().startsWith('chrome-') ||
                wmClass.toLowerCase().startsWith('crx_');
            if (isDedicatedApp)
                score += 100;

            // MPRIS active playing track correlation bonus
            const lowerTitle = title.toLowerCase();
            if (playingTracks.some(track => track.length > 3 && lowerTitle.includes(track)))
                score += 50;

            // Active / focused window bonus
            if (win.has_focus && win.has_focus())
                score += 10;

            candidates.push({ candidate, score, title, winAppName });
        }

        // Sort candidates by score descending to prioritize dedicated apps and music players over generic tabs
        candidates.sort((a, b) => b.score - a.score);

        this._logDebug(`  Candidate matches (sorted): ${candidates.map(c => `${c.candidate} [score:${c.score}]`).join(', ') || 'none'}`);

        // Select the highest-scoring candidate not yet claimed
        for (const { candidate } of candidates) {
            const alreadyUsed = usedMediaTitles.has(candidate);
            if (!alreadyUsed) {
                this._logDebug(`    -> Selected candidate: "${candidate}"`);
                return candidate;
            }
        }

        return null;
    }

    /**
     * Rebuilds the internal list of audio targets from Gvc sink inputs.
     */
    _updateTargets() {
        this._logDebug('--- Updating Audio Targets ---');
        const activeOnly = this._settings.get_boolean('active-only');
        const newTargets = [];

        // 1. Default sink: Master System Audio
        const defaultSink = this._control.get_default_sink();
        if (defaultSink) {
            this._connectStream(defaultSink);
            newTargets.push({
                id: 'system',
                name: _('System'),
                gicon: new Gio.ThemedIcon({ name: 'audio-speakers-symbolic' }),
                iconName: 'audio-speakers-symbolic',
                volumePercent: this._calcVolumePercent(defaultSink),
                isMuted: Boolean(defaultSink.is_muted),
                isSystem: true,
                stream: defaultSink,
            });
        }

        // 2. Application Sink Inputs
        const sinkInputs = this._control.get_sink_inputs() || [];
        const usedMediaTitles = new Set();

        for (const stream of sinkInputs) {
            // Ignore system alert sounds (is_event_stream)
            if (Boolean(stream.is_event_stream))
                continue;

            // Optional filter: include only streams actively producing sound
            if (activeOnly) {
                const isRunning = Boolean(stream.is_running) ||
                    stream.get_state() === Gvc.MixerStreamState.RUNNING;
                if (!isRunning)
                    continue;
            }

            this._connectStream(stream);
            const { name, gicon, iconName } = this._resolveAppInfo(stream, usedMediaTitles);
            const streamId = stream.get_id().toString();

            newTargets.push({
                id: streamId,
                name,
                gicon,
                iconName,
                volumePercent: this._calcVolumePercent(stream),
                isMuted: Boolean(stream.is_muted),
                isSystem: false,
                stream,
            });
        }

        this._targets = newTargets;

        // If the active stream no longer exists, snap back to System
        const exists = this._targets.some(t => t.id === this._activeTargetId);
        if (!exists) {
            this._activeTargetId = 'system';
            this.emit('active-target-changed', 'system');
        }

        this._logDebug(
            `Targets updated: total=${this._targets.length} (active=${this._activeTargetId}): ` +
            this._targets.map(t => `${t.name} (id:${t.id}, vol:${t.volumePercent}%, muted:${t.isMuted})`).join(', ')
        );

        this.emit('targets-changed');
    }

    /**
     * Returns the list of all available audio targets.
     */
    getTargets() {
        return this._targets;
    }

    /**
     * Returns the currently active audio target.
     */
    getActiveTarget() {
        let target = this._targets.find(t => t.id === this._activeTargetId);
        if (!target && this._targets.length > 0) {
            this._activeTargetId = 'system';
            target = this._targets.find(t => t.id === 'system') || this._targets[0];
        }
        return target || null;
    }

    /**
     * Cycles to the next audio target in round-robin fashion.
     */
    cycleNext() {
        if (this._targets.length <= 1)
            return this.getActiveTarget();

        const currentIndex = this._targets.findIndex(t => t.id === this._activeTargetId);
        const nextIndex = (currentIndex + 1) % this._targets.length;
        this._activeTargetId = this._targets[nextIndex].id;

        this.emit('active-target-changed', this._activeTargetId);
        return this._targets[nextIndex];
    }

    /**
     * Adjusts the volume of the active target by deltaPercent (+-5% etc.).
     */
    changeVolume(deltaPercent) {
        const target = this.getActiveTarget();
        if (!target || !target.stream)
            return null;

        const maxNorm = this._control.get_vol_max_norm();
        const delta = Math.round((deltaPercent / 100) * maxNorm);
        const currentVol = target.stream.get_volume();
        const newVol = Math.max(0, Math.min(maxNorm, currentVol + delta));

        target.stream.set_volume(newVol);

        // Auto-unmute when turning up volume
        if (newVol > 0 && target.stream.is_muted)
            target.stream.change_is_muted(false);

        // Commit volume change to PipeWire/PulseAudio server
        target.stream.push_volume();

        target.volumePercent = this._calcVolumePercent(target.stream);
        target.isMuted = Boolean(target.stream.is_muted);
        this.emit('target-updated', target.id);

        return target;
    }

    /**
     * Toggles the mute state of the active audio target.
     */
    toggleMute() {
        const target = this.getActiveTarget();
        if (!target || !target.stream)
            return null;

        const nextMuted = !Boolean(target.stream.is_muted);
        target.stream.change_is_muted(nextMuted);

        target.isMuted = nextMuted;
        this.emit('target-updated', target.id);

        return target;
    }
});
