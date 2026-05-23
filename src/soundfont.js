class SoundFontParseError extends Error {}

class SoundFont2 {
  static async fromFile(file) {
    const buffer = await file.arrayBuffer();
    return SoundFont2.parse(buffer, file.name);
  }

  static parse(arrayBuffer, fileName = "SoundFont") {
    const view = new DataView(arrayBuffer);
    const riff = readFourCC(view, 0);
    const type = readFourCC(view, 8);
    if (riff !== "RIFF" || type !== "sfbk") {
      throw new SoundFontParseError("Only standard SF2 SoundFont files are supported.");
    }

    const chunks = parseChunks(view, 12, view.byteLength);
    const listChunks = new Map();
    for (const chunk of chunks) {
      if (chunk.id === "LIST") {
        listChunks.set(readFourCC(view, chunk.offset), parseChunks(view, chunk.offset + 4, chunk.offset + chunk.size));
      }
    }

    const sdta = listChunks.get("sdta");
    const pdta = listChunks.get("pdta");
    if (!sdta || !pdta) throw new SoundFontParseError("Missing SoundFont sample or preset data.");

    const smpl = findChunk(sdta, "smpl");
    if (!smpl) throw new SoundFontParseError("This SoundFont has no PCM sample data.");

    const tables = {
      phdr: readRecords(view, findRequired(pdta, "phdr"), 38, readPhdr),
      pbag: readRecords(view, findRequired(pdta, "pbag"), 4, readBag),
      pgen: readRecords(view, findRequired(pdta, "pgen"), 4, readGen),
      inst: readRecords(view, findRequired(pdta, "inst"), 22, readInst),
      ibag: readRecords(view, findRequired(pdta, "ibag"), 4, readBag),
      igen: readRecords(view, findRequired(pdta, "igen"), 4, readGen),
      shdr: readRecords(view, findRequired(pdta, "shdr"), 46, readShdr),
    };

    const sampleData = new Int16Array(arrayBuffer, smpl.offset, Math.floor(smpl.size / 2));
    const presets = buildPresets(tables);
    return new SoundFont2(fileName, presets, tables.shdr.slice(0, -1), sampleData);
  }

  constructor(fileName, presets, samples, sampleData) {
    this.fileName = fileName;
    this.presets = presets;
    this.samples = samples;
    this.sampleData = sampleData;
    this.bufferCache = new Map();
  }

  play(audio, presetIndex, note, velocity = 92) {
    const preset = this.presets[presetIndex];
    if (!preset) return null;

    const zone = preset.zones.find((candidate) => {
      const [low, high] = candidate.keyRange;
      const [vLow, vHigh] = candidate.velRange;
      return note >= low && note <= high && velocity >= vLow && velocity <= vHigh;
    });
    if (!zone) return null;

    const sample = this.samples[zone.sampleID];
    if (!sample || sample.end <= sample.start) return null;

    const source = audio.createBufferSource();
    const gain = audio.createGain();
    const filter = audio.createBiquadFilter();
    const now = audio.currentTime;
    const rootKey = zone.overridingRootKey >= 0 ? zone.overridingRootKey : sample.originalPitch;
    const cents = zone.fineTune + zone.coarseTune * 100 + sample.pitchCorrection;
    const semitones = note - rootKey + cents / 100;
    const attenuation = Math.max(0, Math.min(1, 1 - zone.initialAttenuation / 1440));

    source.buffer = this.getAudioBuffer(audio, zone.sampleID);
    source.playbackRate.value = 2 ** (semitones / 12);
    source.loop = (zone.sampleModes & 1) === 1 && sample.endLoop > sample.startLoop;
    if (source.loop) {
      source.loopStart = Math.max(0, (sample.startLoop - sample.start) / sample.sampleRate);
      source.loopEnd = Math.max(source.loopStart + 0.001, (sample.endLoop - sample.start) / sample.sampleRate);
    }

    filter.type = "lowpass";
    filter.frequency.value = zone.initialFilterFc > 0 ? centsToHz(zone.initialFilterFc) : 20000;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime((velocity / 127) * 0.9 * attenuation, now + timecentsToSeconds(zone.attackVolEnv));
    if (zone.decayVolEnv > -12000 && zone.sustainVolEnv > 0) {
      gain.gain.setTargetAtTime((velocity / 127) * (1 - zone.sustainVolEnv / 1000) * attenuation, now + 0.02, timecentsToSeconds(zone.decayVolEnv));
    }

    source.connect(filter);
    filter.connect(gain);
    gain.connect(audio.destination);
    source.start(now);
    return { source, gain, release: timecentsToSeconds(zone.releaseVolEnv) };
  }

  stopVoice(audio, voice) {
    const now = audio.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0.0001, now, Math.max(0.03, voice.release));
    voice.source.stop(now + Math.max(0.08, voice.release * 4));
  }

  getAudioBuffer(audio, sampleID) {
    const sample = this.samples[sampleID];
    const cacheKey = `${sampleID}:${sample.start}:${sample.end}`;
    if (this.bufferCache.has(cacheKey)) return this.bufferCache.get(cacheKey);

    const length = sample.end - sample.start;
    const buffer = audio.createBuffer(1, length, sample.sampleRate || 44100);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      channel[index] = this.sampleData[sample.start + index] / 32768;
    }
    this.bufferCache.set(cacheKey, buffer);
    return buffer;
  }
}

function parseChunks(view, start, end) {
  const chunks = [];
  let offset = start;
  while (offset + 8 <= end) {
    const id = readFourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    chunks.push({ id, offset: offset + 8, size });
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

function findChunk(chunks, id) {
  return chunks.find((chunk) => chunk.id === id);
}

function findRequired(chunks, id) {
  const chunk = findChunk(chunks, id);
  if (!chunk) throw new SoundFontParseError(`Missing ${id} table.`);
  return chunk;
}

function readRecords(view, chunk, size, reader) {
  const records = [];
  for (let offset = chunk.offset; offset + size <= chunk.offset + chunk.size; offset += size) {
    records.push(reader(view, offset));
  }
  return records;
}

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readName(view, offset, length) {
  let name = "";
  for (let index = 0; index < length; index += 1) {
    const byte = view.getUint8(offset + index);
    if (byte === 0) break;
    name += String.fromCharCode(byte);
  }
  return name.trim();
}

function readPhdr(view, offset) {
  return {
    name: readName(view, offset, 20),
    preset: view.getUint16(offset + 20, true),
    bank: view.getUint16(offset + 22, true),
    bagIndex: view.getUint16(offset + 24, true),
  };
}

function readBag(view, offset) {
  return {
    genIndex: view.getUint16(offset, true),
    modIndex: view.getUint16(offset + 2, true),
  };
}

function readGen(view, offset) {
  return {
    oper: view.getUint16(offset, true),
    amount: view.getInt16(offset + 2, true),
    rawAmount: view.getUint16(offset + 2, true),
  };
}

function readInst(view, offset) {
  return {
    name: readName(view, offset, 20),
    bagIndex: view.getUint16(offset + 20, true),
  };
}

function readShdr(view, offset) {
  return {
    name: readName(view, offset, 20),
    start: view.getUint32(offset + 20, true),
    end: view.getUint32(offset + 24, true),
    startLoop: view.getUint32(offset + 28, true),
    endLoop: view.getUint32(offset + 32, true),
    sampleRate: view.getUint32(offset + 36, true),
    originalPitch: view.getUint8(offset + 40),
    pitchCorrection: view.getInt8(offset + 41),
    sampleLink: view.getUint16(offset + 42, true),
    sampleType: view.getUint16(offset + 44, true),
  };
}

function buildPresets(tables) {
  return tables.phdr.slice(0, -1).map((preset, presetIndex) => {
    const nextPreset = tables.phdr[presetIndex + 1];
    const zones = readPresetZones(tables, preset.bagIndex, nextPreset.bagIndex);
    return { ...preset, zones };
  });
}

function readPresetZones(tables, startBag, endBag) {
  const presetGlobal = {};
  const zones = [];

  for (let bagIndex = startBag; bagIndex < endBag; bagIndex += 1) {
    const bag = tables.pbag[bagIndex];
    const nextBag = tables.pbag[bagIndex + 1];
    const gens = tables.pgen.slice(bag.genIndex, nextBag.genIndex);
    const instrumentGen = gens.find((gen) => gen.oper === 41);
    if (!instrumentGen) {
      Object.assign(presetGlobal, gensToParams(gens));
      continue;
    }

    const presetParams = { ...presetGlobal, ...gensToParams(gens) };
    const inst = tables.inst[instrumentGen.rawAmount];
    if (!inst) continue;
    zones.push(...readInstrumentZones(tables, inst, presetParams));
  }

  return zones;
}

function readInstrumentZones(tables, inst, presetParams) {
  const instrumentIndex = tables.inst.indexOf(inst);
  const nextInst = tables.inst[instrumentIndex + 1];
  const instrumentGlobal = {};
  const zones = [];

  for (let bagIndex = inst.bagIndex; bagIndex < nextInst.bagIndex; bagIndex += 1) {
    const bag = tables.ibag[bagIndex];
    const nextBag = tables.ibag[bagIndex + 1];
    const gens = tables.igen.slice(bag.genIndex, nextBag.genIndex);
    const sampleGen = gens.find((gen) => gen.oper === 53);
    if (!sampleGen) {
      Object.assign(instrumentGlobal, gensToParams(gens));
      continue;
    }

    zones.push(normalizeZone({
      ...presetParams,
      ...instrumentGlobal,
      ...gensToParams(gens),
      sampleID: sampleGen.rawAmount,
    }));
  }

  return zones;
}

function gensToParams(gens) {
  const params = {};
  for (const gen of gens) {
    switch (gen.oper) {
      case 8:
        params.initialFilterFc = gen.amount;
        break;
      case 17:
        params.pan = gen.amount;
        break;
      case 34:
        params.attackVolEnv = gen.amount;
        break;
      case 36:
        params.decayVolEnv = gen.amount;
        break;
      case 37:
        params.sustainVolEnv = gen.amount;
        break;
      case 38:
        params.releaseVolEnv = gen.amount;
        break;
      case 43:
        params.keyRange = [gen.rawAmount & 0xff, gen.rawAmount >> 8];
        break;
      case 44:
        params.velRange = [gen.rawAmount & 0xff, gen.rawAmount >> 8];
        break;
      case 48:
        params.initialAttenuation = gen.amount;
        break;
      case 51:
        params.coarseTune = gen.amount;
        break;
      case 52:
        params.fineTune = gen.amount;
        break;
      case 54:
        params.sampleModes = gen.rawAmount;
        break;
      case 58:
        params.overridingRootKey = gen.rawAmount;
        break;
      default:
        break;
    }
  }
  return params;
}

function normalizeZone(zone) {
  return {
    keyRange: zone.keyRange || [0, 127],
    velRange: zone.velRange || [0, 127],
    sampleID: zone.sampleID,
    initialFilterFc: zone.initialFilterFc ?? 13500,
    attackVolEnv: zone.attackVolEnv ?? -12000,
    decayVolEnv: zone.decayVolEnv ?? -12000,
    sustainVolEnv: zone.sustainVolEnv ?? 0,
    releaseVolEnv: zone.releaseVolEnv ?? -8000,
    initialAttenuation: zone.initialAttenuation ?? 0,
    fineTune: zone.fineTune ?? 0,
    coarseTune: zone.coarseTune ?? 0,
    sampleModes: zone.sampleModes ?? 0,
    overridingRootKey: zone.overridingRootKey === 255 || zone.overridingRootKey === undefined ? -1 : zone.overridingRootKey,
    pan: zone.pan ?? 0,
  };
}

function timecentsToSeconds(value) {
  if (value <= -12000) return 0.002;
  return Math.max(0.002, 2 ** (value / 1200));
}

function centsToHz(value) {
  return Math.min(20000, 8.176 * 2 ** (value / 1200));
}

window.SoundFont2 = SoundFont2;
window.SoundFontParseError = SoundFontParseError;
