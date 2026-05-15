// ==========================================
// 1. AUDIO ENGINE & STATE
// ==========================================
const SOUNDFONT_URL = "./Wurlitzer166.sf2"; 

let audioCtx;
let isPlaying = false;
let startTimeMs = 0;
let startMidiSeconds = 0;
let scheduledNotes = new Set();
let activeOscillators = [];

async function fetchSoundfont() {
    try {
        const audioStatus = document.getElementById('audio-status');
        if(audioStatus) audioStatus.innerText = "⏳ Loading Wurlitzer166.sf2...";
        const response = await fetch(SOUNDFONT_URL);
        const arrayBuffer = await response.arrayBuffer();
        if(audioStatus) audioStatus.innerText = "";
    } catch (err) {
        const audioStatus = document.getElementById('audio-status');
        if(audioStatus) audioStatus.innerText = "";
    }
}

function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function togglePlay() {
    initAudio();
    if (isPlaying) {
        isPlaying = false;
        document.getElementById('play-btn').innerText = "▶ Play";
        killAllNotes();
    } else {
        if (!currentMidi) return alert("Please import a MIDI file first!");
        isPlaying = true;
        document.getElementById('play-btn').innerText = "⏸ Pause";
        
        let currentTick = parseInt(document.getElementById('tick-slider').value);
        startMidiSeconds = currentMidi.header.ticksToSeconds(currentTick);
        startTimeMs = performance.now();
        scheduledNotes.clear();
        scheduler();
    }
}

function stopPlayback() {
    isPlaying = false;
    document.getElementById('play-btn').innerText = "▶ Play";
    document.getElementById('tick-slider').value = 0;
    updateDisplays(0);
    if (typeof syncSwitchesToTimeline === "function") syncSwitchesToTimeline(0);
    if (typeof draw === "function") draw();
    killAllNotes();
}

function killAllNotes() {
    activeOscillators.forEach(osc => { try { osc.stop(); } catch(e){} });
    activeOscillators = [];
    scheduledNotes.clear();
}

function scheduler() {
    if (!isPlaying || !currentMidi) return;
    
    let now = performance.now();
    let elapsedSeconds = (now - startTimeMs) / 1000;
    let currentMidiSeconds = startMidiSeconds + elapsedSeconds;
    
    let newTick = Math.round(currentMidi.header.secondsToTicks(currentMidiSeconds));
    let sliderMax = parseInt(document.getElementById('tick-slider').max);
    
    if (newTick > sliderMax) { stopPlayback(); return; }
    
    document.getElementById('tick-slider').value = newTick;
    updateDisplays(newTick);
    if (typeof syncSwitchesToTimeline === "function") syncSwitchesToTimeline(newTick);
    if (typeof draw === "function") draw();
    
    let lookaheadSeconds = 0.1;
    let lookaheadMidiSeconds = currentMidiSeconds + lookaheadSeconds;
    
    currentMidi.tracks.forEach(track => {
        if (hiddenChannels && hiddenChannels.has(track.channel)) return;
        track.notes.forEach(note => {
            if (note.time >= currentMidiSeconds && note.time < lookaheadMidiSeconds) {
                let noteId = `${track.channel}-${note.midi}-${note.ticks}`;
                if (!scheduledNotes.has(noteId)) {
                    scheduledNotes.add(noteId);
                    scheduleNotePlay(note, track.channel, note.time - currentMidiSeconds); 
                }
            }
        });
    });
    requestAnimationFrame(scheduler);
}

function getActiveStopsForChannel(channel) {
    let activeStops = [];
    for (const [manual, stops] of Object.entries(organStructure)) {
        let match = manual.match(/Ch (\d+)/);
        if (match) {
            let rawChannel = parseInt(match[1]) - 1;
            if (rawChannel === channel) {
                stops.forEach(s => {
                    if (s.visible === false) return;
                    let cb = document.getElementById(`stop-${s.val}`);
                    if (cb && cb.checked) activeStops.push(s);
                });
            }
        }
    }
    return activeStops;
}

function scheduleNotePlay(note, channel, delaySeconds) {
    let playTime = audioCtx.currentTime + delaySeconds;
    
    // Handle Rhythm Track
    if (channel === 9) {
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'triangle';
        let freq = note.midi < 40 ? 60 : 200; 
        osc.frequency.setValueAtTime(freq, playTime);
        osc.frequency.exponentialRampToValueAtTime(10, playTime + 0.1);

        gain.gain.setValueAtTime(0.1, playTime);
        gain.gain.exponentialRampToValueAtTime(0.001, playTime + 0.1);

        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(playTime);
        osc.stop(playTime + 0.1);
        activeOscillators.push(osc);
        return; 
    }

    let activeStops = getActiveStopsForChannel(channel);
    if (activeStops.length === 0) return;
    
    let attack = 0.02;
    let release = 0.02;
    if (note.duration < 0.04) {
        attack = note.duration / 2;
        release = note.duration / 2;
    }
    
    activeStops.forEach(stop => {
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        // Dynamically pull waveType from the stop metadata (default to square)
        osc.type = stop.waveType || 'square';
        
        osc.frequency.value = Math.pow(2, (note.midi - 69) / 12) * 440;
        
        let swellSwitch = document.getElementById('swell-switch');
        let swellVal = (swellSwitch && swellSwitch.checked) ? 1.0 : 0.4;
        let peakVolume = 0.08 * swellVal;
        
        gain.gain.setValueAtTime(0, playTime);
        gain.gain.linearRampToValueAtTime(peakVolume, playTime + attack); 
        gain.gain.setValueAtTime(peakVolume, Math.max(playTime + attack, playTime + note.duration - release)); 
        gain.gain.linearRampToValueAtTime(0, playTime + note.duration);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start(playTime);
        osc.stop(playTime + note.duration);
        activeOscillators.push(osc);
    });
    
    setTimeout(() => { activeOscillators = activeOscillators.filter(o => o !== null); }, (note.duration + delaySeconds) * 1000 + 100);
}

// ==========================================
// 2. TIME & DISPLAY ENGINE
// ==========================================
let timeDisplayFormat = 'ticks'; 

window.updateTimeFormat = function(format) {
    timeDisplayFormat = format;
    let lbl = "Tick";
    if (format === 'time') lbl = "Time";
    if (format === 'measures') lbl = "Meas";
    
    let timeLabel = document.getElementById('time-label');
    let logHeader = document.getElementById('log-time-header');
    if (timeLabel) timeLabel.innerText = lbl;
    if (logHeader) logHeader.innerText = lbl;
    
    let currentTick = parseInt(document.getElementById('tick-slider')?.value || 0);
    updateDisplays(currentTick);
    if (typeof renderLog === "function") renderLog();
    
    saveWorkspace(); // Auto-save setting change
};

function formatTimeDisplay(ticks) {
    if (!currentMidi) return ticks;
    if (timeDisplayFormat === 'time') {
        let sec = currentMidi.header.ticksToSeconds(ticks);
        let mins = Math.floor(sec / 60);
        let remSec = (sec % 60).toFixed(2);
        return `${mins}:${remSec.padStart(5, '0')}`;
    } else if (timeDisplayFormat === 'measures') {
        let bar = Math.floor(ticks / (ppq * 4)) + 1;
        let beat = Math.floor((ticks % (ppq * 4)) / ppq) + 1;
        let t = Math.round(ticks % ppq);
        return `${bar}:${beat}:${t.toString().padStart(3, '0')}`;
    }
    return ticks;
}

function updateDisplays(tickValue) {
    let currentTickDisplay = document.getElementById('current-tick');
    if (currentTickDisplay) currentTickDisplay.innerText = formatTimeDisplay(tickValue);
}

window.nudgeTicks = function(amount) { if(typeof nudge === "function") nudge(amount); };
window.nudgeBeats = function(amount) { if(typeof nudge === "function") nudge(amount * ppq); };
window.nudgeSeconds = function(amountSec) {
    if (!currentMidi || document.getElementById('tick-slider').disabled) return;
    let currentTick = parseInt(document.getElementById('tick-slider').value);
    let currentSec = currentMidi.header.ticksToSeconds(currentTick);
    let targetSec = Math.max(0, currentSec + amountSec);
    let targetTick = Math.round(currentMidi.header.secondsToTicks(targetSec));
    let diff = targetTick - currentTick;
    if(typeof nudge === "function") nudge(diff);
};

// ==========================================
// 3. CORE EDITOR LOGIC & METADATA STATE
// ==========================================
let currentMidi = null;
let fileName = "universal_organ_output";
let ppq = 384;
let isUpdatingSwitches = false; 
let hiddenChannels = new Set();

const DEFAULT_SWELL_CC = 4;
const DEFAULT_PERC_CC = 12;

// Upgraded Organ Structure with dynamic waveType embedded
const DEFAULT_ORGAN_STRUCTURE = {
    "Accompaniment (Ch 2)": [ 
        { val: 70, name: "Open Flute", visible: true, waveType: "triangle" }, 
        { val: 11, name: "Stopped Flute", visible: true, waveType: "sine" }, 
        { val: 48, name: "Strings 8", visible: true, waveType: "sawtooth" }, 
        { val: 88, name: "Strings 4", visible: true, waveType: "square" }
    ],
    "Trumpetmelody (Ch 3)": [ 
        { val: 68, name: "Baritone", visible: true, waveType: "sawtooth" }, 
        { val: 56, name: "Trumpet", visible: true, waveType: "square" }, 
        { val: 61, name: "Horn", visible: true, waveType: "square" }, 
        { val: 42, name: "Cello", visible: true, waveType: "sawtooth" } 
    ],
    "Countermelody (Ch 4)": [ 
        { val: 8, name: "Glockenspiel", visible: true, waveType: "sine" }, 
        { val: 10, name: "Unaphone", visible: true, waveType: "sine" }, 
        { val: 19, name: "Prestant", visible: true, waveType: "triangle" }, 
        { val: 20, name: "Celeste", visible: true, waveType: "triangle" }, 
        { val: 71, name: "Clarinet", visible: true, waveType: "square" }, 
        { val: 40, name: "Forte Violin", visible: true, waveType: "sawtooth" }, 
        { val: 73, name: "Piccolo", visible: true, waveType: "triangle" }, 
        { val: 75, name: "Flageolet", visible: true, waveType: "triangle" }, 
        { val: 82, name: "Soft Violin", visible: true, waveType: "sawtooth" }, 
        { val: 83, name: "Tibia", visible: true, waveType: "square" }, 
        { val: 86, name: "Bourdon", visible: true, waveType: "square" }, 
        { val: 87, name: "Flute", visible: true, waveType: "square" }
    ],
    "Bass (Ch 4)": [ 
        { val: 57, name: "Trombone", visible: true, waveType: "square" }, 
        { val: 50, name: "Tuba", visible: true, waveType: "sawtooth" }, 
        { val: 58, name: "Bass Flute", visible: true, waveType: "triangle" }
    ]
};

const DEFAULT_PISTONS = [
    { name: "Pianissimo", activeStops: [82, 73, 75, 70, 48, 11, 68, 58, 12], swell: 64 }, 
    { name: "Forte", activeStops: [8, 10, 19, 20, 71, 40, 73, 75, 82, 68, 56, 61, 42, 70, 48, 11, 57, 50, 58, 12], swell: 127 },
    { name: "General Cancel", activeStops: [], swell: 64 } 
];

let swellCC = DEFAULT_SWELL_CC;
let percCC = DEFAULT_PERC_CC;
let organStructure = JSON.parse(JSON.stringify(DEFAULT_ORGAN_STRUCTURE));
let pistons = JSON.parse(JSON.stringify(DEFAULT_PISTONS));

// ==========================================
// 4. MEMORY & DATA MANAGEMENT (NEW)
// ==========================================

window.saveWorkspace = function() {
    const workspaceState = {
        organStructure: organStructure,
        pistons: pistons,
        swellCC: swellCC,
        percCC: percCC,
        settings: {
            timeDisplayFormat: timeDisplayFormat,
            isDarkMode: document.documentElement.getAttribute('data-theme') === 'dark',
            showMidiVals: !document.body.classList.contains('hide-midi-vals')
        }
    };
    localStorage.setItem('OrganMapperWorkspace', JSON.stringify(workspaceState));
};

window.loadWorkspace = function() {
    const saved = localStorage.getItem('OrganMapperWorkspace');
    if (saved) {
        const workspace = JSON.parse(saved);
        
        organStructure = workspace.organStructure || organStructure;
        pistons = workspace.pistons || pistons;
        swellCC = workspace.swellCC || swellCC;
        percCC = workspace.percCC || percCC;
        
        if (workspace.settings) {
            timeDisplayFormat = workspace.settings.timeDisplayFormat || 'ticks';
            let fmtSelect = document.getElementById('time-format-select');
            if (fmtSelect) fmtSelect.value = timeDisplayFormat;
            
            toggleDarkMode(workspace.settings.isDarkMode);
            let darkTgl = document.getElementById('dark-mode-toggle');
            if (darkTgl) darkTgl.checked = workspace.settings.isDarkMode;
            
            toggleMidiVals(workspace.settings.showMidiVals);
            let midiTgl = document.getElementById('show-midi-toggle');
            if (midiTgl) midiTgl.checked = workspace.settings.showMidiVals;
        }
    }
    updateGlobalStopList();
};

window.exportOrganProfile = function() {
    const profile = {
        metadata: { name: "Custom Organ Profile", version: "1.0" },
        organStructure,
        pistons,
        swellCC,
        percCC
    };
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "MyOrganProfile.json";
    a.click();
};

window.importOrganProfile = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const profile = JSON.parse(e.target.result);
            organStructure = profile.organStructure || organStructure;
            pistons = profile.pistons || pistons;
            swellCC = profile.swellCC || swellCC;
            percCC = profile.percCC || percCC;
            
            updateGlobalStopList();
            if (typeof buildSettingsUI === "function") buildSettingsUI();
            saveWorkspace();
            alert(`Successfully loaded: ${profile.metadata?.name || "Custom Organ"}`);
        } catch (err) {
            alert("Error: Invalid Organ Profile file.");
        }
    };
    reader.readAsText(file);
};

// ==========================================
// 5. UTILITY & SETTINGS (Modified to auto-save)
// ==========================================

function updateGlobalStopList() {
    let newAllStops = Object.values(organStructure).flat().map(s => s.val).concat([percCC]);
    pistons.forEach(p => {
        if (!p.offStops) p.offStops = [];
        newAllStops.forEach(cc => { if (!p.activeStops.includes(cc) && !p.offStops.includes(cc)) p.offStops.push(cc); });
        p.activeStops = p.activeStops.filter(cc => newAllStops.includes(cc));
        p.offStops = p.offStops.filter(cc => newAllStops.includes(cc));
        if (p.swellState === undefined) p.swellState = p.swell >= 127 ? 1 : -1;
    });
}

window.resetToDefaults = function() {
    if (confirm("⚠️ Are you sure you want to restore the default settings? \n\nThis will erase any custom stops, remappings, and piston modifications you have made!")) {
        swellCC = DEFAULT_SWELL_CC;
        percCC = DEFAULT_PERC_CC;
        organStructure = JSON.parse(JSON.stringify(DEFAULT_ORGAN_STRUCTURE));
        pistons = JSON.parse(JSON.stringify(DEFAULT_PISTONS));
        
        updateGlobalStopList();
        if (typeof buildSettingsUI === "function") buildSettingsUI();
        if (typeof buildEditorUI === "function") buildEditorUI();
        
        saveWorkspace();
        alert("Success: Factory settings have been restored.");
    }
};

window.toggleDarkMode = function(isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    if (typeof draw === "function") draw();
    saveWorkspace();
};

window.toggleMidiVals = function(show) {
    if (show) document.body.classList.remove('hide-midi-vals');
    else document.body.classList.add('hide-midi-vals');
    saveWorkspace();
};

window.addRank = function(manualKey) {
    let usedCCs = Object.values(organStructure).flat().map(s => s.val).concat([percCC, swellCC, 80, 81]);
    let newVal = 21;
    while (usedCCs.includes(newVal) && newVal < 120) { newVal++; }
    
    organStructure[manualKey].push({ val: newVal, name: "New Stop", visible: true, waveType: "square" });
    updateGlobalStopList();
    if (typeof buildSettingsUI === "function") buildSettingsUI();
    if (typeof buildEditorUI === "function") buildEditorUI();
    saveWorkspace();
};

window.deleteRank = function(manualKey, index) {
    if (confirm(`Are you sure you want to delete ${organStructure[manualKey][index].name}?`)) {
        organStructure[manualKey].splice(index, 1);
        updateGlobalStopList();
        if (typeof buildSettingsUI === "function") buildSettingsUI();
        if (typeof buildEditorUI === "function") buildEditorUI();
        saveWorkspace();
    }
};

// Initialize the workspace from memory on script load
loadWorkspace();
