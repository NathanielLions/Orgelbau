// ==========================================
// 1. SOUNDFONT FETCH & AUDIO ENGINE STATE
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
        document.getElementById('audio-status').innerText = "⏳ Loading Wurlitzer166.sf2...";
        const response = await fetch(SOUNDFONT_URL);
        const arrayBuffer = await response.arrayBuffer();
        document.getElementById('audio-status').innerText = "";
    } catch (err) {
        document.getElementById('audio-status').innerText = "";
    }
}
window.onload = fetchSoundfont;

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
    document.getElementById('current-tick').innerText = '0';
    syncSwitchesToTimeline(0);
    draw();
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
    document.getElementById('current-tick').innerText = newTick;
    syncSwitchesToTimeline(newTick);
    draw();
    
    let lookaheadSeconds = 0.1; 
    let lookaheadMidiSeconds = currentMidiSeconds + lookaheadSeconds;
    
    currentMidi.tracks.forEach(track => {
        if (hiddenChannels.has(track.channel)) return;
        track.notes.forEach(note => {
            if (note.time >= currentMidiSeconds && note.time < lookaheadMidiSeconds) {
                let noteId = `${track.channel}-${note.midi}-${note.ticks}`;
                if (!scheduledNotes.has(noteId)) {
                    scheduledNotes.add(noteId);
                    // Passes the channel to the note player
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
    let activeStops = getActiveStopsForChannel(channel);
    
    if (activeStops.length === 0) return; 
    
    activeStops.forEach(stop => {
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        if (stop.val === 15) osc.type = 'sine';
        else if (stop.val === 82) osc.type = 'triangle';
        else if (stop.val === 40) osc.type = 'sawtooth';
        else osc.type = 'square';
        
        osc.frequency.value = Math.pow(2, (note.midi - 69) / 12) * 440;
        
        let swellVal = document.getElementById('swell-switch').checked ? 1.0 : 0.4;
        
        gain.gain.setValueAtTime(0, playTime);
        gain.gain.linearRampToValueAtTime(0.08 * swellVal, playTime + 0.02); 
        gain.gain.setValueAtTime(0.08 * swellVal, playTime + note.duration - 0.02); 
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
// 2. CORE EDITOR LOGIC & STATE
// ==========================================
let currentMidi = null;
let fileName = "wurlitzer_output";
let ppq = 384; 
let minMidiNote = 127;
let maxMidiNote = 0;
let isUpdatingSwitches = false; 

let hiddenChannels = new Set();
let pistonsAffectPercussion = false;

let swellCC = 11;
let percCC = 10;

const channelColors = [
    '#e74c3c', '#2ecc71', '#f1c40f', '#3498db', '#9b59b6', '#e67e22', '#1abc9c', '#34495e',
    '#ff9ff3', '#8e44ad', '#48dbfb', '#1dd1a1', '#f368e0', '#ff9f43', '#0abde3', '#10ac84'
];

const groupColors = { "Countermelody": "#3498db", "Accompaniment": "#2ecc71", "Trumpetmelody": "#d4ac0d", "Bass": "#e74c3c", "Expression": "#8e44ad", "Presets": "#f39c12" };

let organStructure = {
    "Countermelody (Ch 2)": [ { val: 15, name: "Prestant" }, { val: 82, name: "Soft Violin" }, { val: 40, name: "Loud Violin" }, { val: 75, name: "Flageolet" }, { val: 73, name: "Flute" }, { val: 8, name: "Bells" }, { val: 9, name: "Unaphone" } ],
    "Accompaniment (Ch 3)": [ { val: 11, name: "Stopped Flute" }, { val: 70, name: "Open Flute" }, { val: 79, name: "Strings" } ],
    "Trumpetmelody (Ch 1)": [ { val: 68, name: "Viola Bassoon" }, { val: 56, name: "Wooden Trumpet" }, { val: 66, name: "Brass Trumpet" } ],
    "Bass (Ch 4)": [ { val: 58, name: "Bass Flute" }, { val: 43, name: "Wooden Trombone" }, { val: 50, name: "Brass Trombone" }]
};

// Swell set to 127 for open, 64 for closed
let pistons = [
    { name: "Pianissimo", activeStops: [15, 82, 73, 75, 11, 70, 68, 58], swell: 127 },
    { name: "Forte", activeStops: [15, 40, 82, 73, 75, 11, 70, 79, 68, 56, 58, 43], swell: 127 },
    { name: "Piston Default 1", activeStops: [15, 40, 9, 70, 79, 70, 11, 68, 66, 58, 50], swell: 127 }, 
    { name: "Piston Default 2", activeStops: [8, 15, 75, 82, 58, 70, 11, 68, 58 ], swell: 64 },
    { name: "Piston Default 3", activeStops: [15, 82, 40, 58, 50, 43, 70, 11, 79, 56, 68, 66], swell: 127 }, 
    { name: "Piston Default 4", activeStops: [], swell: 64 },
    { name: "General Cancel", activeStops: [15, 11, 70, 68, 58, 10], swell: 64 } 
];

function toggleDarkMode(isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    draw(); 
}

function toggleMidiVals(show) {
    if (show) document.body.classList.remove('hide-midi-vals');
    else document.body.classList.add('hide-midi-vals');
}

function updateMapping(manualKey, index, newVal) {
    organStructure[manualKey][index].val = parseInt(newVal);
    buildEditorUI();
    if(currentMidi) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
}

function updateExpMapping(type, newVal) {
    if (type === 'swell') swellCC = parseInt(newVal);
    if (type === 'perc') percCC = parseInt(newVal);
    buildEditorUI();
    if(currentMidi) { syncSwitchesToTimeline(document.getElementById('tick-slider').value); renderLog(); }
}

function saveCurrentStateToPiston(index) {
    pistons[index].name = document.getElementById('piston-name-' + index).value;
    let active = [];
    Object.values(organStructure).flat().forEach(s => { let cb = document.getElementById(`stop-${s.val}`); if (cb && cb.checked) active.push(s.val); });
    let percCb = document.getElementById(`stop-${percCC}`); if (percCb && percCb.checked) active.push(percCC);
    let swCb = document.getElementById('swell-switch');
    // Saves 127 if open, 64 if closed
    pistons[index].swell = (swCb && swCb.checked) ? 127 : 64;
    pistons[index].activeStops = active;
    buildEditorUI(); 
    alert(`Saved current editor registration to ${pistons[index].name}!`);
}

function buildSettingsUI() {
    const container = document.getElementById('settings-mapping-container');
    container.innerHTML = '';
    let gridHTML = `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px;">`;

    for (const [manual, stops] of Object.entries(organStructure)) {
        let color = groupColors[manual.split(' ')[0]] || "#3498db";
        gridHTML += `<div><h4 style="color: ${color}; margin-bottom: 5px;">${manual.split(' ')[0]}</h4>`;
        stops.forEach((s, i) => {
            gridHTML += `<div class="settings-row" style="padding: 5px 10px;"><span style="font-weight: normal; font-size: 0.9em;">${s.name}</span><input type="number" class="mapping-input" value="${s.val}" onchange="updateMapping('${manual}', ${i}, this.value)"></div>`;
        });
        gridHTML += `</div>`;
    }

    gridHTML += `<div><h4 style="color: #8e44ad; margin-bottom: 5px;">Expression & Percussion</h4>
        <div class="settings-row" style="padding: 5px 10px;"><span style="font-weight: normal; font-size: 0.9em;">Swell Shutters</span><input type="number" class="mapping-input" value="${swellCC}" onchange="updateExpMapping('swell', this.value)"></div>
        <div class="settings-row" style="padding: 5px 10px;"><span style="font-weight: normal; font-size: 0.9em;">Percussion</span><input type="number" class="mapping-input" value="${percCC}" onchange="updateExpMapping('perc', this.value)"></div>
    </div></div>`;
    container.innerHTML += gridHTML;

    let pistonHTML = `<h4 style="color: #f39c12; margin-top: 30px; border-top: 1px solid var(--border-color); padding-top: 15px;">Piston Configurations</h4>`;
    pistons.forEach((p, i) => {
        pistonHTML += `<div class="settings-row" style="padding: 5px 10px; display: flex; gap: 10px;"><input type="text" id="piston-name-${i}" class="mapping-input" style="flex: 1; text-align: left;" value="${p.name}"><button class="nudge-btn" onclick="saveCurrentStateToPiston(${i})">Save Organ State</button></div>`;
    });
    container.innerHTML += pistonHTML;
}

function buildEditorUI() {
    document.getElementById('col-countermelody').innerHTML = '';
    document.getElementById('col-accomp-trumpet').innerHTML = '';
    document.getElementById('col-bass-exp').innerHTML = '';
    document.getElementById('col-pistons').innerHTML = '';

    for (const [manual, stops] of Object.entries(organStructure)) {
        let shortMan = manual.split(' ')[0];
        let rawChannel = manual.replace(shortMan, '').trim(); 
        let color = groupColors[shortMan] || "#3498db";

        const groupDiv = document.createElement('div');
        groupDiv.className = 'manual-group';
        groupDiv.style.borderLeftColor = color;
        groupDiv.innerHTML = `<h4 style="color: ${color};">${shortMan} <span class="midi-val" style="color: var(--text-color); font-weight: normal; font-size: 0.8em;">${rawChannel}</span></h4><div class="stop-grid"></div>`;
        
        const grid = groupDiv.querySelector('.stop-grid');
        stops.forEach(s => {
            grid.innerHTML += `<div class="stop-row"><span class="stop-name">${s.name} <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(${s.val})</span></span><label class="switch"><input type="checkbox" id="stop-${s.val}" onchange="handleStopToggle(${s.val}, '${s.name}', '${shortMan}', this.checked)"><span class="slider-switch"></span></label></div>`;
        });

        if (shortMan === "Countermelody") document.getElementById('col-countermelody').appendChild(groupDiv);
        else if (shortMan === "Accompaniment" || shortMan === "Trumpetmelody") document.getElementById('col-accomp-trumpet').appendChild(groupDiv);
        else if (shortMan === "Bass") document.getElementById('col-bass-exp').appendChild(groupDiv);
    }

    const expDiv = document.createElement('div');
    expDiv.className = 'manual-group';
    expDiv.style.borderLeftColor = "#8e44ad";
    expDiv.innerHTML = `<h4 style="color: #8e44ad;">Expression & Percussion</h4><div class="stop-grid"><div class="stop-row"><span class="stop-name" style="color: #8e44ad;">Swell Shutters <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(CC ${swellCC})</span></span><label class="switch"><input type="checkbox" id="swell-switch" onchange="handleSwellToggle(this.checked)"><span class="slider-switch swell-bg"></span></label></div><div class="stop-row"><span class="stop-name">Percussion <span class="midi-val" style="color: #7f8c8d; font-weight: normal;">(${percCC})</span></span><label class="switch"><input type="checkbox" id="stop-${percCC}" onchange="handleStopToggle(${percCC}, 'Percussion', 'Perc', this.checked)"><span class="slider-switch"></span></label></div></div>`;
    document.getElementById('col-bass-exp').appendChild(expDiv);

    let pistonsHtml = `<div class="manual-group" style="border-left-color: #f39c12; flex: 1;"><h4 style="color: #f39c12;">Saved Pistons</h4><div class="stop-grid" style="gap: 5px;">`;
    pistons.forEach((p, i) => {
        let extraStyle = i === 6 ? "margin-top: 15px; border-color: #e74c3c; color: #e74c3c;" : "";
        pistonsHtml += `<button class="nudge-btn" style="width: 100%; text-align: left; padding: 10px; font-size: 1em; ${extraStyle}" onclick="applyRegistrationState(pistons[${i}].activeStops, pistons[${i}].swell)">${p.name}</button>`;
    });
    pistonsHtml += `</div></div>`;
    document.getElementById('col-pistons').innerHTML = pistonsHtml;
}

buildSettingsUI();
buildEditorUI();

function openTab(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    if(btnElement) btnElement.classList.add('active');
    if (tabId === 'page-editor' && currentMidi) setTimeout(() => draw(), 10);
}

document.getElementById('midi-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fileName = file.name.replace(".mid", "");
    
    const arrayBuffer = await file.arrayBuffer();
    currentMidi = new Midi(arrayBuffer);
    ppq = currentMidi.header.ppq || 384; 
    
    let maxTicks = 0; minMidiNote = 127; maxMidiNote = 0;
    let activeChannels = new Set(); hiddenChannels.clear();

    currentMidi.tracks.forEach(t => {
        if (t.notes.length > 0) activeChannels.add(t.channel);
        t.notes.forEach(n => { 
            if(n.ticks + n.durationTicks > maxTicks) maxTicks = n.ticks + n.durationTicks; 
            if(n.midi < minMidiNote) minMidiNote = n.midi;
            if(n.midi > maxMidiNote) maxMidiNote = n.midi;
        });
    });
    if (maxMidiNote < minMidiNote) { minMidiNote = 0; maxMidiNote = 127; }

    const filtersDiv = document.getElementById('channel-filters');
    filtersDiv.innerHTML = '<strong style="display:flex; align-items:center; margin-right:10px; font-size:0.9em;">Tracks:</strong>';
    Array.from(activeChannels).sort((a,b)=>a-b).forEach(ch => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn'; btn.style.backgroundColor = channelColors[ch % 16]; btn.innerText = `Ch ${ch + 1}`; 
        btn.onclick = () => {
            if (hiddenChannels.has(ch)) { hiddenChannels.delete(ch); btn.classList.remove('inactive'); } 
            else { hiddenChannels.add(ch); btn.classList.add('inactive'); }
            draw();
        };
        filtersDiv.appendChild(btn);
    });
    
    const slider = document.getElementById('tick-slider');
    slider.max = maxTicks + ppq; slider.value = 0; slider.disabled = false;
    document.getElementById('zoom-slider').disabled = false;
    document.getElementById('current-tick').innerText = '0';
    document.getElementById('export-btn').style.display = 'block';
    
    renderLog(); syncSwitchesToTimeline(0); openTab('page-editor', document.getElementById('tab-editor'));
});

window.addEventListener('resize', () => { if (currentMidi) draw(); });

document.getElementById('tick-slider').addEventListener('input', (e) => {
    const newTick = parseInt(e.target.value);
    document.getElementById('current-tick').innerText = newTick;
    syncSwitchesToTimeline(newTick);
    draw();
    
    if (isPlaying) {
        killAllNotes();
        startMidiSeconds = currentMidi.header.ticksToSeconds(newTick);
        startTimeMs = performance.now();
    }
});

document.getElementById('zoom-slider').addEventListener('input', (e) => {
    document.getElementById('zoom-level').innerText = e.target.value + 'x'; draw();
});

function nudge(amount) {
    const slider = document.getElementById('tick-slider');
    if (slider.disabled) return;
    let newVal = parseInt(slider.value) + amount;
    if (newVal < 0) newVal = 0;
    if (newVal > parseInt(slider.max)) newVal = parseInt(slider.max);
    
    slider.value = newVal;
    document.getElementById('current-tick').innerText = newVal;
    syncSwitchesToTimeline(newVal);
    draw();
    
    if (isPlaying) {
        killAllNotes();
        startMidiSeconds = currentMidi.header.ticksToSeconds(newVal);
        startTimeMs = performance.now();
    }
}

function handleSwellToggle(isChecked) {
    if (isUpdatingSwitches) return; 
    // Uses 127 and 64
    if (isChecked) addEvent(swellCC, 127, 'Swell OPEN', 'Exp');
    else addEvent(swellCC, 64, 'Swell CLOSED', 'Exp');
}

function handleStopToggle(val, name, manual, isChecked) {
    if (isUpdatingSwitches) return; 
    if (isChecked) addEvent(81, val, `${name} ON`, manual);
    else addEvent(80, val, `${name} OFF`, manual);
}

function renderLog() {
    const tbody = document.getElementById('log-body'); tbody.innerHTML = '';
    if (!currentMidi) return;
    let track = currentMidi.tracks.find(t => t.channel === 15); if (!track) return;
    let events = [];
    [swellCC, 80, 81].forEach(cc => {
        if (track.controlChanges[cc]) track.controlChanges[cc].forEach(e => { events.push({ cc: cc, val: Math.round(e.value * 127), ticks: e.ticks }); });
    });
    events.sort((a, b) => b.ticks - a.ticks);

    events.forEach(e => {
        let label = ""; let manual = "Sys"; let labelColor = "var(--text-color)";
        if (e.cc === swellCC) {
            // Checks for >= 127 to mark it Open
            label = e.val >= 127 ? "Swell OPEN" : "Swell CLOSED"; manual = "Exp"; labelColor = "#9b59b6";
        } else {
            let foundName = "Unknown";
            for (const [man, stops] of Object.entries(organStructure)) {
                let stop = stops.find(s => s.val === e.val);
                if (stop) { foundName = stop.name; manual = man.split(' ')[0]; break; }
            }
            if (e.val === percCC) { foundName = "Percussion"; manual = "Perc"; }
            if (e.cc === 81) { label = foundName + " ON"; labelColor = "#27ae60"; } 
            else { label = foundName + " OFF"; labelColor = "#e74c3c"; }
        }
        tbody.innerHTML += `<tr><td><strong>${e.ticks}</strong></td><td>${manual}</td><td style="color:${labelColor}"><strong>${label}</strong></td><td><button class="del-btn" onclick="removeEvent(${e.cc}, ${e.val}, ${e.ticks})">X</button></td></tr>`;
    });
}

function applyRegistrationState(activeStopsArr, swellVal) {
    if (!currentMidi) return alert("Please load a MIDI file first!");
    
    let baseTick = parseInt(document.getElementById('tick-slider').value);
    let track = currentMidi.tracks.find(t => t.channel === 15);
    if (!track) { track = currentMidi.addTrack(); track.channel = 15; }

    [swellCC, 80, 81].forEach(cc => {
        if (track.controlChanges[cc]) {
            track.controlChanges[cc] = track.controlChanges[cc].filter(e => {
                if (!pistonsAffectPercussion && (cc === 80 || cc === 81)) if (Math.round(e.value * 127) === percCC) return true;
                return Math.abs(e.ticks - baseTick) > 40; 
            });
        }
    });

    let allOrganCCs = Object.values(organStructure).flat().map(s => s.val); allOrganCCs.push(percCC);
    let currentOffset = 0; 

    if (!track.controlChanges[swellCC]) track.controlChanges[swellCC] = [];
    track.controlChanges[swellCC].push({ ticks: baseTick + currentOffset, number: swellCC, value: swellVal / 127, time: currentMidi.header.ticksToSeconds(baseTick + currentOffset) });
    currentOffset++;

    allOrganCCs.forEach(val => {
        if (!pistonsAffectPercussion && val === percCC) return;
        let turnOn = activeStopsArr.includes(val);
        let targetCC = turnOn ? 81 : 80;
        if (!track.controlChanges[targetCC]) track.controlChanges[targetCC] = [];
        track.controlChanges[targetCC].push({ ticks: baseTick + currentOffset, number: targetCC, value: val / 127, time: currentMidi.header.ticksToSeconds(baseTick + currentOffset) });
        currentOffset++;
    });

    [swellCC, 80, 81].forEach(cc => { if(track.controlChanges[cc]) track.controlChanges[cc].sort((a,b) => a.ticks - b.ticks); });

    let sliderMax = parseInt(document.getElementById('tick-slider').max);
    let syncTick = baseTick + currentOffset;
    if (syncTick > sliderMax) syncTick = sliderMax;

    document.getElementById('tick-slider').value = syncTick;
    document.getElementById('current-tick').innerText = syncTick;
    renderLog(); syncSwitchesToTimeline(syncTick); draw(); 
    
    if (isPlaying) {
        killAllNotes();
        startMidiSeconds = currentMidi.header.ticksToSeconds(syncTick);
        startTimeMs = performance.now();
    }
}

function addEvent(cc, val, label, manual) {
    if (!currentMidi) return;
    let baseTick = parseInt(document.getElementById('tick-slider').value);
    let track = currentMidi.tracks.find(t => t.channel === 15);
    if (!track) { track = currentMidi.addTrack(); track.channel = 15; }

    let ccsToCheck = (cc === swellCC) ? [swellCC] : [80, 81];
    ccsToCheck.forEach(checkCc => {
        if (track.controlChanges[checkCc]) {
            track.controlChanges[checkCc] = track.controlChanges[checkCc].filter(e => {
                let isSameStop = (cc === swellCC) ? true : (Math.round(e.value * 127) === val);
                return !(isSameStop && Math.abs(e.ticks - baseTick) <= 10);
            });
        }
    });

    if (!track.controlChanges[cc]) track.controlChanges[cc] = [];
    let safeTick = baseTick; while (track.controlChanges[cc].some(e => e.ticks === safeTick)) { safeTick += 1; }
    track.controlChanges[cc].push({ ticks: safeTick, number: cc, value: val / 127, time: currentMidi.header.ticksToSeconds(safeTick) });
    track.controlChanges[cc].sort((a, b) => a.ticks - b.ticks);
    renderLog(); draw(); 
}

function removeEvent(cc, val, tick) {
    let track = currentMidi.tracks.find(t => t.channel === 15);
    if (track && track.controlChanges[cc]) track.controlChanges[cc] = track.controlChanges[cc].filter(e => !(e.ticks === tick && Math.round(e.value * 127) === val));
    renderLog();
    const currentTick = parseInt(document.getElementById('tick-slider').value);
    syncSwitchesToTimeline(currentTick);
    draw();
}

function syncSwitchesToTimeline(currentTick) {
    if (!currentMidi) return;
    isUpdatingSwitches = true; 
    let track = currentMidi.tracks.find(t => t.channel === 15);
    let stopStates = {}; let swellState = false; 

    if (track) {
        let events = [];
        [swellCC, 80, 81].forEach(cc => {
            if (track.controlChanges[cc]) track.controlChanges[cc].forEach(e => { if (e.ticks <= currentTick) events.push({ cc: cc, val: Math.round(e.value * 127), ticks: e.ticks }); });
        });
        events.sort((a, b) => a.ticks - b.ticks);
        events.forEach(e => {
            if (e.cc === 81) stopStates[e.val] = true;
            if (e.cc === 80) stopStates[e.val] = false;
            // Checks for >= 127 to flip switch visually
            if (e.cc === swellCC) swellState = (e.val >= 127); 
        });
    }

    Object.values(organStructure).flat().forEach(s => { let cb = document.getElementById(`stop-${s.val}`); if (cb) cb.checked = !!stopStates[s.val]; });
    let percCheck = document.getElementById(`stop-${percCC}`); if (percCheck) percCheck.checked = !!stopStates[percCC];
    let swellCheckbox = document.getElementById('swell-switch'); if (swellCheckbox) swellCheckbox.checked = swellState;
    isUpdatingSwitches = false; 
}

function draw() {
    if (!currentMidi) return;
    const canvas = document.getElementById('piano-roll'); if (canvas.offsetParent === null) return; 
    const ctx = canvas.getContext('2d'); const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; ctx.scale(dpr, dpr);
    const width = rect.width; const height = rect.height;

    ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#111' : '#1a1a1a';
    ctx.fillRect(0, 0, width, height);
    
    const sliderMax = parseInt(document.getElementById('tick-slider').max);
    const currentTick = parseInt(document.getElementById('tick-slider').value);
    const zoom = parseFloat(document.getElementById('zoom-slider').value);
    
    const windowTicks = sliderMax / zoom;
    let startTick = currentTick - (windowTicks / 2); let endTick = currentTick + (windowTicks / 2);
    if (startTick < 0) { startTick = 0; endTick = windowTicks; }
    if (endTick > sliderMax) { endTick = sliderMax; startTick = sliderMax - windowTicks; }

    const scaleX = width / windowTicks;
    const noteRange = (maxMidiNote - minMidiNote) + 4; const noteHeight = height / noteRange;

    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    for(let i = Math.ceil(startTick / ppq) * ppq; i <= endTick; i += ppq) {
        ctx.beginPath(); ctx.moveTo((i - startTick) * scaleX, 0); ctx.lineTo((i - startTick) * scaleX, height); ctx.stroke();
    }

    currentMidi.tracks.forEach(t => {
        if (hiddenChannels.has(t.channel)) return; 
        ctx.fillStyle = channelColors[t.channel % 16];
        t.notes.forEach(n => {
            if (n.ticks + n.durationTicks > startTick && n.ticks < endTick) ctx.fillRect((n.ticks - startTick) * scaleX, height - ((n.midi - minMidiNote + 2) * noteHeight), Math.max(n.durationTicks * scaleX, 2), Math.max(noteHeight - 1, 3));
        });
    });

    let track = currentMidi.tracks.find(t => t.channel === 15);
    if (track) {
        [swellCC, 80, 81].forEach(cc => {
            if (track.controlChanges[cc]) track.controlChanges[cc].forEach(e => {
                if (e.ticks >= startTick && e.ticks <= endTick) {
                    ctx.fillStyle = cc === swellCC ? '#9b59b6' : (cc === 81 ? '#2ecc71' : '#e74c3c');
                    ctx.fillRect(((e.ticks - startTick) * scaleX) - 2, cc === swellCC ? 16 : 0, 4, 12);
                }
            });
        });
    }

    ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 2; ctx.beginPath();
    const scrubberX = (currentTick - startTick) * scaleX; ctx.moveTo(scrubberX, 0); ctx.lineTo(scrubberX, height); ctx.stroke();
}

function exportMidi() {
    if (!currentMidi) return;
    const blob = new Blob([currentMidi.toArray()], { type: "audio/midi" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName + "_Wurlitzer166.mid"; a.click();
}

// ==========================================
// 3. WINDOW BINDINGS FOR HTML INTERACTION
// ==========================================
window.openTab = openTab;
window.togglePlay = togglePlay;
window.stopPlayback = stopPlayback;
window.nudge = nudge;
window.toggleDarkMode = toggleDarkMode;
window.toggleMidiVals = toggleMidiVals;
window.updateMapping = updateMapping;
window.updateExpMapping = updateExpMapping;
window.saveCurrentStateToPiston = saveCurrentStateToPiston;
window.handleSwellToggle = handleSwellToggle;
window.handleStopToggle = handleStopToggle;
window.removeEvent = removeEvent;
window.applyRegistrationState = applyRegistrationState;
window.exportMidi = exportMidi;
window.pistonsAffectPercussion = pistonsAffectPercussion;
window.pistons = pistons;
