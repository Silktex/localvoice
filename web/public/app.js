// LocalVoice — Frontend
// Vanilla JS, no dependencies

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────

  let currentPage = 0;
  let pageSize = 25;
  let expandedRow = null;

  // ── Tab Switching ──────────────────────────────────────────────────

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");

      // Trigger data loads on tab switch
      if (tab.dataset.tab === "stt") populateSttModels();
      if (tab.dataset.tab === "speakers") loadSpeakers();
      if (tab.dataset.tab === "sync") { loadSyncStatus(); initSyncCountdown(); }
    });
  });

  // ── Health Panel ───────────────────────────────────────────────────

  async function checkHealth() {
    try {
      const resp = await fetch("/api/health");
      const services = await resp.json();
      services.forEach((svc) => {
        const dot = document.querySelector(`.health-dot[data-service="${svc.name}"]`);
        if (dot) {
          dot.className = "health-dot " + (svc.status === "healthy" ? "healthy" : "error");
        }

        // Disable TTS engine radio buttons for unavailable services
        if (svc.name === "piper" || svc.name === "kokoro") {
          const radio = document.querySelector(`input[name="tts-engine"][value="${svc.name}"]`);
          if (radio) {
            const label = radio.parentElement;
            if (svc.status !== "healthy") {
              radio.disabled = true;
              label.classList.add("engine-unavailable");
              label.title = `${svc.name === "kokoro" ? "Kokoro" : "Piper"} TTS service is not running`;
              if (radio.checked) {
                const other = document.querySelector(`input[name="tts-engine"]:not([value="${svc.name}"])`);
                if (other && !other.disabled) {
                  other.checked = true;
                  other.dispatchEvent(new Event("change"));
                }
              }
            } else {
              radio.disabled = false;
              label.classList.remove("engine-unavailable");
              label.title = "";
            }
          }
        }
      });
    } catch {
      document.querySelectorAll(".health-dot").forEach((d) => (d.className = "health-dot error"));
    }
  }

  checkHealth();
  setInterval(checkHealth, 30000);

  // ── Recordings ─────────────────────────────────────────────────────

  const recordingsBody = document.getElementById("recordings-body");
  const recordingsLoading = document.getElementById("recordings-loading");
  const recordingsEmpty = document.getElementById("recordings-empty");
  const prevBtn = document.getElementById("prev-page");
  const nextBtn = document.getElementById("next-page");
  const pageInfo = document.getElementById("page-info");
  const pageSizeSelect = document.getElementById("page-size");

  async function loadRecordings() {
    recordingsLoading.hidden = false;
    recordingsEmpty.hidden = true;
    recordingsBody.innerHTML = "";
    expandedRow = null;

    try {
      const skip = currentPage * pageSize;
      const resp = await fetch(`/api/recordings?top=${pageSize}&skip=${skip}`);
      const data = await resp.json();
      if (data.error && !data.value) {
        throw new Error(data.error);
      }
      const recordings = Array.isArray(data.value) ? data.value : Array.isArray(data) ? data : [];

      recordingsLoading.hidden = true;

      if (recordings.length === 0) {
        recordingsEmpty.hidden = false;
        nextBtn.disabled = true;
        return;
      }

      recordings.forEach((rec) => {
        const tr = document.createElement("tr");
        const duration = rec.StartTime && rec.EndTime
          ? (new Date(rec.EndTime) - new Date(rec.StartTime)) / 1000
          : rec.Duration;
        const caller = rec.FromDisplayName || rec.FromCallerNumber || rec.Caller || "";
        const called = rec.ToDisplayName || rec.ToCallerNumber || rec.Called || "";
        tr.innerHTML = `
          <td><button class="expand-btn">&#9654;</button></td>
          <td>${esc(rec.Id)}</td>
          <td>${formatDate(rec.StartTime || rec.CallTime)}</td>
          <td>${formatDuration(duration)}</td>
          <td>${esc(caller)}</td>
          <td>${esc(called)}</td>
          <td>${esc(rec.CallType || "")}</td>
        `;

        tr.addEventListener("click", () => toggleDetail(tr, rec));
        recordingsBody.appendChild(tr);
      });

      prevBtn.disabled = currentPage === 0;
      nextBtn.disabled = recordings.length < pageSize;
      pageInfo.textContent = `Page ${currentPage + 1}`;
    } catch (err) {
      recordingsLoading.hidden = true;
      recordingsBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--red)">Error loading recordings: ${esc(err.message)}</td></tr>`;
    }
  }

  function toggleDetail(tr, rec) {
    const btn = tr.querySelector(".expand-btn");
    const existing = tr.nextElementSibling;

    if (existing && existing.classList.contains("detail-row")) {
      existing.remove();
      btn.classList.remove("open");
      expandedRow = null;
      return;
    }

    // Close any other open detail
    if (expandedRow) {
      const oldBtn = expandedRow.previousElementSibling?.querySelector(".expand-btn");
      if (oldBtn) oldBtn.classList.remove("open");
      expandedRow.remove();
      expandedRow = null;
    }

    btn.classList.add("open");

    const detailTr = document.createElement("tr");
    detailTr.classList.add("detail-row");
    detailTr.innerHTML = `
      <td colspan="7">
        <div class="detail-content">
          <audio controls preload="none" src="/api/recordings/${rec.Id}/audio"></audio>
          <div class="detail-actions">
            <a href="/api/recordings/${rec.Id}/audio" download="recording_${rec.Id}">Download</a>
          </div>
          <div class="transcription-container" id="transcription-${rec.Id}">
            <div class="loading">Loading transcription...</div>
          </div>
          ${rec.Summary ? `<div class="summary"><strong>Summary:</strong> ${esc(rec.Summary)}</div>` : ""}
        </div>
      </td>
    `;

    // Prevent row click from toggling when clicking inside detail
    detailTr.addEventListener("click", (e) => e.stopPropagation());

    tr.after(detailTr);
    expandedRow = detailTr;

    // Fetch detail with segments
    loadRecordingDetail(rec, detailTr);
  }

  async function loadRecordingDetail(rec, detailTr) {
    const container = detailTr.querySelector(`#transcription-${rec.Id}`);
    const audio = detailTr.querySelector("audio");

    try {
      const resp = await fetch(`/api/recordings/${rec.Id}/detail`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const detail = await resp.json();

      if (detail.segments && detail.segments.length > 0) {
        container.innerHTML = renderSegments(detail.segments, detail.from_display_name, detail.to_display_name);

        // Attach timestamp click handlers
        container.querySelectorAll(".segment-time").forEach((el) => {
          el.addEventListener("click", () => {
            const time = parseFloat(el.dataset.time);
            if (audio && !isNaN(time)) {
              audio.currentTime = time;
              audio.play();
            }
          });
        });
      } else if (detail.transcription) {
        container.innerHTML = `<div class="transcription"><strong>Transcription:</strong>\n${esc(detail.transcription)}</div>`;
      } else if (rec.Transcription) {
        container.innerHTML = `<div class="transcription"><strong>Transcription:</strong>\n${esc(rec.Transcription)}</div>`;
      } else {
        container.innerHTML = `<div class="transcription" style="color:var(--text-muted)">No transcription available</div>`;
      }
    } catch {
      // Fallback to 3CX transcription from recordings list
      if (rec.Transcription) {
        container.innerHTML = `<div class="transcription"><strong>Transcription:</strong>\n${esc(rec.Transcription)}</div>`;
      } else {
        container.innerHTML = `<div class="transcription" style="color:var(--text-muted)">No transcription available</div>`;
      }
    }
  }

  function renderSegments(segments, fromName, toName) {
    const speakerSet = [...new Set(segments.map(s => s.speaker).filter(Boolean))];
    const speakerColors = ["caller", "called", "speaker-c", "speaker-d"];

    const html = segments.map((seg) => {
      const mm = Math.floor(seg.start / 60);
      const ss = Math.floor(seg.start % 60);
      const timeStr = `${mm}:${ss.toString().padStart(2, "0")}`;
      const speakerIdx = speakerSet.indexOf(seg.speaker);
      const speakerClass = speakerColors[speakerIdx] || "caller";
      const speakerShort = seg.speaker ? esc(seg.speaker.split(":")[0]) : "";

      return `<div class="segment">
        <span class="segment-time" data-time="${seg.start}" title="Click to seek">${timeStr}</span>
        <span class="segment-speaker ${speakerClass}">${speakerShort}</span>
        <span class="segment-text">${esc(seg.text)}</span>
      </div>`;
    }).join("");

    return `<div class="transcription-segments">${html}</div>`;
  }

  prevBtn.addEventListener("click", () => {
    if (currentPage > 0) { currentPage--; loadRecordings(); }
  });

  nextBtn.addEventListener("click", () => {
    currentPage++;
    loadRecordings();
  });

  pageSizeSelect.addEventListener("change", () => {
    pageSize = parseInt(pageSizeSelect.value);
    currentPage = 0;
    loadRecordings();
  });

  loadRecordings();

  // ── STT ────────────────────────────────────────────────────────────

  const dropZone = document.getElementById("drop-zone");
  const sttFile = document.getElementById("stt-file");
  const sttFileInfo = document.getElementById("stt-file-info");
  const sttFilename = document.getElementById("stt-filename");
  const sttClear = document.getElementById("stt-clear");
  const sttLanguage = document.getElementById("stt-language");
  const sttModel = document.getElementById("stt-model");
  const sttTranslateEl = document.getElementById("stt-translate");
  const sttTransliterateEl = document.getElementById("stt-transliterate");
  const sttTranscribe = document.getElementById("stt-transcribe");
  const sttLoading = document.getElementById("stt-loading");
  const sttResult = document.getElementById("stt-result");
  const sttText = document.getElementById("stt-text");
  const sttCopy = document.getElementById("stt-copy");

  let selectedFile = null;

  dropZone.addEventListener("click", () => sttFile.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) selectSTTFile(e.dataTransfer.files[0]);
  });

  sttFile.addEventListener("change", () => {
    if (sttFile.files.length > 0) selectSTTFile(sttFile.files[0]);
  });

  function selectSTTFile(file) {
    selectedFile = file;
    sttFilename.textContent = file.name;
    sttFileInfo.hidden = false;
    dropZone.hidden = true;
    sttTranscribe.disabled = false;
    sttResult.hidden = true;
  }

  sttClear.addEventListener("click", () => {
    selectedFile = null;
    sttFile.value = "";
    sttFileInfo.hidden = true;
    dropZone.hidden = false;
    sttTranscribe.disabled = true;
    sttResult.hidden = true;
  });

  sttTranscribe.addEventListener("click", async () => {
    if (!selectedFile) return;

    sttTranscribe.disabled = true;
    sttLoading.hidden = false;
    sttResult.hidden = true;

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("model", sttModel.value);
      formData.append("response_format", "json");
      const lang = sttLanguage.value;
      if (lang) formData.append("language", lang);
      if (sttTranslateEl.checked) formData.append("translate", "true");
      if (sttTransliterateEl.checked) formData.append("transliterate", "true");

      const resp = await fetch("/api/stt", { method: "POST", body: formData });
      const data = await resp.json();

      sttText.value = data.text || JSON.stringify(data, null, 2);
      sttResult.hidden = false;
    } catch (err) {
      sttText.value = "Error: " + err.message;
      sttResult.hidden = false;
    } finally {
      sttTranscribe.disabled = false;
      sttLoading.hidden = true;
    }
  });

  sttCopy.addEventListener("click", () => {
    navigator.clipboard.writeText(sttText.value).then(() => {
      sttCopy.textContent = "Copied!";
      setTimeout(() => (sttCopy.textContent = "Copy to Clipboard"), 2000);
    });
  });

  // ── Dynamic STT Model Dropdown ────────────────────────────────────

  async function populateSttModels() {
    try {
      const resp = await fetch("/api/models");
      const data = await resp.json();
      sttModel.innerHTML = "";
      const active = data.active || [];

      for (const m of active) {
        const opt = document.createElement("option");
        opt.value = m.model || m.name;
        const label = m.model || m.name;
        const isEn = label.includes(".en") || label.includes("english");
        opt.textContent = label + (isEn ? " (English)" : " (Multilingual)");
        sttModel.appendChild(opt);
      }

      if (active.length === 0) {
        sttModel.innerHTML = '<option value="large-v3">large-v3 (Multilingual)</option><option value="small.en">small.en (English)</option>';
      }
    } catch {
      sttModel.innerHTML = '<option value="large-v3">large-v3 (Multilingual)</option><option value="small.en">small.en (English)</option>';
    }
  }

  populateSttModels();

  // ── TTS ────────────────────────────────────────────────────────────

  const ttsTextEl = document.getElementById("tts-text");
  const ttsGenerate = document.getElementById("tts-generate");
  const ttsLoading = document.getElementById("tts-loading");
  const ttsResult = document.getElementById("tts-result");
  const ttsAudio = document.getElementById("tts-audio");
  const ttsDownload = document.getElementById("tts-download");
  const ttsVoice = document.getElementById("tts-voice");
  const kokoroVoiceGroup = document.getElementById("kokoro-voice-group");

  // Show/hide kokoro voice dropdown based on engine selection
  document.querySelectorAll('input[name="tts-engine"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      kokoroVoiceGroup.hidden = radio.value !== "kokoro" || !radio.checked;
    });
  });

  const ttsError = document.getElementById("tts-error");

  ttsGenerate.addEventListener("click", async () => {
    const text = ttsTextEl.value.trim();
    if (!text) return;

    const engine = document.querySelector('input[name="tts-engine"]:checked').value;
    const body = { text, engine };
    if (engine === "kokoro" && ttsVoice.value) {
      body.voice = ttsVoice.value;
    }

    ttsGenerate.disabled = true;
    ttsLoading.hidden = false;
    ttsResult.hidden = true;
    ttsError.hidden = true;

    try {
      const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        let msg = `TTS failed (${resp.status})`;
        try {
          const errData = await resp.json();
          if (errData.error) msg = errData.error;
        } catch {
          const errText = await resp.text();
          if (errText) msg = errText;
        }
        throw new Error(msg);
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);

      ttsAudio.src = url;
      ttsDownload.href = url;
      ttsResult.hidden = false;
    } catch (err) {
      ttsError.textContent = err.message;
      ttsError.hidden = false;
    } finally {
      ttsGenerate.disabled = false;
      ttsLoading.hidden = true;
    }
  });

  // Populate Kokoro voices
  async function populateTtsVoices() {
    try {
      const resp = await fetch("/api/tts/voices");
      const voices = await resp.json();
      if (!Array.isArray(voices) || voices.length === 0) return;
      ttsVoice.innerHTML = "";
      // Group by server-provided group label
      const groups = {};
      for (const v of voices) {
        const id = v.id || v;
        const name = v.name || id;
        const groupLabel = v.group || id.substring(0, 2).toUpperCase();
        if (!groups[groupLabel]) groups[groupLabel] = [];
        groups[groupLabel].push({ id, name });
      }
      for (const [label, items] of Object.entries(groups)) {
        const group = document.createElement("optgroup");
        group.label = label;
        for (const v of items) {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = v.name;
          group.appendChild(opt);
        }
        ttsVoice.appendChild(group);
      }
      ttsVoice.value = "af_heart";
    } catch {}
  }

  populateTtsVoices();

  // ── Sync Status ──────────────────────────────────────────────────

  let syncRecPage = 0;
  let syncRecStatus = null;
  const SYNC_REC_LIMIT = 50;

  async function loadSyncStatus() {
    try {
      const resp = await fetch("/api/sync/status");
      const data = await resp.json();
      if (data.statuses) {
        // Reset all to 0
        document.querySelectorAll(".stat-card .stat-value").forEach(el => el.textContent = "0");
        data.statuses.forEach(s => {
          const card = document.querySelector(`.stat-card[data-status="${s.sync_status}"] .stat-value`);
          if (card) card.textContent = s.count;
        });
      }
      if (data.total !== undefined) {
        document.getElementById("sync-total").textContent = data.total;
      }
    } catch {}
  }
  loadSyncStatus();
  setInterval(loadSyncStatus, 30000);

  // ── Sync Countdown Timer ──────────────────────────────────────────

  let syncIntervalMinutes = 15;
  let countdownInterval = null;

  async function initSyncCountdown() {
    try {
      const resp = await fetch("/api/sync/schedule");
      const data = await resp.json();
      if (data.interval_minutes) syncIntervalMinutes = data.interval_minutes;
    } catch {}

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(updateCountdown, 1000);
    updateCountdown();
  }

  function updateCountdown() {
    const now = Date.now();
    const intervalMs = syncIntervalMinutes * 60 * 1000;
    const nextSync = Math.ceil(now / intervalMs) * intervalMs;
    const remaining = Math.max(0, nextSync - now);

    const totalSec = Math.floor(remaining / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;

    const el = document.getElementById("sync-countdown");
    if (el) el.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;

    // When countdown reaches 0, refresh sync status
    if (totalSec === 0) {
      loadSyncStatus();
    }
  }

  initSyncCountdown();

  // ── Clickable Stat Cards ──────────────────────────────────────────

  document.querySelectorAll(".stat-card").forEach(card => {
    card.addEventListener("click", () => {
      const status = card.dataset.status;
      // Toggle: if same card clicked, close panel
      if (syncRecStatus === status) {
        closeSyncRecPanel();
        return;
      }
      // Highlight active card
      document.querySelectorAll(".stat-card").forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      syncRecStatus = status;
      syncRecPage = 0;
      loadSyncRecordings();
    });
  });

  async function loadSyncRecordings() {
    const panel = document.getElementById("sync-recordings-panel");
    const body = document.getElementById("sync-recordings-body");
    const title = document.getElementById("sync-recordings-title");
    const pageInfoEl = document.getElementById("sync-rec-page-info");

    panel.hidden = false;
    title.textContent = `${syncRecStatus.charAt(0).toUpperCase() + syncRecStatus.slice(1)} Recordings`;
    body.innerHTML = '<tr><td colspan="6" class="loading">Loading...</td></tr>';

    try {
      const offset = syncRecPage * SYNC_REC_LIMIT;
      const resp = await fetch(`/api/sync/recordings?status=${encodeURIComponent(syncRecStatus)}&limit=${SYNC_REC_LIMIT}&offset=${offset}`);
      const data = await resp.json();
      const total = data.total || 0;
      const recordings = data.recordings || [];

      if (recordings.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No recordings</td></tr>';
      } else {
        body.innerHTML = recordings.map(r => `<tr>
          <td>${esc(r.id)}</td>
          <td>${formatDate(r.start_time)}</td>
          <td>${esc(r.from_display_name || "")}</td>
          <td>${esc(r.to_display_name || "")}</td>
          <td>${esc(r.call_type || "")}</td>
          <td>
            <button class="btn-action" data-action="retranscribe" data-id="${r.id}">Retranscribe</button>
            <button class="btn-action" data-action="retransliterate" data-id="${r.id}">Retransliterate</button>
          </td>
        </tr>`).join("");

        // Attach action handlers
        body.querySelectorAll(".btn-action").forEach(btn => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            handleRecordingAction(btn.dataset.action, parseInt(btn.dataset.id, 10), btn);
          });
        });
      }

      const totalPages = Math.ceil(total / SYNC_REC_LIMIT);
      pageInfoEl.textContent = `Page ${syncRecPage + 1} of ${totalPages || 1}`;
      document.getElementById("sync-rec-prev").disabled = syncRecPage === 0;
      document.getElementById("sync-rec-next").disabled = (syncRecPage + 1) >= totalPages;
    } catch (err) {
      body.innerHTML = `<tr><td colspan="6" style="color:var(--red)">${esc(err.message)}</td></tr>`;
    }
  }

  function closeSyncRecPanel() {
    document.getElementById("sync-recordings-panel").hidden = true;
    document.querySelectorAll(".stat-card").forEach(c => c.classList.remove("active"));
    syncRecStatus = null;
  }

  document.getElementById("sync-panel-close").addEventListener("click", closeSyncRecPanel);

  document.getElementById("sync-rec-prev").addEventListener("click", () => {
    if (syncRecPage > 0) { syncRecPage--; loadSyncRecordings(); }
  });

  document.getElementById("sync-rec-next").addEventListener("click", () => {
    syncRecPage++;
    loadSyncRecordings();
  });

  // ── Retranscribe / Retransliterate Actions ────────────────────────

  async function handleRecordingAction(action, id, btn) {
    const origText = btn.textContent;
    btn.textContent = "...";
    btn.disabled = true;

    try {
      const resp = await fetch(`/api/recordings/${id}/${action}`, { method: "POST" });
      const data = await resp.json();
      if (data.success) {
        btn.textContent = "Done";
        setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
        loadSyncStatus();
      } else {
        btn.textContent = "Error";
        setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
      }
    } catch {
      btn.textContent = "Error";
      setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
    }
  }

  // Bulk retranscribe
  document.getElementById("sync-bulk-retranscribe").addEventListener("click", async () => {
    if (!syncRecStatus) return;
    const btn = document.getElementById("sync-bulk-retranscribe");
    btn.textContent = "Processing...";
    btn.disabled = true;

    try {
      const resp = await fetch("/api/recordings/bulk-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retranscribe", filter: { status: syncRecStatus } }),
      });
      const data = await resp.json();
      if (data.success) {
        btn.textContent = `Done (${data.count})`;
        loadSyncStatus();
        if (syncRecStatus) loadSyncRecordings();
        setTimeout(() => { btn.textContent = "Retranscribe All"; btn.disabled = false; }, 2000);
      } else {
        btn.textContent = "Error";
        setTimeout(() => { btn.textContent = "Retranscribe All"; btn.disabled = false; }, 2000);
      }
    } catch {
      btn.textContent = "Error";
      setTimeout(() => { btn.textContent = "Retranscribe All"; btn.disabled = false; }, 2000);
    }
  });

  // ── Speakers ─────────────────────────────────────────────────────

  const enrollDropZone = document.getElementById("enroll-drop-zone");
  const enrollFile = document.getElementById("enroll-file");
  const enrollFileInfo = document.getElementById("enroll-file-info");
  const enrollFilename = document.getElementById("enroll-filename");
  const enrollClear = document.getElementById("enroll-clear");
  const enrollSubmit = document.getElementById("enroll-submit");
  const enrollLoading = document.getElementById("enroll-loading");
  const enrollResult = document.getElementById("enroll-result");
  const enrollName = document.getElementById("enroll-name");

  let enrollSelectedFile = null;

  if (enrollDropZone) {
    enrollDropZone.addEventListener("click", () => enrollFile.click());
    enrollDropZone.addEventListener("dragover", (e) => { e.preventDefault(); enrollDropZone.classList.add("dragover"); });
    enrollDropZone.addEventListener("dragleave", () => enrollDropZone.classList.remove("dragover"));
    enrollDropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      enrollDropZone.classList.remove("dragover");
      if (e.dataTransfer.files.length > 0) selectEnrollFile(e.dataTransfer.files[0]);
    });
    enrollFile.addEventListener("change", () => {
      if (enrollFile.files.length > 0) selectEnrollFile(enrollFile.files[0]);
    });
  }

  function selectEnrollFile(file) {
    enrollSelectedFile = file;
    enrollFilename.textContent = file.name;
    enrollFileInfo.hidden = false;
    enrollDropZone.hidden = true;
    updateEnrollButton();
  }

  if (enrollClear) {
    enrollClear.addEventListener("click", () => {
      enrollSelectedFile = null;
      enrollFile.value = "";
      enrollFileInfo.hidden = true;
      enrollDropZone.hidden = false;
      updateEnrollButton();
      enrollResult.hidden = true;
    });
  }

  function updateEnrollButton() {
    if (enrollSubmit) enrollSubmit.disabled = !enrollSelectedFile || !enrollName.value.trim();
  }

  if (enrollName) enrollName.addEventListener("input", updateEnrollButton);

  if (enrollSubmit) {
    enrollSubmit.addEventListener("click", async () => {
      if (!enrollSelectedFile || !enrollName.value.trim()) return;

      enrollSubmit.disabled = true;
      enrollLoading.hidden = false;
      enrollResult.hidden = true;

      try {
        const formData = new FormData();
        formData.append("file", enrollSelectedFile);
        formData.append("name", enrollName.value.trim());
        const desc = document.getElementById("enroll-desc").value.trim();
        if (desc) formData.append("description", desc);

        const resp = await fetch("/api/speakers/enroll", { method: "POST", body: formData });
        const data = await resp.json();

        if (data.error) throw new Error(data.error);

        enrollResult.innerHTML = `<div style="color:var(--green)">Enrolled "${esc(data.name)}" (${data.num_samples} sample${data.num_samples > 1 ? "s" : ""})</div>`;
        enrollResult.hidden = false;

        // Reset form
        enrollSelectedFile = null;
        enrollFile.value = "";
        enrollFileInfo.hidden = true;
        enrollDropZone.hidden = false;
        enrollName.value = "";
        document.getElementById("enroll-desc").value = "";

        loadSpeakers();
      } catch (err) {
        enrollResult.innerHTML = `<div style="color:var(--red)">Error: ${esc(err.message)}</div>`;
        enrollResult.hidden = false;
      } finally {
        enrollSubmit.disabled = true;
        enrollLoading.hidden = true;
      }
    });
  }

  async function loadSpeakers() {
    const list = document.getElementById("speakers-list");
    if (!list) return;

    try {
      const resp = await fetch("/api/speakers");
      const data = await resp.json();
      const speakers = data.speakers || [];

      if (speakers.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);padding:16px">No speakers enrolled yet. Upload a voice sample above to get started.</div>';
        return;
      }

      list.innerHTML = speakers.map(s => `
        <div class="speaker-card">
          <div class="speaker-info">
            <span class="speaker-name">${esc(s.name)}</span>
            ${s.description ? `<span class="speaker-desc">${esc(s.description)}</span>` : ""}
            <span class="speaker-meta">${s.num_samples} sample${s.num_samples > 1 ? "s" : ""}</span>
          </div>
          <button class="btn-action speaker-delete" data-id="${esc(s.speaker_id)}" data-name="${esc(s.name)}">Delete</button>
        </div>
      `).join("");

      list.querySelectorAll(".speaker-delete").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Delete voice profile for "${btn.dataset.name}"?`)) return;
          btn.textContent = "...";
          btn.disabled = true;
          try {
            await fetch(`/api/speakers/${btn.dataset.id}`, { method: "DELETE" });
            loadSpeakers();
          } catch {
            btn.textContent = "Error";
            setTimeout(() => { btn.textContent = "Delete"; btn.disabled = false; }, 2000);
          }
        });
      });
    } catch {
      list.innerHTML = '<div style="color:var(--text-muted)">Diarization service unavailable</div>';
    }
  }

  // ── Models ──────────────────────────────────────────────────────

  async function loadModels() {
    try {
      const resp = await fetch("/api/models");
      const data = await resp.json();

      // Active models
      const activeList = document.getElementById("active-models-list");
      if (data.active && data.active.length > 0) {
        activeList.innerHTML = data.active.map(m =>
          `<div class="active-model"><span class="model-name">${esc(m.model)}</span><span class="model-backend">${esc(m.backend)}</span></div>`
        ).join("");
      } else {
        // Try /api/models/current fallback
        try {
          const currentResp = await fetch("/api/models/current");
          const current = await currentResp.json();
          if (current.model) {
            activeList.innerHTML = `<div class="active-model"><span class="model-name">${esc(current.model)}</span><span class="model-status ${current.status === "healthy" ? "healthy" : ""}">${esc(current.status)}</span></div>`;
          }
        } catch {
          activeList.innerHTML = '<span style="color:var(--text-muted)">Unable to fetch active models</span>';
        }
      }

      // Model grid
      const grid = document.getElementById("models-grid");
      if (data.models) {
        grid.innerHTML = data.models.map(m => {
          const isActive = data.active?.some(a => a.model === m.id);
          return `<div class="model-card ${isActive ? "active" : ""}">
            <div class="model-card-header">
              <span class="model-id">${esc(m.name)}</span>
              ${m.englishOnly ? '<span class="model-badge en">EN</span>' : '<span class="model-badge multi">Multi</span>'}
              ${isActive ? '<span class="model-badge current">Active</span>' : ''}
            </div>
            <div class="model-meta">
              <span>${esc(m.size)}</span> · <span>${esc(m.parameters)} params</span>
            </div>
            <div class="model-desc">${esc(m.description)}</div>
          </div>`;
        }).join("");
      }
    } catch (err) {
      document.getElementById("models-grid").innerHTML = '<span style="color:var(--red)">Error loading models</span>';
    }
  }
  loadModels();

  // ── Helpers ────────────────────────────────────────────────────────

  function esc(val) {
    if (val == null) return "";
    const div = document.createElement("div");
    div.textContent = String(val);
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return dateStr;
    }
  }

  function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return "";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
})();
