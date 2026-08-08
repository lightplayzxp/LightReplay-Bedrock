// StateManager.js
// Central state machine for LightReplay-Bedrock mod.
// Responsibilities:
// - Maintain one of: IDLE, RECORDING, EDITING, PLAYING
// - Expose clean transition methods (startRecording, enterEditMode, startPlayback, stop, etc.)
// - Enforce safety checks (prevent invalid transitions)
// - Delegate to provided modules (recorder, previewer, player) on enter/exit
// - Emit events on state changes so UI can react
//
// NOTE: This file expects you to pass initialized module instances (or objects exposing the necessary methods)
// into the StateManager constructor. This keeps this file agnostic to import style (ESM / CommonJS) and environment.

const STATES = Object.freeze({
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  EDITING: 'EDITING',
  PLAYING: 'PLAYING'
});

// Allowed transitions map: currentState -> Set of allowed next states
const ALLOWED_TRANSITIONS = {
  [STATES.IDLE]: new Set([STATES.RECORDING, STATES.EDITING, STATES.PLAYING]),
  [STATES.RECORDING]: new Set([STATES.IDLE]),
  [STATES.EDITING]: new Set([STATES.IDLE, STATES.PLAYING]),
  [STATES.PLAYING]: new Set([STATES.IDLE])
};

class SimpleEventEmitter {
  constructor() {
    this._listeners = new Map(); // event -> Set of callbacks
  }

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this.off(event, cb);
  }

  off(event, cb) {
    if (!this._listeners.has(event)) return;
    this._listeners.get(event).delete(cb);
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        cb(...args);
      } catch (err) {
        console.error('Event handler error for', event, err);
      }
    }
  }
}

class StateManager extends SimpleEventEmitter {
  /**
   * Create a StateManager.
   * @param {Object} deps
   *   - recorder: { startRecording():Promise|void, stopRecording():Promise|void, ... }
   *   - previewer: { init?():Promise, scrubTo(trackId, ts):void, clearPreview():void, ... }
   *   - player: { init?():Promise, start(startMs?):Promise|void, stop():Promise|void, pause?():void, resume?():void, seek?(ms):void }
   *   - trackManager: optional - for track lifecycle integration
   *   - logger: optional { log(), warn(), error() }
   */
  constructor(deps = {}) {
    super();
    this._recorder = deps.recorder ?? null;
    this._previewer = deps.previewer ?? null;
    this._player = deps.player ?? null;
    this._trackManager = deps.trackManager ?? null;
    this._logger = deps.logger ?? console;

    this._state = STATES.IDLE;
    this._lastRecordedTrackMeta = null; // optional storage for last result from recorder.stopRecording()
  }

  getState() {
    return this._state;
  }

  is(state) {
    return this._state === state;
  }

  // INTERNAL: validate transition
  _assertTransitionAllowed(toState) {
    const allowed = ALLOWED_TRANSITIONS[this._state];
    if (!allowed || !allowed.has(toState)) {
      throw new Error(`Invalid state transition: ${this._state} -> ${toState}`);
    }
  }

  // INTERNAL: perform the transition with exit/enter hooks
  async _transitionTo(toState, meta = {}) {
    this._assertTransitionAllowed(toState);
    const prev = this._state;

    // run exit handler for prev
    await this._safeInvoke(this._exitStateHandler(prev), `exit:${prev}`);

    // set new state
    this._state = toState;
    this.emit('stateChange', { from: prev, to: toState, meta });

    // run enter handler for new state
    await this._safeInvoke(this._enterStateHandler(toState, meta), `enter:${toState}`);
  }

  // Wrap handler invocation with error capture
  async _safeInvoke(promiseOrFn, tag = '') {
    try {
      if (!promiseOrFn) return;
      const result = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
      if (result && typeof result.then === 'function') {
        await result;
      }
    } catch (err) {
      this._logger.error(`Error during ${tag} handler:`, err);
      // Emit an error event for UI or debugging
      this.emit('error', { tag, error: err });
      // Do not rethrow to guarantee transition finalization, but transitions that fail may leave modules in inconsistent state.
    }
  }

  // Returns function or promise for exit handler of the state
  _exitStateHandler(state) {
    switch (state) {
      case STATES.RECORDING:
        return async () => {
          if (this._recorder && typeof this._recorder.stopRecording === 'function') {
            this._logger.log('Stopping recorder...');
            const maybeTrackMeta = await this._recorder.stopRecording();
            // Optionally store returned metadata about the recorded track
            if (maybeTrackMeta) this._lastRecordedTrackMeta = maybeTrackMeta;
            this._logger.log('Recorder stopped.');
          }
          // Ensure preview and player are cleared too for safety
          if (this._previewer && typeof this._previewer.clearPreview === 'function') {
            this._previewer.clearPreview();
          }
          if (this._player && typeof this._player.stop === 'function') {
            // don't force stop playback here unless it's running; but safe to call stop
            await this._player.stop();
          }
        };

      case STATES.EDITING:
        return () => {
          if (this._previewer && typeof this._previewer.clearPreview === 'function') {
            this._logger.log('Clearing preview (leaving EDITING)...');
            this._previewer.clearPreview();
          }
        };

      case STATES.PLAYING:
        return async () => {
          if (this._player && typeof this._player.stop === 'function') {
            this._logger.log('Stopping playback (leaving PLAYING)...');
            await this._player.stop();
          }
        };

      case STATES.IDLE:
      default:
        return null;
    }
  }

  // Returns function or promise for enter handler of the state
  _enterStateHandler(state, meta = {}) {
    switch (state) {
      case STATES.RECORDING:
        return async () => {
          // Before recording, ensure other systems are stopped
          if (this._player && typeof this._player.stop === 'function') {
            await this._player.stop();
          }
          if (this._previewer && typeof this._previewer.clearPreview === 'function') {
            this._previewer.clearPreview();
          }

          if (!this._recorder || typeof this._recorder.startRecording !== 'function') {
            throw new Error('Recorder not provided or missing startRecording()');
          }
          this._logger.log('Starting recording...');
          await this._recorder.startRecording(meta); // allow optional meta (e.g., track name)
          this._logger.log('Recording started.');
        };

      case STATES.EDITING:
        return async () => {
          // Stop playback and recording if any (safety)
          if (this._recorder && typeof this._recorder.stopRecording === 'function') {
            // If we are coming from RECORDING this will be handled by exit handler
            // But call defensively
            try { await this._recorder.stopRecording(); } catch (e) { /* ignore */ }
          }
          if (this._player && typeof this._player.stop === 'function') {
            try { await this._player.stop(); } catch (e) { /* ignore */ }
          }

          // Initialize previewer if it has init
          if (this._previewer && typeof this._previewer.init === 'function') {
            await this._previewer.init();
          }

          this._logger.log('Entered EDITING mode.');
        };

      case STATES.PLAYING:
        return async () => {
          // Stop preview and recorder
          if (this._previewer && typeof this._previewer.clearPreview === 'function') {
            this._previewer.clearPreview();
          }
          if (this._recorder && typeof this._recorder.stopRecording === 'function') {
            try { await this._recorder.stopRecording(); } catch (e) { /* ignore */ }
          }

          if (!this._player || typeof this._player.start !== 'function') {
            throw new Error('Player not provided or missing start()');
          }

          // Initialize player if need be
          if (typeof this._player.init === 'function') {
            await this._player.init();
          }

          // Accept optional start time in meta.startMs
          const startMs = typeof meta.startMs === 'number' ? meta.startMs : 0;
          this._logger.log(`Starting playback from ${startMs}ms...`);
          await this._player.start(startMs);
          this._logger.log('Playback started.');
        };

      case STATES.IDLE:
      default:
        return async () => {
          // Ensure everything is stopped/cleared
          if (this._recorder && typeof this._recorder.stopRecording === 'function') {
            try { await this._recorder.stopRecording(); } catch (e) { /* ignore */ }
          }
          if (this._previewer && typeof this._previewer.clearPreview === 'function') {
            try { this._previewer.clearPreview(); } catch (e) { /* ignore */ }
          }
          if (this._player && typeof this._player.stop === 'function') {
            try { await this._player.stop(); } catch (e) { /* ignore */ }
          }
          this._logger.log('Entered IDLE state.');
        };
    }
  }

  // Public transition APIs ------------------------------------------------

  /**
   * Start recording (transition IDLE -> RECORDING).
   * @param {Object} meta optional metadata passed to recorder.startRecording()
   */
  async startRecording(meta = {}) {
    this._logger.log('Request: startRecording');
    await this._transitionTo(STATES.RECORDING, meta);
    this.emit('enteredRecording', { meta });
  }

  /**
   * Stop recording and return to IDLE (RECORDING -> IDLE).
   */
  async stopRecording() {
    this._logger.log('Request: stopRecording');
    if (!this.is(STATES.RECORDING)) {
      throw new Error('Cannot stopRecording: not currently recording.');
    }
    await this._transitionTo(STATES.IDLE);
    this.emit('stoppedRecording', { lastTrackMeta: this._lastRecordedTrackMeta });
    return this._lastRecordedTrackMeta;
  }

  /**
   * Enter edit mode (IDLE -> EDITING).
   * Optionally provide meta (e.g., which track to open).
   */
  async enterEditMode(meta = {}) {
    this._logger.log('Request: enterEditMode');
    await this._transitionTo(STATES.EDITING, meta);
    this.emit('enteredEditing', { meta });
  }

  /**
   * Exit edit mode and return to IDLE (EDITING -> IDLE).
   */
  async exitEditMode() {
    this._logger.log('Request: exitEditMode');
    if (!this.is(STATES.EDITING)) {
      throw new Error('Cannot exitEditMode: not in EDITING state.');
    }
    await this._transitionTo(STATES.IDLE);
    this.emit('exitedEditing', {});
  }

  /**
   * Start playback. Allowed from IDLE or EDITING only (EDITING -> PLAYING allowed, RECORDING -> PLAYING is blocked).
   * Optional meta.startMs to begin playback at a specific master time.
   */
  async startPlayback(meta = {}) {
    this._logger.log('Request: startPlayback');
    // If currently recording, block as safety (user must stop first)
    if (this.is(STATES.RECORDING)) {
      throw new Error('Cannot start playback while recording. Stop recording first.');
    }
    // If already playing, ignore or throw
    if (this.is(STATES.PLAYING)) {
      this._logger.log('Already playing; startPlayback ignored.');
      return;
    }
    await this._transitionTo(STATES.PLAYING, meta);
    this.emit('enteredPlaying', { meta });
  }

  /**
   * Stop playback and return to IDLE (PLAYING -> IDLE).
   */
  async stopPlayback() {
    this._logger.log('Request: stopPlayback');
    if (!this.is(STATES.PLAYING)) {
      throw new Error('Cannot stopPlayback: not in PLAYING state.');
    }
    await this._transitionTo(STATES.IDLE);
    this.emit('stoppedPlaying', {});
  }

  /**
   * Force-stop everything and go to IDLE regardless of current state.
   * Use with care: will attempt to stop/clear all modules.
   */
  async forceStopAll() {
    this._logger.warn('Force stopping all modules and going to IDLE.');
    // Attempt to stop/clear everything regardless of allowed transitions
    await this._safeInvoke(async () => {
      if (this._recorder && typeof this._recorder.stopRecording === 'function') {
        try { await this._recorder.stopRecording(); } catch (e) { /* ignore */ }
      }
      if (this._previewer && typeof this._previewer.clearPreview === 'function') {
        try { this._previewer.clearPreview(); } catch (e) { /* ignore */ }
      }
      if (this._player && typeof this._player.stop === 'function') {
        try { await this._player.stop(); } catch (e) { /* ignore */ }
      }
      this._state = STATES.IDLE;
      this.emit('stateChange', { from: null, to: STATES.IDLE, forced: true });
      this.emit('forceStopped', {});
    }, 'forceStopAll');
  }
}

// Export
export { StateManager, STATES };

/* ---------------- Example usage (pseudo) ----------------

import { StateManager } from './StateManager.js';
import Recorder from './record.js';               // adapt depending on your export style
import { TicketStore, TicketPreviewer } from './timeline-preview.js';
import { ReplayPlayer } from './replay.js';
import TrackManager from './track-manager.js';

(async () => {
  const ticketStore = new TicketStore();
  await ticketStore.init();

  const recorder = new Recorder(/* pass deps if needed * /);
  const previewer = new TicketPreviewer(ticketStore, /* worldApplier */);
  const player = new ReplayPlayer(/* masterTimeline */, { ticketStore, tickIntervalMs: 50 });
  await player.init();

  const state = new StateManager({
    recorder,
    previewer,
    player,
    trackManager: new TrackManager(/* ... */),
    logger: console
  });

  // UI can listen:
  state.on('stateChange', ({from, to}) => {
    console.log('State changed', from, '->', to);
    // update UI accordingly
  });

  // Start recording:
  await state.startRecording({ trackName: 'MyTrack' });

  // Stop recording:
  const meta = await state.stopRecording();

  // Enter edit mode:
  await state.enterEditMode({ openTrackId: meta?.id });

  // Start playback from 0:
  await state.startPlayback({ startMs: 0 });

  // Stop playback:
  await state.stopPlayback();
})();

------------------------------------------------------- */
