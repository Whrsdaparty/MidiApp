# MidiApp

A dependency-free browser MIDI workstation for testing MIDI input/output, playing an on-screen keyboard, recording short passages, and using a simple Web Audio fallback synth or an uploaded SoundFont.

## Features

- Web MIDI input and output selection
- Browser synth fallback when no MIDI output is selected
- Local `.sf2` SoundFont loading from `soundfonts/` and subfolders
- Preset selection from loaded SoundFonts
- On-screen piano keyboard
- Computer keyboard input mapped rowwise across letter keys: `QWERTYUIOP`, `ASDFGHJKL`, `ZXCVBNM`
- Recording, playback, tempo control, metronome, and MIDI event monitor

## Run

From this directory:

```bash
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

Web MIDI device access works best in Chrome or Edge. If no MIDI output is selected, the app plays through the built-in browser synth.

## SoundFonts

Put `.sf2` files in the `soundfonts` folder or its subfolders, then choose one from the SoundFont dropdown. After it loads, choose a preset from the preset menu. When no external MIDI output is selected, the on-screen keyboard, computer keyboard, playback, and MIDI input all use the selected SoundFont preset.

This parser supports standard SF2 files with PCM sample data. Compressed SF3 files are not supported.

SoundFont files are ignored by Git by default so local libraries do not get committed accidentally. The repo keeps an empty `soundfonts/.gitkeep` file so the folder exists after checkout.

## Project Structure

```text
MidiApp/
  index.html
  styles.css
  src/
    app.js
    soundfont.js
  soundfonts/
    .gitkeep
```
