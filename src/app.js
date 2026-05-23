const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BASE_NOTES = Array.from({ length: 25 }, (_, index) => 48 + index);
const LETTER_KEYS = "qwertyuiopasdfghjklzxcvbnm";
const KEY_BINDINGS = new Map(Array.from(LETTER_KEYS, (key, index) => [key, BASE_NOTES[index]]));

const state = {
  midi: null,
  selectedInput: null,
  selectedOutput: null,
  audioContext: null,
  activeVoices: new Map(),
  pressedComputerKeys: new Set(),
  recording: false,
  recordStartedAt: 0,
  recordedEvents: [],
  playbackTimers: [],
  metronomeTimer: null,
  soundFont: null,
  selectedPresetIndex: "",
};

const els = {
  supportStatus: document.querySelector("#supportStatus"),
  connectButton: document.querySelector("#connectButton"),
  inputSelect: document.querySelector("#inputSelect"),
  outputSelect: document.querySelector("#outputSelect"),
  channelSelect: document.querySelector("#channelSelect"),
  inputName: document.querySelector("#inputName"),
  outputName: document.querySelector("#outputName"),
  tempoInput: document.querySelector("#tempoInput"),
  tempoValue: document.querySelector("#tempoValue"),
  soundFontSelect: document.querySelector("#soundFontSelect"),
  presetSelect: document.querySelector("#presetSelect"),
  soundFontStatus: document.querySelector("#soundFontStatus"),
  keyboard: document.querySelector("#keyboard"),
  recordButton: document.querySelector("#recordButton"),
  playButton: document.querySelector("#playButton"),
  stopButton: document.querySelector("#stopButton"),
  clearButton: document.querySelector("#clearButton"),
  metronomeButton: document.querySelector("#metronomeButton"),
  panicButton: document.querySelector("#panicButton"),
  recordingInfo: document.querySelector("#recordingInfo"),
  eventLog: document.querySelector("#eventLog"),
};

function noteName(note) {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

function midiChannel() {
  return Number(els.channelSelect.value);
}

function getAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass();
  }
  return state.audioContext;
}

function playBrowserSynth(note, velocity = 92) {
  const audio = getAudioContext();
  if (state.soundFont && state.selectedPresetIndex !== "") {
    const voice = state.soundFont.play(audio, Number(state.selectedPresetIndex), note, velocity);
    if (voice) {
      state.activeVoices.set(note, voice);
      return;
    }
  }

  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  const filter = audio.createBiquadFilter();
  const now = audio.currentTime;

  oscillator.type = "triangle";
  oscillator.frequency.value = 440 * 2 ** ((note - 69) / 12);
  filter.type = "lowpass";
  filter.frequency.value = 1800;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(Math.max(0.05, velocity / 127) * 0.28, now + 0.015);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(now);
  state.activeVoices.set(note, { oscillator, gain });
}

function stopBrowserSynth(note) {
  const voice = state.activeVoices.get(note);
  if (!voice || !state.audioContext) return;
  if (voice.source) {
    state.soundFont.stopVoice(state.audioContext, voice);
    state.activeVoices.delete(note);
    return;
  }

  const now = state.audioContext.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0.0001, now, 0.04);
  voice.oscillator.stop(now + 0.16);
  state.activeVoices.delete(note);
}

function sendMidiNote(note, on, velocity = 92) {
  const status = (on ? 0x90 : 0x80) + midiChannel();
  if (state.selectedOutput) {
    state.selectedOutput.send([status, note, on ? velocity : 0]);
  } else if (on) {
    playBrowserSynth(note, velocity);
  } else {
    stopBrowserSynth(note);
  }
}

function markKey(note, active) {
  const key = els.keyboard.querySelector(`[data-note="${note}"]`);
  if (key) key.classList.toggle("active", active);
}

function logEvent(label, bytes = []) {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  const data = bytes.length ? ` [${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}]` : "";
  item.textContent = `${time}  ${label}${data}`;
  els.eventLog.prepend(item);
  while (els.eventLog.children.length > 80) {
    els.eventLog.lastElementChild.remove();
  }
}

function captureEvent(note, on, velocity) {
  if (!state.recording) return;
  state.recordedEvents.push({
    at: performance.now() - state.recordStartedAt,
    note,
    on,
    velocity,
  });
  els.recordingInfo.textContent = `${state.recordedEvents.length} events`;
}

function noteOn(note, velocity = 92, source = "app") {
  sendMidiNote(note, true, velocity);
  markKey(note, true);
  captureEvent(note, true, velocity);
  logEvent(`${source} note on ${noteName(note)} velocity ${velocity}`, [0x90 + midiChannel(), note, velocity]);
}

function noteOff(note, source = "app") {
  sendMidiNote(note, false);
  markKey(note, false);
  captureEvent(note, false, 0);
  logEvent(`${source} note off ${noteName(note)}`, [0x80 + midiChannel(), note, 0]);
}

function allNotesOff() {
  for (const note of BASE_NOTES) {
    markKey(note, false);
    sendMidiNote(note, false);
  }
  for (const note of state.activeVoices.keys()) {
    stopBrowserSynth(note);
  }
  if (state.selectedOutput) {
    state.selectedOutput.send([0xb0 + midiChannel(), 123, 0]);
  }
  logEvent("all notes off");
}

function renderKeyboard() {
  els.keyboard.innerHTML = "";
  const whiteNotes = BASE_NOTES.filter((note) => !NOTE_NAMES[note % 12].includes("#"));
  const whiteIndexByNote = new Map(whiteNotes.map((note, index) => [note, index]));

  for (const note of whiteNotes) {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "key white";
    key.dataset.note = note;
    key.innerHTML = `<span>${noteName(note)}</span>`;
    els.keyboard.append(key);
  }

  for (const note of BASE_NOTES.filter((candidate) => NOTE_NAMES[candidate % 12].includes("#"))) {
    const previousWhite = note - 1;
    const left = ((whiteIndexByNote.get(previousWhite) + 1) / whiteNotes.length) * 100;
    const key = document.createElement("button");
    key.type = "button";
    key.className = "key black";
    key.dataset.note = note;
    key.style.left = `${left}%`;
    key.innerHTML = `<span>${noteName(note)}</span>`;
    els.keyboard.append(key);
  }
}

function updateDeviceLists() {
  const inputs = state.midi ? Array.from(state.midi.inputs.values()) : [];
  const outputs = state.midi ? Array.from(state.midi.outputs.values()) : [];

  els.inputSelect.innerHTML = `<option value="">No input</option>${inputs
    .map((input) => `<option value="${input.id}">${input.name || "Unnamed input"}</option>`)
    .join("")}`;
  els.outputSelect.innerHTML = `<option value="">Browser synth</option>${outputs
    .map((output) => `<option value="${output.id}">${output.name || "Unnamed output"}</option>`)
    .join("")}`;

  if (state.selectedInput) els.inputSelect.value = state.selectedInput.id;
  if (state.selectedOutput) els.outputSelect.value = state.selectedOutput.id;
  els.inputName.textContent = state.selectedInput?.name || "None";
  els.outputName.textContent = state.selectedOutput?.name
    || (state.soundFont && state.selectedPresetIndex !== "" ? "SoundFont" : "Browser synth");
}

function updatePresetList() {
  if (!state.soundFont) {
    els.presetSelect.innerHTML = `<option value="">Built-in synth</option>`;
    els.presetSelect.disabled = true;
    state.selectedPresetIndex = "";
    return;
  }

  els.presetSelect.disabled = false;
  els.presetSelect.innerHTML = `<option value="">Built-in synth</option>${state.soundFont.presets
    .map((preset, index) => `<option value="${index}">${preset.bank}:${preset.preset} ${preset.name}</option>`)
    .join("")}`;
  const firstUsable = state.soundFont.presets.findIndex((preset) => preset.zones.length);
  state.selectedPresetIndex = firstUsable >= 0 ? String(firstUsable) : "";
  els.presetSelect.value = state.selectedPresetIndex;
  els.soundFontStatus.textContent = `${state.soundFont.fileName} loaded`;
  updateDeviceLists();
}

async function loadSoundFont(file) {
  if (!file) return;
  els.soundFontStatus.textContent = "Loading SoundFont...";
  try {
    allNotesOff();
    state.soundFont = await window.SoundFont2.fromFile(file);
    updatePresetList();
    logEvent(`loaded SoundFont ${file.name}`);
  } catch (error) {
    state.soundFont = null;
    updatePresetList();
    els.soundFontStatus.textContent = error.message || "Could not load SoundFont";
    logEvent(`SoundFont load failed: ${error.message || error}`);
  }
}

async function loadSoundFontFromUrl(url) {
  if (!url) {
    allNotesOff();
    state.soundFont = null;
    updatePresetList();
    els.soundFontStatus.textContent = "Using built-in synth";
    updateDeviceLists();
    return;
  }

  els.soundFontStatus.textContent = "Loading SoundFont...";
  try {
    allNotesOff();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not fetch ${url}`);
    const buffer = await response.arrayBuffer();
    const fileName = decodeURIComponent(url.split("/").pop());
    state.soundFont = window.SoundFont2.parse(buffer, fileName);
    updatePresetList();
    logEvent(`loaded SoundFont ${fileName}`);
  } catch (error) {
    state.soundFont = null;
    updatePresetList();
    els.soundFontStatus.textContent = error.message || "Could not load SoundFont";
    logEvent(`SoundFont load failed: ${error.message || error}`);
  }
}

async function refreshSoundFontFolder() {
  try {
    const files = await scanSoundFontDirectory("soundfonts/");

    els.soundFontSelect.replaceChildren(new Option("Built-in synth", ""));
    for (const file of files) {
      els.soundFontSelect.append(new Option(file.label, file.url));
    }
    els.soundFontStatus.textContent = files.length
      ? `${files.length} SoundFont file${files.length === 1 ? "" : "s"} found`
      : "Add .sf2 files to the soundfonts folder";
  } catch (error) {
    els.soundFontStatus.textContent = error.message || "Could not scan soundfonts folder";
  }
}

async function scanSoundFontDirectory(directoryUrl, visited = new Set()) {
  const normalizedUrl = directoryUrl.endsWith("/") ? directoryUrl : `${directoryUrl}/`;
  if (visited.has(normalizedUrl)) return [];
  visited.add(normalizedUrl);

  const response = await fetch(normalizedUrl);
  if (!response.ok) throw new Error("SoundFont folder is unavailable");

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const entries = Array.from(doc.querySelectorAll("a"))
    .map((link) => link.getAttribute("href"))
    .filter(Boolean)
    .filter((href) => href !== "../" && href !== "/" && !href.startsWith("?"));

  const files = [];
  for (const href of entries) {
    const url = new URL(href, new URL(normalizedUrl, window.location.href));
    if (!url.href.startsWith(new URL("soundfonts/", window.location.href).href)) continue;

    const relativePath = decodeURIComponent(url.pathname)
      .replace(decodeURIComponent(new URL("soundfonts/", window.location.href).pathname), "");

    if (url.pathname.endsWith("/")) {
      files.push(...await scanSoundFontDirectory(url.pathname.replace(/^\//, ""), visited));
    } else if (/\.sf2$/i.test(url.pathname)) {
      files.push({
        label: relativePath,
        url: url.pathname.replace(/^\//, ""),
      });
    }
  }

  return files.sort((a, b) => a.label.localeCompare(b.label));
}

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    els.supportStatus.textContent = "Web MIDI is not available in this browser. Chrome or Edge is recommended.";
    logEvent("Web MIDI unsupported");
    return;
  }

  state.midi = await navigator.requestMIDIAccess({ sysex: false });
  state.midi.onstatechange = () => updateDeviceLists();
  const firstInput = state.midi.inputs.values().next().value;
  const firstOutput = state.midi.outputs.values().next().value;
  if (firstInput) selectInput(firstInput.id);
  if (firstOutput) selectOutput(firstOutput.id);
  updateDeviceLists();
  els.supportStatus.textContent = "MIDI ready. Incoming notes are mirrored to the keyboard and monitor.";
  logEvent("MIDI connected");
}

function selectInput(id) {
  if (state.selectedInput) state.selectedInput.onmidimessage = null;
  state.selectedInput = id && state.midi ? state.midi.inputs.get(id) : null;
  if (state.selectedInput) {
    state.selectedInput.onmidimessage = handleMidiMessage;
  }
  updateDeviceLists();
}

function selectOutput(id) {
  state.selectedOutput = id && state.midi ? state.midi.outputs.get(id) : null;
  updateDeviceLists();
}

function handleMidiMessage(message) {
  const [status, note, velocity] = message.data;
  const command = status & 0xf0;
  const channel = status & 0x0f;
  if (channel !== midiChannel()) return;

  if (command === 0x90 && velocity > 0) {
    if (!state.selectedOutput) playBrowserSynth(note, velocity);
    markKey(note, true);
    captureEvent(note, true, velocity);
    logEvent(`input note on ${noteName(note)} velocity ${velocity}`, Array.from(message.data));
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    if (!state.selectedOutput) stopBrowserSynth(note);
    markKey(note, false);
    captureEvent(note, false, 0);
    logEvent(`input note off ${noteName(note)}`, Array.from(message.data));
  } else {
    logEvent(`input message status ${status}`, Array.from(message.data));
  }
}

function startRecording() {
  state.recording = true;
  state.recordStartedAt = performance.now();
  state.recordedEvents = [];
  els.recordButton.classList.add("active");
  els.recordingInfo.textContent = "0 events";
  logEvent("recording started");
}

function stopRecording() {
  state.recording = false;
  els.recordButton.classList.remove("active");
  logEvent("recording stopped");
}

function stopPlayback() {
  state.playbackTimers.forEach((timer) => clearTimeout(timer));
  state.playbackTimers = [];
  stopRecording();
  allNotesOff();
}

function playRecording() {
  stopPlayback();
  if (!state.recordedEvents.length) {
    logEvent("nothing to play");
    return;
  }
  const sourceTempo = 120;
  const tempoRatio = sourceTempo / Number(els.tempoInput.value);
  for (const event of state.recordedEvents) {
    const timer = setTimeout(() => {
      if (event.on) noteOn(event.note, event.velocity, "playback");
      else noteOff(event.note, "playback");
    }, event.at * tempoRatio);
    state.playbackTimers.push(timer);
  }
  const lastAt = state.recordedEvents.at(-1).at * tempoRatio + 100;
  state.playbackTimers.push(setTimeout(() => {
    allNotesOff();
    state.playbackTimers = [];
    logEvent("playback finished");
  }, lastAt));
}

function toggleMetronome() {
  if (state.metronomeTimer) {
    clearInterval(state.metronomeTimer);
    state.metronomeTimer = null;
    els.metronomeButton.classList.remove("active");
    els.metronomeButton.setAttribute("aria-pressed", "false");
    return;
  }

  const tick = () => {
    const audio = getAudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = 1200;
    gain.gain.value = 0.14;
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.035);
  };
  tick();
  state.metronomeTimer = setInterval(tick, 60000 / Number(els.tempoInput.value));
  els.metronomeButton.classList.add("active");
  els.metronomeButton.setAttribute("aria-pressed", "true");
}

function bindEvents() {
  els.connectButton.addEventListener("click", connectMidi);
  els.inputSelect.addEventListener("change", (event) => selectInput(event.target.value));
  els.outputSelect.addEventListener("change", (event) => selectOutput(event.target.value));
  els.soundFontSelect.addEventListener("change", (event) => loadSoundFontFromUrl(event.target.value));
  els.presetSelect.addEventListener("change", (event) => {
    allNotesOff();
    state.selectedPresetIndex = event.target.value;
    updateDeviceLists();
    logEvent(event.target.value === "" ? "using built-in synth" : `selected preset ${event.target.selectedOptions[0].textContent}`);
  });
  els.tempoInput.addEventListener("input", () => {
    els.tempoValue.textContent = els.tempoInput.value;
    if (state.metronomeTimer) {
      clearInterval(state.metronomeTimer);
      state.metronomeTimer = null;
      toggleMetronome();
    }
  });
  els.recordButton.addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));
  els.playButton.addEventListener("click", playRecording);
  els.stopButton.addEventListener("click", stopPlayback);
  els.clearButton.addEventListener("click", () => {
    state.recordedEvents = [];
    els.recordingInfo.textContent = "0 events";
    logEvent("recording cleared");
  });
  els.metronomeButton.addEventListener("click", toggleMetronome);
  els.panicButton.addEventListener("click", allNotesOff);

  els.keyboard.addEventListener("pointerdown", (event) => {
    const key = event.target.closest(".key");
    if (!key) return;
    key.setPointerCapture(event.pointerId);
    noteOn(Number(key.dataset.note), 100);
  });
  els.keyboard.addEventListener("pointerup", (event) => {
    const key = event.target.closest(".key");
    if (key) noteOff(Number(key.dataset.note));
  });
  els.keyboard.addEventListener("pointercancel", allNotesOff);
  window.addEventListener("keydown", (event) => {
    const note = KEY_BINDINGS.get(event.key.toLowerCase());
    if (!note || state.pressedComputerKeys.has(event.key)) return;
    state.pressedComputerKeys.add(event.key);
    noteOn(note, 100, "keyboard");
  });
  window.addEventListener("keyup", (event) => {
    const note = KEY_BINDINGS.get(event.key.toLowerCase());
    if (!note) return;
    state.pressedComputerKeys.delete(event.key);
    noteOff(note, "keyboard");
  });
}

function init() {
  renderKeyboard();
  updateDeviceLists();
  bindEvents();
  refreshSoundFontFolder();
  els.supportStatus.textContent = navigator.requestMIDIAccess
    ? "Connect a MIDI device or play the built-in browser synth."
    : "Web MIDI is not available in this browser. The browser synth still works.";
}

init();
